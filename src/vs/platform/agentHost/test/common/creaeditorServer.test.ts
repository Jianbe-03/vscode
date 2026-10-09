/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getCreaEditorServerAgentHostAddress, parseCreaEditorServerHealth, parseCreaEditorServerInput, parseCreaEditorServerPairResponse } from '../../common/creaeditorServer.js';

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

	test('reads health and pairing answers and the agent host address', () => {
		assert.deepStrictEqual({
			health: [
				parseCreaEditorServerHealth({ status: 'ok', product: 'CreaEditor Server', version: '1.140.0', commit: 'abc', publicMode: true, webUi: true, uptimeSeconds: 12 }),
				parseCreaEditorServerHealth({ status: 'ok', product: 'CreaEditor Server', version: '1.140.0' }),
				parseCreaEditorServerHealth({ status: 'down' }),
				parseCreaEditorServerHealth('ok'),
			],
			pair: [
				parseCreaEditorServerPairResponse(200, { deviceId: 'd1', deviceName: 'Laptop', deviceKey: 'd1.secret' }),
				parseCreaEditorServerPairResponse(403, { error: 'passwordRequired' }),
				parseCreaEditorServerPairResponse(429, { error: 'lockedOut', retryAfterSeconds: 900 }),
				parseCreaEditorServerPairResponse(500, 'oops'),
			],
			address: [
				getCreaEditorServerAgentHostAddress('https://agents.example.com'),
				getCreaEditorServerAgentHostAddress('http://100.64.0.2:31600'),
			],
		}, {
			health: [
				{ product: 'CreaEditor Server', version: '1.140.0', commit: 'abc', publicMode: true, webUi: true, uptimeSeconds: 12 },
				{ product: 'CreaEditor Server', version: '1.140.0', publicMode: false, webUi: false, uptimeSeconds: 0 },
				undefined,
				undefined,
			],
			pair: [
				{ ok: true, deviceId: 'd1', deviceKey: 'd1.secret' },
				{ ok: false, error: 'passwordRequired' },
				{ ok: false, error: 'lockedOut', retryAfterSeconds: 900 },
				{ ok: false, error: 'unexpected' },
			],
			address: ['wss://agents.example.com/ahp', '100.64.0.2:31600/ahp'],
		});
	});
});
