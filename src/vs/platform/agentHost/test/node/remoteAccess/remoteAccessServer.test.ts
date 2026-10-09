/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import type * as wsTypes from 'ws';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { connectionTokenQueryName } from '../../../../../base/common/network.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { RemoteAccessAuth } from '../../../node/remoteAccess/remoteAccessAuth.js';
import { createSocketRelayConnector, IRemoteAccessServerHandle, RemoteAccessProtocolServer, startRemoteAccessServer } from '../../../node/remoteAccess/remoteAccessServer.js';
import { WebSocketProtocolServer } from '../../../node/webSocketTransport.js';

suite('RemoteAccessServer', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let auth: RemoteAccessAuth;
	let protocolServer: RemoteAccessProtocolServer;
	let server: IRemoteAccessServerHandle;

	setup(async () => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'remoteAccessServer');
		const webRoot = join(dir, 'web');
		await fs.mkdir(join(webRoot, 'vs', 'sessions'), { recursive: true });
		await fs.writeFile(join(webRoot, 'vs', 'sessions', 'sessions.web.main.internal.js'), 'export const create = () => { };');
		await fs.writeFile(join(dir, 'secret.txt'), 'outside the web root');
		auth = store.add(await RemoteAccessAuth.create(join(dir, 'auth'), new NullLogService(), { scryptCost: 1024 }));
		protocolServer = store.add(await RemoteAccessProtocolServer.create());
		server = store.add(await startRemoteAccessServer({
			hosts: ['127.0.0.1'],
			port: 0,
			webRoot,
			auth,
			publicMode: false,
			connector: protocolServer,
			logService: new NullLogService(),
			product: { name: 'CreaEditor', version: '1.0.0' },
			hostName: 'test-mac',
		}));
	});

	teardown(async () => {
		await server.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	function url(path: string): string {
		return `http://127.0.0.1:${server.port}${path}`;
	}

	async function pair(body: object): Promise<{ status: number; json: { deviceKey?: string; error?: string } }> {
		const response = await request(url('/api/pair'), { method: 'POST', body: JSON.stringify(body) });
		return { status: response.status, json: JSON.parse(response.body) };
	}

	test('serves /health without authentication, the page and static files', async () => {
		const health = JSON.parse((await request(url('/health'))).body);
		const page = await request(url('/'));
		const file = await request(url('/static/vs/sessions/sessions.web.main.internal.js'));
		const traversal = await request(url('/static/..%2Fsecret.txt'));

		assert.deepStrictEqual(
			[health.status, health.version, health.webUi, health.publicMode, page.status, page.body.includes('sessions.web.main.internal.js'), file.status, file.contentType, file.body, traversal.status],
			['ok', '1.0.0', true, false, 200, true, 200, 'text/javascript; charset=utf-8', 'export const create = () => { };', 404],
		);
	});

	test('accepts the agent host WebSocket only with a valid device key', async () => {
		const paired = await pair({ code: auth.createPairingCode().code, deviceName: 'Phone' });
		const deviceKey = paired.json.deviceKey!;

		const withoutKey = await connect(url('/ahp').replace('http', 'ws')).then(() => 'open', error => String(error));
		const wrongKey = await connect(`${url('/ahp').replace('http', 'ws')}?${connectionTokenQueryName}=nope.nope`).then(() => 'open', error => String(error));

		const transport = Event.toPromise(protocolServer.onConnection);
		const socket = await connect(`${url('/ahp').replace('http', 'ws')}?${connectionTokenQueryName}=${encodeURIComponent(deviceKey)}`);
		store.add(toDisposable(() => socket.close()));
		await transport;
		const device = JSON.parse((await request(url('/api/device'), { headers: { Authorization: `Bearer ${deviceKey}` } })).body);

		// Signing the device out closes its connection.
		const closed = new Promise<number>(resolve => socket.once('close', code => resolve(code)));
		await auth.revokeDevice(device.id);

		assert.deepStrictEqual(
			[paired.status, withoutKey, wrongKey, device.name, await closed],
			[200, 'Error: Unexpected server response: 403', 'Error: Unexpected server response: 403', 'Phone', 4001],
		);
	});

	test('public mode requires the password to pair', async () => {
		await auth.setPassword('correct horse');
		server.setPublicMode(true);
		const info = JSON.parse((await request(url('/api/info'))).body);
		const code = auth.createPairingCode().code;
		const withoutPassword = await pair({ code, deviceName: 'Phone' });
		const withPassword = await pair({ code, deviceName: 'Phone', password: 'correct horse' });

		assert.deepStrictEqual(
			[info.passwordRequired, withoutPassword.status, withoutPassword.json.error, withPassword.status, typeof withPassword.json.deviceKey],
			[true, 403, 'passwordRequired', 200, 'string'],
		);
	});
});

/** Node's http rather than fetch: the tests run in a renderer, where fetch would be cross-origin. */
async function request(address: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; contentType: string | undefined; body: string }> {
	const http = await import('http');
	return new Promise((resolve, reject) => {
		const req = http.request(address, { method: options.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...options.headers } }, response => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, contentType: response.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', reject);
		});
		req.on('error', reject);
		req.end(options.body);
	});
}

suite('RemoteAccessServer relay', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('relays an authenticated connection to an agent host socket', async () => {
		const dir = getRandomTestPath(tmpdir(), 'vsctests', 'remoteAccessRelay');
		await fs.mkdir(dir, { recursive: true });
		// Unix socket paths are short; keep it in the OS temp folder.
		const socketPath = join(tmpdir(), `ra-${Date.now().toString(36)}.sock`);
		const agentHost = store.add(await WebSocketProtocolServer.create({ socketPath }, new NullLogService()));
		await agentHost.whenListening;
		store.add(agentHost.onConnection(transport => {
			store.add(transport);
			store.add(transport.onMessage(message => transport.send(message)));
		}));
		const auth = store.add(await RemoteAccessAuth.create(join(dir, 'auth'), new NullLogService(), { scryptCost: 1024 }));
		const server = store.add(await startRemoteAccessServer({
			hosts: ['127.0.0.1'],
			port: 0,
			webRoot: undefined,
			auth,
			publicMode: false,
			connector: createSocketRelayConnector(async () => socketPath, new NullLogService()),
			logService: new NullLogService(),
			product: { name: 'CreaEditor', version: '1.0.0' },
			hostName: 'test-mac',
		}));
		try {
			const paired = await auth.pair({ code: auth.createPairingCode().code, deviceName: 'Phone', requirePassword: false, client: 'test' });
			assert.ok(paired.ok);
			const socket = await connect(`ws://127.0.0.1:${server.port}/ahp?${connectionTokenQueryName}=${encodeURIComponent(paired.deviceKey)}`);
			const reply = new Promise<string>(resolve => socket.once('message', data => resolve(String(data))));
			// Sent before the relay reached the agent host: buffered, not lost.
			socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
			assert.deepStrictEqual(JSON.parse(await reply), { jsonrpc: '2.0', method: 'ping' });
			const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
			socket.close();
			await closed;
		} finally {
			await server.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

async function connect(address: string): Promise<wsTypes.WebSocket> {
	const { WebSocket } = await import('ws');
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(address);
		socket.once('open', () => resolve(socket));
		socket.once('error', reject);
	});
}
