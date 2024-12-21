/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../utils/dispose';
import * as vscode from 'vscode';
import { CustomExternalBrowser, Settings, SettingUtil } from '../utils/settingsUtil';
import {
	DONT_SHOW_AGAIN,
	INIT_PANEL_TITLE,
	OUTPUT_CHANNEL_NAME,
} from '../utils/constants';
import TelemetryReporter from 'vscode-extension-telemetry';
import { ConnectionManager } from '../connectionInfo/connectionManager';
import { PathUtil } from '../utils/pathUtil';
import { BrowserPreview } from './browserPreview';
import { Connection } from '../connectionInfo/connection';
import { EndpointManager } from '../infoManagers/endpointManager';
import { IOpenFileOptions } from '../manager';
import { ExternalBrowserUtils } from '../utils/externalBrowserUtils';

/**
 * PreviewManager` is a singleton that handles the logic of opening the embedded preview.
 */
export class PreviewManager extends Disposable {
	private readonly _outputChannel: vscode.OutputChannel;
	public previewActive = false;
	public currentPanel: BrowserPreview | undefined;
	private _notifiedAboutLooseFiles = false;
	private _currentTimeout: NodeJS.Timeout | undefined;

	private readonly _onShouldLaunchPreview = this._register(
		new vscode.EventEmitter<{
			uri?: vscode.Uri;
			options?: IOpenFileOptions;
			previewType?: string;
		}>()
	);
	public readonly onShouldLaunchPreview = this._onShouldLaunchPreview.event;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _reporter: TelemetryReporter,
		private readonly _connectionManager: ConnectionManager,
		private readonly _endpointManager: EndpointManager,
		private readonly _serverExpired: () => void
	) {
		super();
		this._outputChannel =
			vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
	}

	/**
	 * Actually launch the embedded browser preview (caller guarantees that the server has started.)
	 * @param {vscode.Uri} file the filesystem path to preview.
	 * @param {vscode.WebviewPanel | undefined} panel the webview panel to reuse if defined.
	 * @param {Connection} connection the connection to connect using
	 */
	public async launchFileInEmbeddedPreview(
		panel: vscode.WebviewPanel | undefined,
		connection: Connection,
		file?: vscode.Uri
	): Promise<void> {
		const path = file ? await this._fileUriToPath(file, connection) : '/';
		// If we already have a panel, show it.
		if (this.currentPanel) {
			await this.currentPanel.reveal(
				vscode.ViewColumn.Beside,
				path,
				connection
			);
			return;
		}

		if (!panel) {
			// Otherwise, create a new panel.
			panel = vscode.window.createWebviewPanel(
				BrowserPreview.viewType,
				INIT_PANEL_TITLE,
				vscode.ViewColumn.Beside,
				{
					...this.getWebviewOptions(),
					...this._getWebviewPanelOptions(),
				}
			);
		}

		this._startEmbeddedPreview(panel, path, connection);
	}

	/**
	 * Actually launch the external browser preview (caller guarantees that the server has started.)
	 * @param {vscode.Uri} file the filesystem path to preview.
	 * @param {boolean} debug whether we are opening in a debug session.
	 * @param {Connection} connection the connection to connect using
	 */
	public async launchFileInExternalBrowser(
		debug: boolean,
		connection: Connection,
		file?: vscode.Uri
	): Promise<void> {
		const path = file
			? PathUtil.ConvertToPosixPath(await this._fileUriToPath(file, connection))
			: '/';

		const url = `http://${connection.host}:${connection.httpPort}${path}`;
		if (debug) {
			vscode.commands.executeCommand('extension.js-debug.debugLink', url);
		} else {
			// will already resolve to local address
			await ExternalBrowserUtils.openInBrowser(url, SettingUtil.GetConfig().customExternalBrowser);
		}
	}

	/**
	 * @returns {WebviewOptions} the webview options to allow us to load the files we need in the webivew.
	 */
	public getWebviewOptions(): vscode.WebviewOptions {
		const options = {
			// Enable javascript in the webview
			enableScripts: true,

			localResourceRoots: [
				vscode.Uri.joinPath(this._extensionUri, 'media'),
				vscode.Uri.joinPath(
					this._extensionUri,
					'node_modules',
					'@vscode',
					'codicons',
					'dist'
				),
			],
		};
		return options;
	}

	/**
	 * @description notify the user that they are opening a file outside the current workspace(s).
	 */
	private _notifyLooseFileOpen(): void {
		/* __GDPR__
			"preview.fileOutOfWorkspace" : {}
		*/
		this._reporter.sendTelemetryEvent('preview.fileOutOfWorkspace');
		if (
			!this._notifiedAboutLooseFiles &&
			SettingUtil.GetConfig().notifyOnOpenLooseFile
		) {
			vscode.window
				.showWarningMessage(
					vscode.l10n.t('Previewing a file that is not a child of the server root. To see fully correct relative file links, please open a workspace at the project root or consider changing your server root settings for Live Preview.'),
					DONT_SHOW_AGAIN
				)
				.then(async (selection: vscode.MessageItem | undefined) => {
					if (selection == DONT_SHOW_AGAIN) {
						await SettingUtil.UpdateSettings(Settings.notifyOnOpenLooseFile, false, vscode.ConfigurationTarget.Global);
					}
				});
		}
		this._notifiedAboutLooseFiles = true;
	}

	/**
	 * Transforms Uris into a path that can be used by the server.
	 * @param {vscode.Uri} file the path to potentially transform.
	 * @param {Connection} connection the connection to connect using
	 * @returns {string} the transformed path if the original `file` was realtive.
	 */
	private async _fileUriToPath(file: vscode.Uri, connection: Connection): Promise<string> {
		let path = '/';
		if (!connection?.workspace) {
			this._notifyLooseFileOpen();
			path = await this._endpointManager.encodeLooseFileEndpoint(file);

			if (!path.startsWith('/')) {
				path = `/${path}`;
			}
		} else if (connection) {
			path = connection.getFileRelativeToWorkspace(file.fsPath) ?? '';
		}
		return path;
	}

	/**
	 * Handles opening the embedded preview and setting up its listeners.
	 * After a browser preview is closed, the server will close if another browser preview has not opened after a period of time (configurable in settings)
	 * or if a task is not runnning. Because of this, a timer is triggerred upon webview (embedded preview) disposal/closing.
	 * @param {vscode.WebviewPanel} panel the panel to use to open the preview.
	 * @param {vscode.Uri} file the path to preview (should already be encoded).
	 * @param {Connection} connection the connection to connect using
	 */
	private _startEmbeddedPreview(
		panel: vscode.WebviewPanel,
		file: string,
		connection: Connection
	): void {
		if (this._currentTimeout) {
			clearTimeout(this._currentTimeout);
		}

		this.currentPanel = this._register(
			new BrowserPreview(
				file,
				connection,
				panel,
				this._extensionUri,
				this._reporter,
				this._connectionManager,
				this._outputChannel
			)
		);

		const listener = this.currentPanel.onShouldLaunchPreview((e) =>
			this._onShouldLaunchPreview.fire(e)
		);

		this.previewActive = true;

		this._register(
			this.currentPanel.onDispose(() => {
				this.currentPanel = undefined;
				const closeServerDelay =
					SettingUtil.GetConfig().serverKeepAliveAfterEmbeddedPreviewClose;
				if (closeServerDelay !== 0) {
					this._currentTimeout = setTimeout(() => {
						this._serverExpired();

						this.previewActive = false;
					}, Math.floor(closeServerDelay * 1000 * 60));
				}
				listener.dispose();
			})
		);
	}
	/**
	 * @returns {vscode.WebviewPanelOptions} the webview panel options to allow it to always retain context.
	 */
	private _getWebviewPanelOptions(): vscode.WebviewPanelOptions {
		return {
			retainContextWhenHidden: true,
		};
	}
}
