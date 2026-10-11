/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { getServerCostsFolderPath, parseServerCostsFile } from '../gatewayTrackingService';

describe('parseServerCostsFile (CreaEditor)', () => {
	test('tags the entries of a server cache with the server and skips anything malformed', () => {
		const file = JSON.stringify({
			serverId: 's1',
			serverName: 'build-box',
			cursor: 2,
			entries: [
				{ id: 'a', time: 1, chatId: 'c', rootChatId: 'c', gateway: 'openrouter', gatewayHost: 'openrouter.ai', model: 'm', cost: 0.1 },
				{ id: 5, time: 2 },
				null,
			],
		});
		expect({
			entries: parseServerCostsFile(file).map(entry => [entry.id, entry.source, entry.cost]),
			broken: parseServerCostsFile('{'),
			noName: parseServerCostsFile(JSON.stringify({ entries: [] })),
		}).toEqual({ entries: [['a', 'build-box', 0.1]], broken: [], noName: [] });
	});
});

describe('getServerCostsFolderPath (CreaEditor)', () => {
	test('is in the default profile\'s global storage whatever profile the extension runs in', () => {
		expect([
			getServerCostsFolderPath('/tmp/ud/User/globalStorage/github.copilot-chat'),
			getServerCostsFolderPath('/tmp/ud/User/profiles/builtin/agents/globalStorage/github.copilot-chat'),
			getServerCostsFolderPath('/tmp/ud/User/profiles/-5a1b2c3d/globalStorage/github.copilot-chat/'),
			getServerCostsFolderPath('/c:/Users/me/AppData/Roaming/CreaEditor/User/profiles/x/globalStorage/github.copilot-chat'),
		]).toEqual([
			'/tmp/ud/User/globalStorage/creaeditor-server-costs',
			'/tmp/ud/User/globalStorage/creaeditor-server-costs',
			'/tmp/ud/User/globalStorage/creaeditor-server-costs',
			'/c:/Users/me/AppData/Roaming/CreaEditor/User/globalStorage/creaeditor-server-costs',
		]);
	});
});
