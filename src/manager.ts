/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from './utils/dispose';
import * as vscode from 'vscode';
import { PathUtil } from './utils/pathUtil';
import TelemetryReporter from 'vscode-extension-telemetry';
import { ConnectionManager } from './connectionInfo/connectionManager';
import { BrowserPreview } from './editorPreview/browserPreview';
import { PreviewType, SettingUtil } from './utils/settingsUtil';
import { ServerStartedStatus, ServerTaskProvider } from './task/serverTaskProvider';
import { EndpointManager } from './infoManagers/endpointManager';
import { PreviewManager } from './editorPreview/previewManager';
import { StatusBarNotifier } from './server/serverUtils/statusBarNotifier';
import { LIVE_PREVIEW_SERVER_ON } from './utils/constants';
import { ServerGrouping } from './server/serverGrouping';
import { UpdateListener } from './updateListener';
import { URL } from 'url';

export interface IOpenFileOptions {
	workspace?: vscode.WorkspaceFolder;
	port?: number;
	manager?: ServerGrouping;
}

export interface IServerQuickPickItem extends vscode.QuickPickItem {
	accept(): void;
}

/**
 * This object re-serializes the webview after a reload
 */
class PanelSerializer
	extends Disposable
	implements vscode.WebviewPanelSerializer {
	private readonly _onShouldRevive = this._register(
		new vscode.EventEmitter<{ webviewPanel: vscode.WebviewPanel; state: any }>()
	);

	public readonly onShouldRevive = this._onShouldRevive.event;

	deserializeWebviewPanel(
		webviewPanel: vscode.WebviewPanel,
		state: any
	): Thenable<void> {
		// fire event to parent, since all info needed to re-open a panel is in the parent
		this._onShouldRevive.fire({ webviewPanel, state });
		return Promise.resolve();
	}
}

/**
 * `Manager` is a singleton instance that managers all of the servers, the previews, connection info, etc.
 * It also facilitates opening files (sometimes by calling `PreviewManager`) and starting the associated servers.
 */
export class Manager extends Disposable {
	private _serverGroupings: Map<string | undefined, ServerGrouping>;
	private _connectionManager: ConnectionManager;
	private readonly _endpointManager: EndpointManager;
	private readonly _previewManager: PreviewManager;
	private readonly _statusBar: StatusBarNotifier;
	private readonly _serverTaskProvider: ServerTaskProvider;
	private readonly _updateListener: UpdateListener;
	private readonly _pendingServerWorkspaces: Set<string | undefined>;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly _reporter: TelemetryReporter,
		_userDataDir: string | undefined
	) {
		super();
		this._serverGroupings = new Map<string | undefined, ServerGrouping>();
		this._pendingServerWorkspaces = new Set<string | undefined>();
		this._connectionManager = this._register(new ConnectionManager());

		this._register(
			this._connectionManager.onConnected((e) => {
				this._statusBar.setServer(e.workspace?.uri, e.httpPort);
				vscode.commands.executeCommand(
					'setContext',
					LIVE_PREVIEW_SERVER_ON,
					true
				);
			})
		);

		this._endpointManager = this._register(new EndpointManager());

		this._previewManager = this._register(
			new PreviewManager(
				this._extensionUri,
				this._reporter,
				this._connectionManager,
				this._endpointManager,
				() => {
					if (
						this._hasServerRunning() &&
						!this._serverTaskProvider.isRunning &&
						vscode.workspace.workspaceFolders &&
						vscode.workspace.workspaceFolders?.length > 0 &&
						this._serverTaskProvider.runTaskWithExternalPreview
					) {
						this.closeAllServers();
					}
				}
			)
		);

		this._statusBar = this._register(new StatusBarNotifier());

		this._serverTaskProvider = this._register(
			new ServerTaskProvider(
				this._reporter,
				this._endpointManager,
				this._connectionManager
			)
		);

		this._register(
			vscode.tasks.registerTaskProvider(
				ServerTaskProvider.CustomBuildScriptType,
				this._serverTaskProvider
			)
		);

		this._register(
			this._serverTaskProvider.onRequestOpenEditorToSide((uri) => {
				if (
					this._previewManager.previewActive &&
					this._previewManager.currentPanel
				) {
					const avoidColumn =
						this._previewManager.currentPanel.panel.viewColumn ??
						vscode.ViewColumn.One;
					const column: vscode.ViewColumn =
						avoidColumn == vscode.ViewColumn.One
							? avoidColumn + 1
							: avoidColumn - 1;
					vscode.commands.executeCommand('vscode.open', uri, {
						viewColumn: column,
					});
				} else {
					vscode.commands.executeCommand('vscode.open', uri);
				}
			})
		);

		this._register(
			this._serverTaskProvider.onRequestToOpenServer(async (workspace) => {
				const serverGrouping = await this._getServerGroupingFromWorkspace(workspace);
				if (!serverGrouping.isRunning) {
					await serverGrouping.openServer();
				} else {
					const uri = await serverGrouping.connection.resolveExternalHTTPUri();
					this._serverTaskProvider.serverStarted(
						uri,
						ServerStartedStatus.STARTED_BY_EMBEDDED_PREV,
						serverGrouping.connection.workspace
					);
				}
			})
		);

		this._register(
			this._serverTaskProvider.onRequestToCloseServer((workspace) => {
				if (this._previewManager.previewActive) {
					this._serverTaskProvider.serverStop(false, workspace);
				} else {
					const serverGrouping = this._serverGroupings.get(
						workspace?.uri.toString()
					);
					// closeServer will call `this._serverTaskProvider.serverStop(true, workspace);`
					serverGrouping?.dispose();
				}
			})
		);

		const serializer = this._register(new PanelSerializer());

		this._register(
			serializer.onShouldRevive(async (e) => {
				let relative = false;
				let file: string = e.state.currentAddress ?? '/';

				let workspace = await PathUtil.GetWorkspaceFromRelativePath(file);
				if (workspace) {
					relative = true;
				} else {
					// path isn't relative to workspaces, try checking absolute path for workspace
					workspace = await PathUtil.GetWorkspaceFromAbsolutePath(file);
				}

				if (!workspace) {
					// no workspace; try to decode endpoint to fix file
					const potentialFile =
						await this._endpointManager.decodeLooseFileEndpoint(file);
					if (potentialFile) {
						file = potentialFile;
					} else {
						e.webviewPanel.dispose();
						return;
					}
				}

				let fileUri;
				// loose file workspace will be fetched if workspace is still undefined
				const grouping = await this._getServerGroupingFromWorkspace(workspace);
				if (workspace) {
					// PathExistsRelativeToAnyWorkspace already makes sure that file is under correct root prefix
					fileUri = vscode.Uri.joinPath(workspace.uri, await PathUtil.GetValidServerRootForWorkspace(workspace), file);
				} else {
					fileUri = vscode.Uri.parse(file);
				}
				grouping.createOrShowEmbeddedPreview(e.webviewPanel, fileUri, relative);
				e.webviewPanel.webview.options =
					this._previewManager.getWebviewOptions();
			})
		);

		if (vscode.window.registerWebviewPanelSerializer) {
			this._register(
				vscode.window.registerWebviewPanelSerializer(
					BrowserPreview.viewType,
					serializer
				)
			);
		}

		this._register(
			vscode.workspace.onDidChangeWorkspaceFolders((e) => {
				if (e.removed) {
					e.removed.forEach((workspace) => {
						const potentialGrouping = this._serverGroupings.get(
							workspace.uri.toString()
						);
						if (potentialGrouping) {
							potentialGrouping.dispose();
						}
					});
				}
				// known bug: transitioning between 1 and 2 workspaces: https://github.com/microsoft/vscode/issues/128138
			})
		);

		this._register(
			this._serverTaskProvider.onShouldLaunchPreview((e) => {
				if (e.uri && e.uri.scheme !== 'file') {
					this._openPreviewAtLink(e.uri, e.previewType);
				} else {
					this.openPreviewAtFileUri(e.uri, e.options, e.previewType);
				}
			})
		);

		this._register(
			this._previewManager.onShouldLaunchPreview((e) => {
				if (e.uri && e.uri.scheme !== 'file') {
					this._openPreviewAtLink(e.uri, e.previewType);
				} else {
					this.openPreviewAtFileUri(e.uri, e.options, e.previewType);
				}
			})
		);

		this._updateListener = this._register(new UpdateListener(_userDataDir));
		this._register(
			this._updateListener.shouldRefreshPreviews(() => this._refreshBrowsers())
		);
	}

	public async forceCloseServers(): Promise<void> {
		if (this._serverGroupings.size > 1) {
			this._showCloseServerPicker();
		} else {
			this.closeAllServers();
		}
	}

	/**
	 * Close all servers
	 */
	public closeAllServers(): void {
		this._serverGroupings.forEach((serverGrouping) => {
			serverGrouping.dispose();
		});
	}

	public dispose(): void {
		this.closeAllServers();
		super.dispose();
	}

	public closePanel(): void {
		this._previewManager.currentPanel?.close();
	}

	/**
	 * Gets called when someone calls `LivePreview.start`. Will simply use the default initial file that you've set.
	 */
	public async openPreview(): Promise<void> {
		const activeFile = vscode.window.activeTextEditor?.document.uri;
		const activeWorkspace = activeFile ? vscode.workspace.getWorkspaceFolder(activeFile) : vscode.workspace.workspaceFolders?.[0];

		// use the active workspace folder. otherwise, use the first workspace folder.
		let defaultPreviewPath = SettingUtil.GetConfig(activeWorkspace).defaultPreviewPath;

		// if this gave no results, still try to use the the preview path from other settings, but appended to the active workspace
		// otherwise, still use the active workspace, but with no default path.
		if (defaultPreviewPath === '') {
			defaultPreviewPath = SettingUtil.GetConfig().defaultPreviewPath;
		}

		// defaultPreviewPath is relative to the workspace root, regardless of what is set for serverRoot
		return this.openPreviewAtFileString(defaultPreviewPath, undefined, activeWorkspace, true);
	}

	/**
	 * Using only a string path (unknown if relative or absolute), launch the preview or launch an error.
	 * This is usually used for when the user configures a setting for initial filepath
	 * @param filePath the string fsPath to use
	 */
	public async openPreviewAtFileString(filePath: string, previewType?: string, activeWorkspace?: vscode.WorkspaceFolder, ignoreFileRoot = false): Promise<void> {
		if (filePath === '' && !activeWorkspace) {
			return this._openPreviewWithNoTarget();
		}

		const workspace = activeWorkspace ? activeWorkspace : await PathUtil.GetWorkspaceFromRelativePath(filePath, ignoreFileRoot);
		if (workspace) {
			const file = vscode.Uri.joinPath(workspace.uri, ignoreFileRoot ? '' : await PathUtil.GetValidServerRootForWorkspace(workspace), filePath);
			await this.openPreviewAtFileUri(file, {
				workspace: workspace,
			}, previewType);
			return;
		}

		// no workspace, try to open as a loose file
		if ((await PathUtil.FileExistsStat(filePath)).exists) {
			const file = vscode.Uri.file(filePath);
			return this.openPreviewAtFileUri(file, undefined, previewType);
		} else {
			vscode.window.showWarningMessage(vscode.l10n.t("The file '{0}' does not exist relative your filesystem root.", filePath));
			return this._openPreviewWithNoTarget();
		}
	}

	public async openPreviewAtFileUri(
		file?: vscode.Uri,
		options?: IOpenFileOptions,
		previewType?: string
	): Promise<void> {
		let fileUri: vscode.Uri;
		if (!file) {
			if (this._previewManager.currentPanel?.panel.active) {
				if (this._previewManager.currentPanel.currentConnection.rootURI) {
					fileUri = vscode.Uri.joinPath(
						this._previewManager.currentPanel.currentConnection.rootURI,
						this._previewManager.currentPanel.currentAddress
					);
				} else {
					fileUri = vscode.Uri.parse(
						this._previewManager.currentPanel.currentAddress
					);
				}
			} else {
				const activeFile = vscode.window.activeTextEditor?.document.uri;
				if (activeFile) {
					fileUri = activeFile;
				} else {
					return this._openPreviewWithNoTarget();
				}
			}
		} else {
			fileUri = file;
		}
		if (!previewType) {
			previewType = SettingUtil.GetPreviewType();
		}

		const internal = previewType === PreviewType.internalPreview;
		const debug = previewType === PreviewType.externalDebugPreview;

		return await this._handleOpenFile(
			internal,
			debug,
			fileUri,
			options?.workspace,
			options?.port,
			options?.manager
		);
	}

	/**
 * Runs task for workspace from within extension. Must have at least one workspace open.
 * @param file optional file to use to find the workspace to run the task out of.
 * @returns
 */
	public async runTaskForFile(file?: vscode.Uri): Promise<void> {
		if (!file) {
			file = vscode.window.activeTextEditor?.document.uri;
		}

		let workspace;
		if (file) {
			workspace = await PathUtil.GetWorkspaceFromURI(file);
		} else if (
			vscode.workspace.workspaceFolders &&
			vscode.workspace.workspaceFolders?.length > 0
		) {
			if (this._serverGroupings.size > 0) {
				const matchGrouping = Array.from(this._serverGroupings.values()).find(
					(grouping) => grouping.workspace && grouping.isRunning
				);
				workspace =
					matchGrouping?.workspace ?? vscode.workspace.workspaceFolders[0];
			} else {
				workspace = vscode.workspace.workspaceFolders[0];
			}
		}

		if (!workspace) {
			return; // fails preconditions of being in a workspace
		}

		return await this._serverTaskProvider.extRunTask(workspace);
	}

	/**
	 * Show the picker to select a server to close
	 */
	private async _showCloseServerPicker(): Promise<void> {
		const disposables: vscode.Disposable[] = [];

		const quickPick = vscode.window.createQuickPick<IServerQuickPickItem>();
		disposables.push(quickPick);

		quickPick.matchOnDescription = true;
		quickPick.placeholder = vscode.l10n.t('Select the port that corresponds to the server that you want to stop');
		quickPick.items = await this._getServerPicks();

		disposables.push(
			quickPick.onDidAccept(() => {
				const selectedItem = quickPick.selectedItems[0];
				selectedItem.accept();
				quickPick.hide();
				disposables.forEach((d) => d.dispose());
			})
		);

		quickPick.show();
	}

	/**
 * Opens a preview at an internal link that has the format <scheme>://<host>:<port>/<path>
 * @param link
 * @param previewType
 */
	private async _openPreviewAtLink(
		link: vscode.Uri,
		previewType?: string
	): Promise<void> {
		const debug = previewType === PreviewType.externalDebugPreview;
		const internal = this._isInternalPreview(previewType);
		try {
			if (link.scheme !== 'https' && link.scheme !== 'http') {
				console.error(`${link.scheme} does not correspond to a link URI`);
				throw Error;
			}
			const pathStr = `${link.scheme}://${link.authority}`;
			const url = new URL(pathStr);
			const port = parseInt(url.port);
			const connection = this._connectionManager.getConnectionFromPort(port);
			if (!connection) {
				// don't have any workspace info, just treat it as relative path
				return this.openPreviewAtFileString(link.path, previewType);
			}

			const serverGrouping = await this._getServerGroupingFromWorkspace(
				connection.workspace
			);

			if (!connection.rootURI) {
				// using server grouping with undefined workspace
				return this._openPreview(
					internal,
					serverGrouping,
					vscode.Uri.file(this._endpointManager.changePrefixesForAbsPathDecode(link.path)),
					debug
				);
			}

			const file = connection.getAppendedURI(link.path);
			this._openPreview(internal, serverGrouping, file, debug);
		} catch (e) {
			vscode.window.showErrorMessage(vscode.l10n.t('badURL', 'Tried to open preview on invalid URI'));
		}
	}

	/**
	 * handles opening a file
	 * @param internal whether to launch an embedded preview
	 * @param file the uri or string filePath to use
	 * @param fileStringRelative whether the path is relative
	 * @param debug whether to launch in debug
	 * @param workspace the workspace to launch the file from
	 * @param port the port to derive the workspace from
	 * @param serverGrouping the serverGrouping that manages the server workspace
	 */
	private async _handleOpenFile(
		internal: boolean,
		debug: boolean,
		file: vscode.Uri,
		workspace?: vscode.WorkspaceFolder,
		port?: number,
		serverGrouping?: ServerGrouping
	): Promise<void> {
		if (file.scheme !== 'file') {
			// Is this an error?
			console.error('Tried to open a non-file URI with file opener');
		}
		if (!serverGrouping) {
			if (workspace) {
				serverGrouping = await this._getServerGroupingFromWorkspace(await this._shouldUseWorkspaceForFile(workspace, file) ? workspace : undefined);
			} else if (port) {
				this._serverGroupings.forEach((potentialServerGrouping) => {
					if (potentialServerGrouping.port === port) {
						serverGrouping = potentialServerGrouping;
						return;
					}
				});
			} else {
				workspace = await PathUtil.GetWorkspaceFromURI(file);
				serverGrouping = await this._getServerGroupingFromWorkspace(workspace);
			}
		}

		if (!serverGrouping) {
			// last-resort: use loose workspace server.
			serverGrouping = await this._getServerGroupingFromWorkspace(undefined);
		}

		return this._openPreview(internal, serverGrouping, file, debug);
	}

	private _refreshBrowsers(): void {
		Array.from(this._serverGroupings.values()).forEach((grouping) => {
			grouping.refresh();
		});
	}

	private async _shouldUseWorkspaceForFile(workspace: vscode.WorkspaceFolder | undefined, file: vscode.Uri): Promise<boolean> {

		if (!workspace) {
			// never use the root prefix path on non-workspace paths
			return false;
		}

		const serverRootPrefix = await PathUtil.GetValidServerRootForWorkspace(workspace);
		if (serverRootPrefix === '') {
			return true;
		}

		if (file) {
			const workspaceURIWithServerRoot = vscode.Uri.joinPath(workspace.uri, serverRootPrefix);

			if (workspaceURIWithServerRoot) {
				if (file.fsPath.startsWith(workspaceURIWithServerRoot.fsPath)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Creates a serverGrouping and connection object for a workspace if it doesn't already have an existing one.
	 * Otherwise, return the existing serverGrouping.
	 * @param workspace
	 * @returns serverGrouping for this workspace (or, when `workspace == undefined`, the serverGrouping for the loose file workspace)
	 */
	private async _getServerGroupingFromWorkspace(
		workspace: vscode.WorkspaceFolder | undefined
	): Promise<ServerGrouping> {
		let serverGrouping = this._serverGroupings.get(workspace?.uri.toString());
		if (!serverGrouping) {
			const connection =
				await this._connectionManager.createAndAddNewConnection(workspace);

			this._register(
				connection.onConnected(() => {
					this._pendingServerWorkspaces.delete(workspace?.uri.toString());
				})
			);
			serverGrouping = this._register(
				new ServerGrouping(
					this._extensionUri,
					this._reporter,
					this._endpointManager,
					connection,
					this._serverTaskProvider,
					this._pendingServerWorkspaces
				)
			);

			this._register(
				serverGrouping.onClose(() => {
					if (
						this._previewManager.currentPanel &&
						this._previewManager.currentPanel.currentConnection === connection
					) {
						// close the preview if it is showing this server's content
						this._previewManager.currentPanel?.close();
					}

					this._statusBar.removeServer(workspace?.uri);
					this._serverGroupings.delete(workspace?.uri.toString());
					if (this._serverGroupings.size === 0) {
						this._statusBar.serverOff();
						vscode.commands.executeCommand(
							'setContext',
							LIVE_PREVIEW_SERVER_ON,
							false
						);
					}
					this._connectionManager.removeConnection(workspace);
				})
			);
			this._register(
				serverGrouping.onShouldLaunchEmbeddedPreview((e) =>
					this._previewManager.launchFileInEmbeddedPreview(
						e.panel,
						e.connection,
						e.uri
					)
				)
			);
			this._register(
				serverGrouping.onShouldLaunchExternalPreview((e) =>
					this._previewManager.launchFileInExternalBrowser(
						e.debug,
						e.connection,
						e.uri
					)
				)
			);
			this._serverGroupings.set(workspace?.uri.toString(), serverGrouping);
		}

		return serverGrouping;
	}

	private async _openPreview(
		internal: boolean,
		serverGrouping: ServerGrouping,
		file?: vscode.Uri,
		debug = false
	): Promise<void> {
		if (internal) {
			// for now, ignore debug or no debug for embedded preview
			await serverGrouping.createOrShowEmbeddedPreview(undefined, file);
		} else {
			await serverGrouping.showPreviewInExternalBrowser(debug, file);
		}
	}

	private _hasServerRunning(): boolean {
		const isRunning = Array.from(this._serverGroupings.values()).filter(
			(group) => group.isRunning
		);
		return isRunning.length !== 0;
	}

	private _isInternalPreview(previewType?: string): boolean {
		if (!previewType) {
			previewType = SettingUtil.GetPreviewType();
		}
		return previewType === PreviewType.internalPreview;
	}

	private async _openPreviewWithNoTarget(): Promise<void> {
		// Opens index at first open server or opens a loose workspace at root.
		// This function is called with the assumption that there might be an open server already
		// and we should check.

		const internal = this._isInternalPreview();
		const workspaces = vscode.workspace.workspaceFolders;
		if (workspaces && workspaces.length > 0) {
			for (let i = 0; i < workspaces.length; i++) {
				const currWorkspace = workspaces[i];
				const manager = this._serverGroupings.get(currWorkspace.uri.toString());
				if (manager) {
					this.openPreviewAtFileUri(undefined, {
						workspace: currWorkspace,
						manager: manager,
					});
					return;
				}
			}

			const grouping = await this._getServerGroupingFromWorkspace(workspaces[0]);
			this._openPreview(internal, grouping, undefined);
		} else {
			const grouping = await this._getServerGroupingFromWorkspace(undefined);
			this._openPreview(internal, grouping, undefined);
		}
	}

	private async _getServerPicks(): Promise<IServerQuickPickItem[]> {
		const serverPicks: Array<IServerQuickPickItem> = [];

		const picks = await Promise.all(
			Array.from(this._serverGroupings.values()).map((grouping) =>
				this._getServerPickFromGrouping(grouping)
			)
		);

		picks.forEach((pick) => {
			if (pick) {
				serverPicks.push(pick);
			}
		});

		if (picks.length > 0) {
			serverPicks.push({
				label: vscode.l10n.t('All Servers'),
				accept: (): void => this.closeAllServers(),
			});
		}

		return serverPicks;
	}

	private _getServerPickFromGrouping(
		grouping: ServerGrouping
	): IServerQuickPickItem | undefined {
		const connection = this._connectionManager.getConnection(
			grouping.workspace
		);
		if (!connection) {
			return;
		}
		return {
			label: `$(radio-tower) ${connection.httpPort}`,
			description:
				grouping.workspace?.name ??
				vscode.l10n.t('non-workspace files'),
			accept: (): void => {
				grouping.dispose();
			},
		};
	}
}
