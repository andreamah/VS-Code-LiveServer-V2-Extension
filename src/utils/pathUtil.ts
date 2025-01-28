/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SettingUtil } from './settingsUtil';

/**
 * A collection of functions to perform path operations
 */
export class PathUtil {
	// used to idetify the path separators, `/` or `\\`.
	private static _pathSepRegex = /(?:\\|\/)+/;

	/**
	 * @description escapes a path, but keeps the `/` delimeter intact.
	 * @param {string} file the file path to escape.
	 * @returns {string} the escaped path.
	 */
	public static EscapePathParts(file: string): string {
		file = decodeURI(file);
		const parts = file.split('/');

		const newParts = parts
			.filter((part) => part.length > 0)
			.map((filterdPart) => encodeURI(filterdPart));
		return newParts.join('/');
	}

	/**
	 * @description reverses the work performed by `PathUtil.EscapePathParts`.
	 * @param {string} file the file path to unescape.
	 * @returns {string} the unescaped path.
	 */
	public static UnescapePathParts(file: string): string {
		const parts = file.split('/');
		const newParts = parts
			.filter((part) => part.length > 0)
			.map((filterdPart) => decodeURI(filterdPart));
		return newParts.join('/');
	}

	/**
	 * @param {string} file a file path.
	 * @returns {string} The parent pathname that the file belongs to; e.g. `c:/a/file/path.txt` returns `c:/a/file/`.
	 * Using `c:/a/file/` should return `c:/a/file/` since `c:/a/file/` is a directory already.
	 */
	public static async GetParentDir(file: string): Promise<string> {

		const existsStatInfo = await PathUtil.FileExistsStat(file);
		if (existsStatInfo.exists && existsStatInfo.stat && existsStatInfo.stat.isDirectory()) {
			return file;
		}
		return path.dirname(file);
	}

	/**
	 * @param {string} file a file path.
	 * @param {boolean} returnEmptyOnDir whether to return an empty string when given an existing directory.
	 * @returns {string} The filename from the path; e.g. `c:/a/file/path.txt` returns `path.txt`.
	 */
	public static async GetFileName(file: string, returnEmptyOnDir = false): Promise<string> {

		if (returnEmptyOnDir) {
			const existsStatInfo = await PathUtil.FileExistsStat(file);
			if (existsStatInfo.exists && existsStatInfo.stat && existsStatInfo.stat.isDirectory()) {
				return '';
			}
		}
		return path.basename(file);
	}

	/**
	 * @param {string} file1
	 * @param {string} file2
	 * @returns {boolean} whether `file1` and `file2` are equal when using the same path delimeter
	 */
	public static PathEquals(file1: string, file2: string): boolean {
		return path.normalize(file1) === path.normalize(file2);
	}

	/**
	 * @param {string} file1
	 * @param {string} file2
	 * @returns {boolean} whether `file1` is a child of `file2`.
	 */
	public static PathBeginsWith(file1: string, file2: string): boolean {
		return path.normalize(file1).startsWith(path.normalize(file2 + '/'));
	}

	/**
	 * @param {string} file the file to convert
	 * @returns {string} the file path using the `/` posix-compliant path delimeter.
	 */
	public static ConvertToPosixPath(file: string): string {
		return file.split(path.sep).join(path.posix.sep);
	}

	/**
	 * Get file path relative to workspace root.
	 * @param file
	 * @returns relative path (or undefined if the file does not belong to a workspace)
	 */
	public static async getPathRelativeToWorkspace(file: vscode.Uri): Promise<string | undefined> {
		const workspaceFolder = await PathUtil.GetWorkspaceFromURI(file);
		if (!workspaceFolder) {
			return undefined;
		}
		return file.fsPath.substring(workspaceFolder.uri.fsPath.length);
	}

	/**
	 * @param {string} file the child path of the `Users` directory of the user data dir.
	 * @returns {string} the path to the `Users` directory of the user data dir.
	 */
	public static GetUserDataDirFromStorageUri(
		file: string | undefined
	): string | undefined {
		// a little hacky, but should work to find the target dir.
		if (!file) {
			return file;
		}
		file = PathUtil.ConvertToPosixPath(file);
		const parts = file.split('/');

		const newParts = [];
		for (const part of parts) {
			if (part.length > 0) {
				newParts.push(part);
			}
			if (part == 'User') {
				break;
			}
		}

		return newParts.join('/');
	}

	public static async GetWorkspaceFromURI(
		file: vscode.Uri
	): Promise<vscode.WorkspaceFolder | undefined> {
		return await PathUtil.GetWorkspaceFromAbsolutePath(file.fsPath);
	}

	/**
	 * @description Similar to `_absPathInWorkspace`, but checks all workspaces and returns the matching workspace.
	 * @param {string} file path to test.
	 * @returns {vscode.WorkspaceFolder | undefined} the workspace it belongs to
	 */
	public static async GetWorkspaceFromAbsolutePath(
		file: string
	): Promise<vscode.WorkspaceFolder | undefined> {
		const workspaces = vscode.workspace.workspaceFolders;

		if (!workspaces) {
			return undefined;
		}

		const checkPathBeginsWithForWorkspace = async (workspace: vscode.WorkspaceFolder, file: string): Promise<vscode.WorkspaceFolder | undefined> => {
			const rootPrefix = await PathUtil.GetValidServerRootForWorkspace(workspace);
			return PathUtil.PathBeginsWith(file, path.join(workspace.uri.fsPath, rootPrefix)) ? workspace : undefined;
		};

		const validWorkspacesForFile = await Promise.all(workspaces?.map((workspace) => {
			return checkPathBeginsWithForWorkspace(workspace, file);
		}));

		return validWorkspacesForFile.find((workspace) => (workspace !== undefined));
	}

	/**
	 * @description Just like `pathExistsRelativeToDefaultWorkspace`, but tests all workspaces and returns the matching workspace.
	 * Assumes that the file is relative to the root prefix in settings.
	 * @param {string} file path to test.
	 * @returns {vscode.WorkspaceFolder | undefined} the workspace it belongs to
	 */
	public static async GetWorkspaceFromRelativePath(
		file: string, ignoreFileRoot = false
	): Promise<vscode.WorkspaceFolder | undefined> {
		const workspaces = vscode.workspace.workspaceFolders;

		if (!workspaces) {
			return undefined;
		}

		const checkFileExistsStatForWorkspace = async (workspace: vscode.WorkspaceFolder): Promise<boolean> => {
			const rootPrefix = ignoreFileRoot ? '' : await PathUtil.GetValidServerRootForWorkspace(workspace);
			return (await PathUtil.FileExistsStat(path.join(workspace.uri.fsPath, rootPrefix, file))).exists;
		};

		const promises = workspaces.map((workspace) => checkFileExistsStatForWorkspace(workspace));

		const idx = (await Promise.all(promises)).findIndex((exists) => exists);
		if (idx === -1) {
			return undefined;
		}
		return workspaces[idx];
	}

	/**
	 * @description used to get the `serverRoot` setting properly, as it is only applied when using it would make a valid path
	 * @param workspace
	 * @returns the server root from settings if any of the paths would point to an existing directory
	 */
	public static async GetValidServerRootForWorkspace(workspace: vscode.WorkspaceFolder): Promise<string> {
		const serverRoot = SettingUtil.GetConfig(workspace).serverRoot;
		const roots: string[] = Array.isArray(serverRoot) ? serverRoot : [serverRoot];

		for (const root of roots) {
			if (root === '.') {
				const activeFilePath = vscode.window.activeTextEditor?.document.uri.fsPath;
				if (!activeFilePath) {
					continue;
				}
				const relative = path.relative(workspace.uri.fsPath, path.dirname(activeFilePath));
				if (relative.startsWith('..')) {
					continue;
				}
				return relative;
			}

			if ((await PathUtil.FileExistsStat(path.join(workspace.uri.fsPath, root))).exists) {
				return root;
			}
		}
		return '';
	}

	/**
	 * @param file
	 * @returns object containing exists and stat info
	 */
	public static async FileExistsStat(file: string): Promise<{ exists: boolean, stat: fs.Stats | undefined }> {
		return fs.promises.stat(file)
			.then((stat) => { return { exists: true, stat }; })
			.catch(() => { return { exists: false, stat: undefined }; });
	}

	/**
	 * Reads file in utf-8 encoding.
	 * @param file
	 * @returns file contents (or empty string if error encountered)
	 */
	public static async FileRead(file: string): Promise<string> {
		return fs.promises.readFile(file, 'utf-8')
			.then((data) => data.toString())
			.catch(() => '');
	}



	/**
	 * Get the immediate parent of the encoded endpoint directory path. Needed to create index pages
	 * @param urlPath
	 */
	public static GetEndpointParent(urlPath: string): string {
		let endpoint: string | undefined = urlPath.endsWith('/')
			? urlPath.substring(0, urlPath.length - 1)
			: urlPath;
		endpoint = endpoint.split('/').pop();

		if (!endpoint) {
			return '.';
		}
		return decodeURI(endpoint);
	}
}
