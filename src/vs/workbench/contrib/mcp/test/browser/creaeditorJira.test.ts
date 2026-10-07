/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getJiraMcpServer } from '../../browser/creaeditorJira.js';

suite('Connect Jira', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds the Atlassian MCP server, keeping an API key out of mcp.json', () => {
		const apiKey = getJiraMcpServer('apiKey');
		assert.deepStrictEqual({
			oauth: getJiraMcpServer('oauth'),
			apiKey: { config: apiKey.config, inputs: apiKey.inputs?.map(input => ({ id: input.id, type: input.type, password: input.password })) },
		}, {
			oauth: { config: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp' } },
			apiKey: {
				config: { type: 'http', url: 'https://mcp.atlassian.com/v2/mcp', headers: { Authorization: 'Bearer ${input:atlassian-api-key}' } },
				inputs: [{ id: 'atlassian-api-key', type: 'promptString', password: true }],
			},
		});
	});
});
