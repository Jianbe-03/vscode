/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { getRandomTestPath } from '../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { RemoteAccessAuth } from '../../../platform/agentHost/node/remoteAccess/remoteAccessAuth.js';
import { IRemoteAccessServerHandle, RemoteAccessProtocolServer, startRemoteAccessServer } from '../../../platform/agentHost/node/remoteAccess/remoteAccessServer.js';
import { findServerCostHardStop, SERVER_COST_LEDGER_FILE } from '../../../platform/agentHost/node/shared/serverCostLedger.js';
import { createCreaEditorServerApi } from '../../node/creaeditorServer/creaeditorServerApi.js';

suite('CreaEditor Server API', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let auth: RemoteAccessAuth;
	let server: IRemoteAccessServerHandle;
	let costsDir: string;

	setup(async () => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorServerApi');
		await fs.mkdir(dir, { recursive: true });
		auth = store.add(await RemoteAccessAuth.create(join(dir, 'auth'), new NullLogService(), { scryptCost: 1024 }));
		costsDir = join(dir, 'costs');
		await fs.mkdir(costsDir, { recursive: true });
		server = store.add(await startRemoteAccessServer({
			hosts: ['127.0.0.1'],
			port: 0,
			webRoot: undefined,
			auth,
			publicMode: false,
			connector: store.add(await RemoteAccessProtocolServer.create()),
			logService: new NullLogService(),
			product: { name: 'CreaEditor Server', version: '1.0.0' },
			hostName: 'test-server',
			apiHandlers: [createCreaEditorServerApi({
				costsDir,
				createPairing: () => {
					const pairing = auth.createPairingCode();
					return { code: pairing.code, expiresAt: pairing.expiresAt, link: `http://server/#pair=${pairing.code}` };
				},
				logService: new NullLogService(),
			})],
			getHealthDetails: () => ({ cpuPercent: 12, runningChats: 2, queuedChats: 1, maxRunningChats: 4 }),
		}));
	});

	teardown(async () => {
		await server.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function pairDevice(): Promise<string> {
		const response = await request(server.port, '/api/pair', { method: 'POST', body: JSON.stringify({ code: auth.createPairingCode().code, deviceName: 'Laptop' }) });
		return JSON.parse(response.body).deviceKey;
	}

	test('creates a pairing code only for a paired device, and the code pairs a phone', async () => {
		const deviceKey = await pairDevice();
		const withoutKey = await request(server.port, '/api/server/pairing', { method: 'POST' });
		const wrongKey = await request(server.port, '/api/server/pairing', { method: 'POST', headers: { Authorization: 'Bearer nope.nope' } });
		const created = await request(server.port, '/api/server/pairing', { method: 'POST', headers: { Authorization: `Bearer ${deviceKey}` } });
		const pairing = JSON.parse(created.body);
		const phone = await request(server.port, '/api/pair', { method: 'POST', body: JSON.stringify({ code: pairing.code, deviceName: 'Phone' }) });

		assert.deepStrictEqual(
			[withoutKey.status, wrongKey.status, created.status, pairing.link === `http://server/#pair=${pairing.code}`, phone.status, auth.listDevices().map(device => device.name).sort()],
			[401, 401, 200, true, 200, ['Laptop', 'Phone']],
		);
	});

	test('answers /health minimally without a device key and with details with one', async () => {
		const deviceKey = await pairDevice();
		const anonymous = JSON.parse((await request(server.port, '/health')).body);
		const wrong = JSON.parse((await request(server.port, '/health', { headers: { Authorization: 'Bearer nope.nope' } })).body);
		const paired = JSON.parse((await request(server.port, '/health', { headers: { Authorization: `Bearer ${deviceKey}` } })).body);

		assert.deepStrictEqual(
			[anonymous.status, anonymous.details, wrong.details, paired.details],
			['ok', undefined, undefined, { cpuPercent: 12, runningChats: 2, queuedChats: 1, maxRunningChats: 4 }],
		);
	});

	test('serves new ledger entries incrementally and keeps pushed budgets', async () => {
		const deviceKey = await pairDevice();
		const headers = { Authorization: `Bearer ${deviceKey}` };
		const append = (entry: object) => fs.appendFile(join(costsDir, SERVER_COST_LEDGER_FILE), `${JSON.stringify(entry)}\n`);
		await append({ id: 'a', time: 1000, model: 'a', cost: 0.5, providerGroup: 'Team' });
		const page1 = JSON.parse((await request(server.port, '/api/server/costs?after=0', { headers })).body);
		await append({ id: 'a', time: 1000, model: 'a', cost: 0.75, providerGroup: 'Team' });
		await append({ id: 'b', time: 1001, model: 'b', cost: 1, providerGroup: 'Team' });
		const page2 = JSON.parse((await request(server.port, `/api/server/costs?after=${page1.cursor}`, { headers })).body);
		const unauthorized = await request(server.port, '/api/server/costs?after=0');
		const badBudgets = await request(server.port, '/api/server/costs/budgets', { method: 'PUT', headers, body: '{"budgets":5}' });
		const budgets = await request(server.port, '/api/server/costs/budgets', {
			method: 'PUT', headers, body: JSON.stringify({
				updatedAt: 900,
				budgets: [{ id: 'team', scope: 'key', value: 'Team', amount: 2, period: 'month', hardStop: true, from: 0, to: 5000, spentElsewhere: 0.5 }],
			}),
		});

		assert.deepStrictEqual({
			page1: page1.entries.map((entry: { model: string; cost: number }) => [entry.model, entry.cost]),
			page2: page2.entries.map((entry: { model: string; cost: number }) => [entry.model, entry.cost]),
			cursors: [page1.cursor, page2.cursor],
			unauthorized: unauthorized.status,
			badBudgets: badBudgets.status,
			budgets: budgets.status,
			// 0.5 elsewhere + 0.75 + 1 here = 2.25 >= 2
			hardStop: findServerCostHardStop({ providerGroup: 'Team' }, costsDir, 1000)?.budget.id,
			otherKey: findServerCostHardStop({ providerGroup: 'Other' }, costsDir, 1000),
		}, {
			page1: [['a', 0.5]],
			page2: [['a', 0.75], ['b', 1]],
			cursors: [1000, 1001],
			unauthorized: 401,
			badBudgets: 400,
			budgets: 200,
			hardStop: 'team',
			otherKey: undefined,
		});
	});
});

async function request(port: number, path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: string }> {
	const http = await import('http');
	return new Promise((resolve, reject) => {
		const req = http.request(`http://127.0.0.1:${port}${path}`, { method: options.method ?? 'GET', headers: { 'Content-Type': 'application/json', ...options.headers } }, response => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', reject);
		});
		req.on('error', reject);
		req.end(options.body);
	});
}
