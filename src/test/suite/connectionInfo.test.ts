/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import sinon from 'sinon';
import vscode from 'vscode';
import { ConnectionManager } from '../../connectionInfo/connectionManager';
import { PathUtil } from '../../utils/pathUtil';
import { Stats } from 'fs';
import { makeSetting, testWorkspaces } from './common';
import { SettingUtil } from '../../utils/settingsUtil';

describe('ConnectionInfo', () => {
	let sandbox: sinon.SinonSandbox;
	let connectionManager: ConnectionManager;
	beforeEach(() => {
		sandbox = sinon.createSandbox();

		connectionManager = new ConnectionManager();

		const existingPaths = [
			'c:/Users/TestUser/workspace1/test'
		];

		sandbox.stub(PathUtil, 'FileExistsStat').callsFake((path: string) => {
			if (existingPaths.indexOf(PathUtil.ConvertToPosixPath(path)) > -1) {
				return Promise.resolve({ exists: true, stat: new Stats() });
			}
			return Promise.resolve({ exists: false, stat: new Stats() });
		});
	});

	afterEach(() => {
		connectionManager.dispose();
		sandbox.restore();
	});


	it('should be able to create a Connection', async () => {
		const target = sinon.spy();
		sandbox.stub(SettingUtil, 'GetConfig').returns(makeSetting({ serverRoot: 'test' }));
		sandbox.stub(vscode.env, 'asExternalUri').callsFake((uri) => Promise.resolve(uri));

		const connection = await connectionManager.createAndAddNewConnection(testWorkspaces[0]);
		connection.onConnected(
			(elem) => {
				target(elem);
			});
		connection.httpPort = 3000;
		connection.wsPath = '/1234';
		connection.wsPort = 3001;
		await connection.connected();
		assert(connection.workspace === testWorkspaces[0]);

		assert.ok(target.calledOnce);
		const httpUri = vscode.Uri.parse('http://127.0.0.1:3000');
		const wsUri = vscode.Uri.parse('ws://127.0.0.1:3001/1234');
		assert.deepStrictEqual([
			{
				httpURI: httpUri,
				wsURI: wsUri,
				workspace: testWorkspaces[0],
				httpPort: 3000,
				rootPrefix: 'test'
			}
		], target.args[0]);

		// it should return correct info from connection fields
		const rootUri = vscode.Uri.joinPath(testWorkspaces[0].uri, 'test');
		const testUri = vscode.Uri.joinPath(testWorkspaces[0].uri, 'test', 'woot');
		assert.deepEqual(connection.workspace, testWorkspaces[0]);
		assert.deepEqual(connection.rootURI, rootUri);
		assert.deepEqual(connection.rootPath, rootUri.fsPath);

		assert.deepEqual(connection.getFileRelativeToWorkspace(testUri.fsPath), '/woot');
		assert.deepEqual(connection.getAppendedURI('woot').path, testUri.path);


		// changing the host should work

		assert.equal(connection.host, '127.0.0.1');
		connection.host = '128.0.0.1';
		connection.resetHostToDefault();
		assert.equal(connection.host, '127.0.0.1');

	});


	it('should be able to create a Connection with an undefined workspace', async () => {
		const target = sinon.spy();
		sandbox.stub(SettingUtil, 'GetConfig').returns(makeSetting({}));
		sandbox.stub(vscode.env, 'asExternalUri').callsFake((uri) => Promise.resolve(uri));

		const connection = await connectionManager.createAndAddNewConnection(undefined);
		connection.onConnected(
			(elem) => {
				target(elem);
			});
		connection.httpPort = 3000;
		connection.wsPath = '/1234';
		connection.wsPort = 3001;
		await connection.connected();
		assert(connection.workspace === undefined);
		const httpUri = vscode.Uri.parse('http://127.0.0.1:3000');
		const wsUri = vscode.Uri.parse('ws://127.0.0.1:3001/1234');

		assert.ok(target.calledOnce);
		assert.deepStrictEqual([
			{
				httpURI: httpUri,
				wsURI: wsUri,
				workspace: undefined,
				httpPort: 3000,
				rootPrefix: ''
			}
		], target.args[0]);
	});
});