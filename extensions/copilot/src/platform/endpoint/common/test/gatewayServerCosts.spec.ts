/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { parseServerCostsFile } from '../gatewayTrackingService';

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
