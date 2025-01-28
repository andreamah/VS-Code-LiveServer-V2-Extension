/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DEFAULT_HTTP_HEADERS, DEFAULT_PATH_EXTENSIONS } from './constants';

/**
 * @description the object representation of the extension settings.
 */
export interface ILivePreviewConfigItem {
	portNumber: number;
	showServerStatusNotifications: boolean;
	autoRefreshPreview: AutoRefreshPreview;
	openPreviewTarget: OpenPreviewTarget;
	serverKeepAliveAfterEmbeddedPreviewClose: number;
	notifyOnOpenLooseFile: boolean;
	runTaskWithExternalPreview: boolean;
	defaultPreviewPath: string;
	debugOnExternalPreview: boolean;
	hostIP: string;
	customExternalBrowser: CustomExternalBrowser;
	serverRoot: string;
	previewDebounceDelay: number;
	httpHeaders: any;
	pathExtensions: string[];
}

/**
 * @description Options for the preview refresh settings dropdown.
 */
export enum AutoRefreshPreview {
	onAnyChange = 'On All Changes in Editor',
	onSave = 'On Changes to Saved Files',
	never = 'Never',
}

/**
 * @description Options for the preview target settings dropdown.
 */
export enum OpenPreviewTarget {
	embeddedPreview = 'Embedded Preview',
	externalBrowser = 'External Browser',
}

export enum CustomExternalBrowser {
	edge = 'Edge',
	chrome = 'Chrome',
	firefox = 'Firefox',
	default = 'Default'
}

/**
 * @description prefix for all extension contributions for Live Preview
 */
export const SETTINGS_SECTION_ID = 'livePreview';

/**
 * @description contains the string constants for all settings (`SETTINGS_SECTION_ID`.`).
 */
export const Settings: any = {
	portNumber: 'portNumber',
	showStatusBarItem: 'showStatusBarItem',
	showServerStatusNotifications: 'showServerStatusNotifications',
	autoRefreshPreview: 'autoRefreshPreview',
	openPreviewTarget: 'openPreviewTarget',
	serverKeepAliveAfterEmbeddedPreviewClose:
		'serverKeepAliveAfterEmbeddedPreviewClose',
	notifyOnOpenLooseFile: 'notifyOnOpenLooseFile',
	runTaskWithExternalPreview: 'tasks.runTaskWithExternalPreview',
	defaultPreviewPath: 'defaultPreviewPath',
	debugOnExternalPreview: 'debugOnExternalPreview',
	hostIP: 'hostIP',
	customExternalBrowser: 'customExternalBrowser',
	serverRoot: 'serverRoot',
	previewDebounceDelay: 'previewDebounceDelay',
	httpHeaders: 'httpHeaders',
	pathExtensions: 'pathExtensions'
};

/**
 * @description the potential previewType for commands (formatted as `${SETTINGS_SECTION_ID}.start.${previewType}.${target}`).
 */
export const PreviewType = {
	internalPreview: 'internalPreview',
	externalPreview: 'externalPreview',
	externalDebugPreview: 'externalDebugPreview',
};

export class SettingUtil {
	/**
	 * @description Get the current settings JSON.
	 * @returns {ILivePreviewConfigItem} a JSON object with all of the settings for Live Preview.
	 */
	public static GetConfig(scope?: vscode.ConfigurationScope): ILivePreviewConfigItem {
		const config = vscode.workspace.getConfiguration(SETTINGS_SECTION_ID, scope);
		return {
			portNumber: config.get<number>(Settings.portNumber, 3000),
			showServerStatusNotifications: config.get<boolean>(
				Settings.showServerStatusNotifications,
				false
			),
			autoRefreshPreview: config.get<AutoRefreshPreview>(
				Settings.autoRefreshPreview,
				AutoRefreshPreview.onAnyChange
			),
			openPreviewTarget: config.get<OpenPreviewTarget>(
				Settings.openPreviewTarget,
				OpenPreviewTarget.embeddedPreview
			),
			serverKeepAliveAfterEmbeddedPreviewClose: config.get<number>(
				Settings.serverKeepAliveAfterEmbeddedPreviewClose,
				20
			),
			previewDebounceDelay: config.get<number>(
				Settings.previewDebounceDelay,
				50
			),
			notifyOnOpenLooseFile: config.get<boolean>(
				Settings.notifyOnOpenLooseFile,
				true
			),
			runTaskWithExternalPreview: config.get<boolean>(
				Settings.runTaskWithExternalPreview,
				false
			),
			defaultPreviewPath: config.get<string>(Settings.defaultPreviewPath, ''),
			debugOnExternalPreview: config.get<boolean>(
				Settings.debugOnExternalPreview,
				false
			),
			hostIP: config.get<string>(Settings.hostIP, '127.0.0.1'),
			customExternalBrowser: config.get<CustomExternalBrowser>(Settings.customExternalBrowser, CustomExternalBrowser.default),
			serverRoot: config.get<string>(Settings.serverRoot, ''),
			httpHeaders: config.get<any>(Settings.httpHeaders, DEFAULT_HTTP_HEADERS),
			pathExtensions: config.get<string[]>(Settings.pathExtensions, DEFAULT_PATH_EXTENSIONS),
		};
	}

	/**
	 * @description Get the preferred preview target from settings.
	 * @returns {string} the constant in the command string indicating internal or external preview.
	 */
	public static GetPreviewType(): string {
		if (
			SettingUtil.GetConfig().openPreviewTarget ==
			OpenPreviewTarget.embeddedPreview
		) {
			return PreviewType.internalPreview;
		} else {
			return SettingUtil.GetExternalPreviewType();
		}
	}

	public static GetExternalPreviewType(): string {
		if (SettingUtil.GetConfig().debugOnExternalPreview) {
			return PreviewType.externalDebugPreview;
		} else {
			return PreviewType.externalPreview;
		}
	}
	/**
	 * @description Update a Live Preview setting
	 * @param {string} settingSuffix the suffix, `livePreview.<suffix>` of the setting to set.
	 * @param {T} value the value to set the setting to.
	 * @param {vscode.ConfigurationTarget | boolean | null} scope settings scope
	 * @param {vscode.Uri} uri uri to scope the settings to
	 */
	public static async UpdateSettings<T>(
		settingSuffix: string,
		value: T,
		scope: vscode.ConfigurationTarget | boolean | null,
		uri?: vscode.Uri
	): Promise<void> {
		await vscode.workspace
			.getConfiguration(SETTINGS_SECTION_ID, uri)
			.update(settingSuffix, value, scope);
	}
}
