/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Stream from 'stream';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import * as mime from 'mime';
import { Disposable } from '../../utils/dispose';
import {
	FormatFileSize,
	FormatDateTime,
	isFileInjectable,
} from '../../utils/utils';
import { HTMLInjector } from './HTMLInjector';
import TelemetryReporter from 'vscode-extension-telemetry';
import { EndpointManager } from '../../infoManagers/endpointManager';
import { PathUtil } from '../../utils/pathUtil';
import { INJECTED_ENDPOINT_NAME } from '../../utils/constants';
import { Connection } from '../../connectionInfo/connection';

/**
 * @description the response information to give back to the server object
 */
interface IRespInfo {
	ContentType: string | undefined;
	ContentLength: number | undefined;
	Stream: Stream.Readable | fs.ReadStream | undefined;
}

/**
 * @description table entry for a file in the auto-generated index.
 */
interface IIndexFileEntry {
	LinkSrc: string;
	LinkName: string;
	FileSize: string;
	DateTime: string;
}

/**
 * @description table entry for a directory in the auto-generated index.
 */
interface IIndexDirEntry {
	LinkSrc: string;
	LinkName: string;
	DateTime: string;
}

/**
 * @description object responsible for loading content requested by the HTTP server.
 */
export class ContentLoader extends Disposable {
	private _scriptInjector: HTMLInjector | undefined;
	private _servedFiles: Set<string> = new Set<string>();
	private _insertionTags = ['head', 'body', 'html', '!DOCTYPE'];

	constructor(
		_extensionUri: vscode.Uri,
		private readonly _reporter: TelemetryReporter,
		readonly _endpointManager: EndpointManager,
		readonly _connection: Connection
	) {
		super();
		this._scriptInjector = new HTMLInjector(_extensionUri, _connection);
	}

	/**
	 * @description reset the list of served files; served files are used to watch changes for when being changed in the editor.
	 */
	public resetServedFiles(): void {
		this._servedFiles = new Set<string>();
	}

	/**
	 * @returns the files served by the HTTP server
	 */
	public get servedFiles(): Set<string> {
		return this._servedFiles;
	}

	/**
	 * @returns the script tags needed to reference the custom script endpoint.
	 */
	private get _scriptInjection(): string {
		return `<script type="text/javascript" src="${INJECTED_ENDPOINT_NAME}"></script>`;
	}

	/**
	 * @returns {IRespInfo} the injected script and its content type.
	 */
	public loadInjectedJS(): IRespInfo {
		const fileString = Buffer.from(this._scriptInjector?.script ?? '');

		return {
			Stream: Stream.Readable.from(fileString),
			ContentType: 'text/javascript; charset=UTF-8',
			ContentLength: fileString.length,
		};
	}

	/**
	 * @description create a "page does not exist" page to pair with the 404 error.
	 * @param relativePath the path that does not exist
	 * @returns {IRespInfo} the response information
	 */
	public createPageDoesNotExist(relativePath: string): IRespInfo {
		/* __GDPR__
			"server.pageDoesNotExist" : {}
		*/
		this._reporter.sendTelemetryEvent('server.pageDoesNotExist');
		const fileNotFound = vscode.l10n.t('File not found');
		const relativePathFormatted = `<b>"${relativePath}"</b>`;
		const fileNotFoundMsg = vscode.l10n.t(
			'The file {0} cannot be found. It may have been moved, edited, or deleted.',
			relativePathFormatted
		);
		const htmlString = Buffer.from(`
		<!DOCTYPE html>
		<html>
			<head>
				<title>${fileNotFound}</title>
			</head>
			<body>
				<h1>${fileNotFound}</h1>
				<p>${fileNotFoundMsg}</p>
			</body>
			${this._scriptInjection}
		</html>
		`);

		return {
			Stream: Stream.Readable.from(htmlString),
			ContentType: 'text/html; charset=UTF-8',
			ContentLength: htmlString.length,
		};
	}

	/**
	 * @description In a multi-root case, the index will not lead to anything. Create this page to list all possible indices to visit.
	 * @returns {IRespInfo} the response info
	 */
	public createNoRootServer(): IRespInfo {
		const noServerRoot = vscode.l10n.t('No Server Root');
		const noWorkspaceOpen = vscode.l10n.t('This server is not based inside of a workspace, so the index does not direct to anything.');
		const customMsg = `<p>${noWorkspaceOpen}</p>`;
		const htmlString = Buffer.from(`
		<!DOCTYPE html>
		<html>
			<head>
				<title>${noServerRoot}</title>
			</head>
			<body>
				<h1>${noServerRoot}</h1>
				${customMsg}
			</body>
			${this._scriptInjection}
		</html>
		`);

		return {
			Stream: Stream.Readable.from(htmlString),
			ContentType: 'text/html; charset=UTF-8',
			ContentLength: htmlString.length,
		};
	}

	/**
	 * @description Create a defaut index page (served if no `index.html` file is available for the directory).
	 * @param {string} readPath the absolute path visited.
	 * @param {string} relativePath the relative path (from workspace root).
	 * @param {string} titlePath the path shown in the title.
	 * @returns {Promise<IRespInfo>} the response info.
	 */
	public async createIndexPage(
		readPath: string,
		relativePath: string,
		titlePath = relativePath
	): Promise<IRespInfo> {
		/* __GDPR__
			"server.indexPage" : {}
		*/
		this._reporter.sendTelemetryEvent('server.indexPage');

		const childFiles = await this.fsReadDir(readPath);

		const fileEntries = new Array<IIndexFileEntry>();
		const dirEntries = new Array<IIndexDirEntry>();

		if (relativePath != '/') {
			dirEntries.push({ LinkSrc: '..', LinkName: '..', DateTime: '' });
		}

		for (const childFile of childFiles) {
			const relativeFileWithChild = path.join(relativePath, childFile);
			const absolutePath = path.join(readPath, childFile);

			const fileStats = (await PathUtil.FileExistsStat(absolutePath)).stat;
			if (!fileStats) {
				continue;
			}
			const modifiedDateTimeString = FormatDateTime(fileStats.mtime);

			if (fileStats.isDirectory()) {
				dirEntries.push({
					LinkSrc: relativeFileWithChild,
					LinkName: childFile,
					DateTime: modifiedDateTimeString,
				});
			} else {
				const fileSize = FormatFileSize(fileStats.size);
				fileEntries.push({
					LinkSrc: relativeFileWithChild,
					LinkName: childFile,
					FileSize: fileSize,
					DateTime: modifiedDateTimeString,
				});
			}
		}

		let directoryContents = '';

		dirEntries.forEach(
			(elem: IIndexDirEntry) =>
			(directoryContents += `
				<tr>
				<td><a href="${elem.LinkSrc}/">${elem.LinkName}/</a></td>
				<td></td>
				<td>${elem.DateTime}</td>
				</tr>\n`)
		);

		fileEntries.forEach(
			(elem: IIndexFileEntry) =>
			(directoryContents += `
				<tr>
				<td><a href="${elem.LinkSrc}">${elem.LinkName}</a></td>
				<td>${elem.FileSize}</td>
				<td>${elem.DateTime}</td>
				</tr>\n`)
		);

		const indexOfTitlePath = vscode.l10n.t('Index of {0}', titlePath);
		const name = vscode.l10n.t('Name');
		const size = vscode.l10n.t('Size');
		const dateModified = vscode.l10n.t('Date Modified');
		const htmlString = Buffer.from(`
		<!DOCTYPE html>
		<html>
			<head>
				<style>
					table td {
						padding:4px;
					}
				</style>
				<title>${indexOfTitlePath}</title>
			</head>
			<body>
			<h1>${indexOfTitlePath}</h1>

			<table>
				<th>${name}</th><th>${size}</th><th>${dateModified}</th>
				${directoryContents}
			</table>
			</body>

			${this._scriptInjection}
		</html>
		`);

		return {
			Stream: Stream.Readable.from(htmlString),
			ContentType: 'text/html; charset=UTF-8',
			ContentLength: htmlString.length,
		};
	}

	/**
	 * @description get the file contents and load it into a form that can be served.
	 * @param {string} readPath the absolute file path to read from
	 * @param {boolean} inFilesystem whether the path is in the filesystem (false for untitled files in editor)
	 * @returns {IRespInfo} the response info
	 */
	public async getFileStream(readPath: string, inFilesystem = true): Promise<IRespInfo> {
		this._servedFiles.add(readPath);
		const workspaceDocuments = vscode.workspace.textDocuments;
		let i = 0;
		let stream: Stream.Readable | fs.ReadStream | undefined;

		let contentType = mime.getType(readPath) ?? 'text/plain';
		let contentLength = 0;

		while (i < workspaceDocuments.length) {
			if (PathUtil.PathEquals(readPath, workspaceDocuments[i].fileName) || (workspaceDocuments[i].uri.scheme === 'vscode-chat-code-block' && workspaceDocuments[i].uri.with({ fragment: '' }).toString() === readPath)) {
				if (inFilesystem && workspaceDocuments[i].isUntitled) {
					continue;
				}
				let fileContents = workspaceDocuments[i].getText();

				if (workspaceDocuments[i].languageId == 'html') {
					fileContents = this._injectIntoFile(fileContents);
					contentType = 'text/html';
				}

				const fileContentsBuffer = Buffer.from(fileContents);
				stream = Stream.Readable.from(fileContentsBuffer);
				contentLength = fileContentsBuffer.length;
				break;
			}
			i++;
		}

		if (inFilesystem && i == workspaceDocuments.length) {
			if (isFileInjectable(readPath)) {
				const buffer = await PathUtil.FileRead(readPath);
				const injectedFileContents = this._injectIntoFile(buffer.toString());
				const injectedFileContentsBuffer = Buffer.from(injectedFileContents);
				stream = Stream.Readable.from(injectedFileContentsBuffer);
				contentLength = injectedFileContentsBuffer.length;
			} else {
				stream = fs.createReadStream(readPath);
				contentLength = fs.statSync(readPath).size;
			}
		}

		if (contentType.startsWith('text/')) {
			contentType = `${contentType}; charset=UTF-8`;
		}

		return {
			Stream: stream,
			ContentType: contentType,
			ContentLength: contentLength
		};
	}

	/**
	 * Inject the script tags to reference the custom Live Preview script.
	 * NOTE: they are injected on the same line as existing content to ensure that
	 * the debugging works, since `js-debug` relies on the line numbers on the filesystem
	 * matching the served line numbers.
	 * @param {string} contents the contents to inject.
	 * @returns {string} the injected string.
	 */
	private _injectIntoFile(contents: string): string {
		// order of preference for script placement:
		// 1. after <head>
		// 2. after <body>
		// 3. after <html>
		// 4. after <!DOCTYPE >
		// 5. at the very beginning

		let re: RegExp;
		let tagEnd = 0;
		for (const tag of this._insertionTags) {
			re = new RegExp(`<${tag}[^>]*>`, 'g');
			re.test(contents);

			tagEnd = re.lastIndex;
			if (tagEnd != 0) {
				break;
			}
		}

		const newContents =
			contents.substring(0, tagEnd) +
			this._scriptInjection +
			contents.substring(tagEnd);
		return newContents;
	}

	private fsReadDir(path: string): Promise<string[]> {
		return (new Promise((resolve) => fs.readdir(path,
			(err, files) => {
				resolve(err ? [] : files);
			})
		));
	}
}
