/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseCreaEditorServerHealth, parseCreaEditorServerInput } from '../../common/creaeditorServer.js';

suite('CreaEditor Server address', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads addresses and pairing links', () => {
		assert.deepStrictEqual([
			'https://agents.example.com',
			'https://agents.example.com/',
			'http://100.64.0.2:31600',
			'100.64.0.2',
			'box.tail1234.ts.net:4000',
			'  https://agents.example.com/pair?code=abcd-1234  ',
			'http://192.168.1.10:31600/#code=WXYZ%201234',
			'wss://agents.example.com/agent',
			'[::1]:31600',
		].map(parseCreaEditorServerInput), [
			{ baseUrl: 'https://agents.example.com', suggestedName: 'agents.example.com' },
			{ baseUrl: 'https://agents.example.com', suggestedName: 'agents.example.com' },
			{ baseUrl: 'http://100.64.0.2:31600', suggestedName: '100.64.0.2' },
			{ baseUrl: 'http://100.64.0.2:31600', suggestedName: '100.64.0.2' },
			{ baseUrl: 'http://box.tail1234.ts.net:4000', suggestedName: 'box.tail1234.ts.net' },
			{ baseUrl: 'https://agents.example.com', pairingCode: 'ABCD-1234', suggestedName: 'agents.example.com' },
			{ baseUrl: 'http://192.168.1.10:31600', pairingCode: 'WXYZ1234', suggestedName: '192.168.1.10' },
			{ baseUrl: 'https://agents.example.com', suggestedName: 'agents.example.com' },
			{ baseUrl: 'http://[::1]:31600', suggestedName: '[::1]' },
		]);
	});

	test('refuses what is not a server address', () => {
		assert.deepStrictEqual(['', '   ', 'ftp://example.com', 'two words', 'https://user:pw@example.com', 'http://'].map(parseCreaEditorServerInput), Array(6).fill(undefined));
	});

	test('reads only CreaEditor Server health answers', () => {
		assert.deepStrictEqual([
			parseCreaEditorServerHealth({ product: 'creaeditor-server', ok: true, version: '1.0.0', agentHost: 'running', cpu: { cores: 2, percent: 10 }, memory: { totalBytes: 4, freeBytes: 1 }, runningChats: 3 }),
			parseCreaEditorServerHealth({ status: 'ok' }),
			parseCreaEditorServerHealth('ok'),
		], [
			{ product: 'creaeditor-server', ok: true, version: '1.0.0', platform: '', arch: '', uptimeSeconds: 0, agentHost: 'running', cpu: { cores: 2, percent: 10 }, memory: { totalBytes: 4, freeBytes: 1 }, runningChats: 3 },
			undefined,
			undefined,
		]);
	});
});
