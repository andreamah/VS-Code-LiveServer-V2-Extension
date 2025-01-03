/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Connection } from '../../connectionInfo/connection';
import {
	HTTP_URL_PLACEHOLDER,
	WS_URL_PLACEHOLDER,
} from '../../utils/constants';
import { Disposable } from '../../utils/dispose';

/**
 * @description the string replacement information for the `replace()` function
 */
interface IReplaceObj {
	original: string;
	replacement: string;
}

/**
 * @description the object responsible to loading the injected script and performing the appropriate replacements.
 * For more info about the script's purpose, see the jsdoc for `WSServer`.
 */
export class HTMLInjector extends Disposable {
	private _script: string | undefined;
	public rawScript: string;

	constructor(
		_extensionUri: vscode.Uri,
		private readonly _connection: Connection
	) {
		super();
		const scriptPath = path.join(
			_extensionUri.fsPath,
			'media',
			'injectScript.js'
		);
		// Reading the file synchronously since the rawScript string must exist for the
		// object to function correctly.
		this.rawScript = fs.readFileSync(scriptPath, 'utf8').toString();
		this._initScript(this.rawScript, undefined, undefined);

		this._register(
			this._connection.onConnected((e) => {
				this._refresh(e.httpURI, e.wsURI);
			})
		);
	}

	/**
	 * @description get the injected script (already has replacements).
	 * For debugging, to serve non-injected files, just change this to always return the empty string.
	 */
	public get script(): string | undefined {
		return this._script;
	}

	/**
	 * @description populate `this._script` with the script containing replacements for the server addresses.
	 * @param {string} fileString the raw loaded script with no replacements yet.
	 */
	private async _initScript(
		fileString: string,
		httpUri: vscode.Uri | undefined,
		wsUri: vscode.Uri | undefined
	): Promise<void> {
		if (!httpUri) {
			httpUri = await this._connection.resolveExternalHTTPUri();
		}
		if (!wsUri) {
			wsUri = await this._connection.resolveExternalWSUri();
		}

		const wsURL = `${wsUri.scheme}://${wsUri.authority}${wsUri.path}`;
		let httpURL = `${httpUri.scheme}://${httpUri.authority}`;

		if (httpURL.endsWith('/')) {
			httpURL = httpURL.substring(httpURL.length - 1);
		}
		const replacements = [
			{ original: WS_URL_PLACEHOLDER, replacement: wsURL },
			{ original: HTTP_URL_PLACEHOLDER, replacement: httpURL },
		];
		this._script = this._replace(fileString, replacements);
	}

	/**
	 * @param {string} script the main string to perform replacements on
	 * @param {IReplaceObj[]} replaces array replacements to make
	 * @returns {string} string with all replacements performed on.
	 */
	private _replace(script: string, replaces: IReplaceObj[]): string {
		replaces.forEach((replace) => {
			const placeHolderIndex = script.indexOf(replace.original);
			script =
				script.substring(0, placeHolderIndex) +
				replace.replacement +
				script.substring(placeHolderIndex + replace.original.length);
		});
		return script;
	}

	/**
	 * @description re-populate the script field with replacements. Will re-query the connection manager for the port and host.
	 */
	private async _refresh(
		httpUri: vscode.Uri,
		wsUri: vscode.Uri
	): Promise<void> {
		await this._initScript(this.rawScript, httpUri, wsUri);
	}
}
