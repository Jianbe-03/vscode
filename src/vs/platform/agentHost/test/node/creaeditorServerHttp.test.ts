/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { createNtfyTestRequest, ICreaEditorServerHttpRequest, validateCreaEditorServerHttpRequest } from '../../common/creaeditorServerHttp.js';
import { NodeCreaEditorServerHttpService } from '../../node/creaeditorServerHttpClient.js';

function check(request: ICreaEditorServerHttpRequest): string {
	const result = validateCreaEditorServerHttpRequest(request);
	return 'error' in result ? `refused: ${result.error}` : `${result.method} ${result.url.href} ${JSON.stringify(result.headers)} ${result.timeoutMs}`;
}

suite('CreaEditor Server HTTP', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('only forwards CreaEditor Server API requests', () => {
		const requests: ICreaEditorServerHttpRequest[] = [
			{ url: 'http://100.64.0.2:31600/health', method: 'GET' },
			{ url: 'https://agents.example.com/api/server/costs?after=5', method: 'GET', headers: { 'Authorization': 'Bearer fake' }, timeoutMs: 60_000 },
			{ url: 'http://127.0.0.1:31600/api/pair', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 1000 },
			{ url: 'file:///etc/passwd', method: 'GET' },
			{ url: 'http://user:pw@127.0.0.1/health', method: 'GET' },
			{ url: 'http://127.0.0.1:31600/', method: 'GET' },
			{ url: 'http://127.0.0.1:31600/healthz', method: 'GET' },
			{ url: 'http://127.0.0.1:31600/api/../admin', method: 'GET' },
			{ url: 'http://127.0.0.1:31600/api/%2e%2e/admin', method: 'GET' },
			{ url: 'http://127.0.0.1:31600/api/a%2Fb', method: 'GET' },
			{ url: 'http://127.0.0.1:31600/api/x', method: 'DELETE' as 'GET' },
			{ url: 'http://127.0.0.1:31600/api/x', method: 'GET', headers: { 'Cookie': 'a=b' } },
			{ url: 'http://127.0.0.1:31600/api/x', method: 'GET', headers: { 'Authorization': 'Bearer a\r\nX-Evil: 1' } },
			{ url: 'not a url', method: 'GET' },
		];
		assert.deepStrictEqual(requests.map(check), [
			'GET http://100.64.0.2:31600/health {} 8000',
			'GET https://agents.example.com/api/server/costs?after=5 {"Authorization":"Bearer fake"} 30000',
			'POST http://127.0.0.1:31600/api/pair {"Content-Type":"application/json"} 1000',
			'refused: Only http and https URLs are allowed.',
			'refused: URLs with credentials are not allowed.',
			'refused: Only /health and /api/ paths are allowed.',
			'refused: Only /health and /api/ paths are allowed.',
			'refused: Only /health and /api/ paths are allowed.',
			'refused: Only /health and /api/ paths are allowed.',
			'refused: The path is not allowed.',
			'refused: The method is not allowed.',
			'refused: The header Cookie is not allowed.',
			'refused: The header Authorization is not valid.',
			'refused: The URL is not valid.',
		]);
	});

	test('builds the ntfy test notification only for a topic URL', () => {
		assert.deepStrictEqual([
			createNtfyTestRequest({ url: 'http://127.0.0.1:8999/creaeditor-abc', token: 'fake' }, 'Title', 'Message'),
			createNtfyTestRequest({ url: 'http://127.0.0.1:8999/api/server/pairing?x=1' }, 'Title', 'Message'),
			createNtfyTestRequest({ url: 'file:///tmp/topic' }, 'Title', 'Message'),
		], [
			{
				url: 'http://127.0.0.1:8999/',
				headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer fake' },
				body: JSON.stringify({ topic: 'creaeditor-abc', title: 'Title', message: 'Message', priority: 3, tags: ['tada'] }),
			},
			{ error: 'The notification topic is not valid.' },
			{ error: 'The notification topic is not valid.' },
		]);
	});

	test('sends requests and test notifications over Node http', async () => {
		const received: string[] = [];
		const server = http.createServer((request, response) => {
			let body = '';
			request.on('data', chunk => body += chunk);
			request.on('end', () => {
				received.push(`${request.method} ${request.url} ${request.headers['authorization'] ?? ''} ${body}`);
				response.writeHead(request.url === '/health' ? 200 : 401, { 'Content-Type': 'application/json' });
				response.end(JSON.stringify({ status: 'ok' }));
			});
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const service = new NodeCreaEditorServerHttpService();
			const health = await service.request({ url: `${base}/health`, method: 'GET' });
			const ntfyStatus = await service.sendNtfyTestNotification({ url: `${base}/creaeditor-abc`, token: 'fake' }, 'T', 'M');
			const refused = await service.request({ url: `${base}/admin`, method: 'GET' }).then(() => 'sent', (error: Error) => error.message);
			assert.deepStrictEqual({ health, ntfyStatus, refused, received }, {
				health: { status: 200, body: '{"status":"ok"}' },
				ntfyStatus: 401,
				refused: 'Only /health and /api/ paths are allowed.',
				received: [
					'GET /health  ',
					`POST / Bearer fake ${JSON.stringify({ topic: 'creaeditor-abc', title: 'T', message: 'M', priority: 3, tags: ['tada'] })}`,
				],
			});
		} finally {
			await new Promise(resolve => server.close(resolve));
		}
	});
});
