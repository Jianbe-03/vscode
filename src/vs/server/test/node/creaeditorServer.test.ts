/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { FileAccess } from '../../../base/common/network.js';
import { join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { parseCreaEditorServerHealth, parseCreaEditorServerPairResponse } from '../../../platform/agentHost/common/creaeditorServer.js';
import { redactConnectionTokens } from '../../node/creaeditorServer/creaeditorServerAgentHost.js';
import { createCreaEditorServerStatus } from '../../node/creaeditorServer/creaeditorServerAdmin.js';
import { getPairingLink, renderTerminalQrCode } from '../../node/creaeditorServer/creaeditorServerPairing.js';
import { CreaEditorServerOptionsError, ICreaEditorServerEnvironment, parseCreaEditorServerOptions } from '../../node/creaeditorServer/creaeditorServerOptions.js';

suite('CreaEditor Server', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const mac: ICreaEditorServerEnvironment = { env: {}, platform: 'darwin', homeDir: '/Users/me', inDocker: false };
	const docker: ICreaEditorServerEnvironment = { env: {}, platform: 'linux', homeDir: '/root', inDocker: true };

	test('reads the command line, environment variables and defaults', () => {
		assert.deepStrictEqual([
			parseCreaEditorServerOptions([], mac),
			parseCreaEditorServerOptions([], docker),
			parseCreaEditorServerOptions(['pair', '--port=4000', '--data-dir', '/srv/ce', '--disable-codex'], mac),
			parseCreaEditorServerOptions(['status'], { ...docker, env: { CREAEDITOR_SERVER_PUBLIC_URL: '', CREAEDITOR_SERVER_PORT: '5000', CREAEDITOR_PUBLIC_DOMAIN: 'agents.example.com', CREAEDITOR_SERVER_CODEX: '0' } }),
			parseCreaEditorServerOptions(['--host', '100.64.0.2', '--public-url', 'https://box.tail1234.ts.net/', '--help'], mac),
		], [
			{ command: 'serve', host: '127.0.0.1', port: 31600, dataDir: '/Users/me/.creaeditor-server', logLevel: 'info', public: false, enableCodex: true, enableMockAgent: false },
			{ command: 'serve', host: '0.0.0.0', port: 31600, dataDir: '/data', logLevel: 'info', public: false, enableCodex: true, enableMockAgent: false },
			{ command: 'pair', host: '127.0.0.1', port: 4000, dataDir: '/srv/ce', logLevel: 'info', public: false, enableCodex: false, enableMockAgent: false },
			{ command: 'status', host: '0.0.0.0', port: 5000, dataDir: '/data', logLevel: 'info', publicUrl: 'https://agents.example.com', public: true, enableCodex: false, enableMockAgent: false },
			{ command: 'help', host: '100.64.0.2', port: 31600, dataDir: '/Users/me/.creaeditor-server', logLevel: 'info', publicUrl: 'https://box.tail1234.ts.net', public: false, enableCodex: true, enableMockAgent: false },
		]);
	});

	test('refuses bad command lines', () => {
		const errors = [
			['--port', 'abc'],
			['--port', '70000'],
			['--port'],
			['--host', '--port'],
			['--log', 'loud'],
			['--public-url', 'agents.example.com'],
			['--nope'],
			['start'],
			['--enable-codex', '--disable-codex'],
		].map(argv => {
			try {
				parseCreaEditorServerOptions(argv, mac);
				return 'accepted';
			} catch (error) {
				return error instanceof CreaEditorServerOptionsError ? 'refused' : 'crashed';
			}
		});
		assert.deepStrictEqual(errors, Array(9).fill('refused'));
	});

	test('reports its status, hides agent host tokens in logs and draws pairing QR codes', () => {
		const status = createCreaEditorServerStatus(
			{ version: '1.140.0', commit: 'abc', startedAt: 1_000, agentHost: 'running', publicMode: true, hasPassword: true, pairedDevices: 2, connections: 1 },
			{ platform: 'linux', arch: 'x64', cores: 4, loadAverage: 2, totalBytes: 8, freeBytes: 2, now: 61_000 },
		);
		const qr = renderTerminalQrCode(getPairingLink('https://agents.example.com/', 'ABCDE-12345')).split('\n');
		assert.deepStrictEqual({
			status,
			redacted: redactConnectionTokens('Local: ws://127.0.0.1:5000?tkn=secret-123&x=1'),
			link: getPairingLink('https://agents.example.com/', 'ABCDE-12345'),
			qrSquare: qr.every(line => line.length === qr[0].length) && qr[0].length === qr.length * 2 - 1,
		}, {
			status: {
				version: '1.140.0', commit: 'abc', agentHost: 'running', publicMode: true, hasPassword: true, pairedDevices: 2, connections: 1,
				platform: 'linux', arch: 'x64', uptimeSeconds: 60, cpuPercent: 50, cores: 4, memoryTotalBytes: 8, memoryFreeBytes: 2,
			},
			redacted: 'Local: ws://127.0.0.1:5000?tkn=***&x=1',
			link: 'https://agents.example.com/#pair=ABCDE-12345',
			qrSquare: true,
		});
	});

	// Starts the real server main from `out/` with a scripted agent. It needs a Node.js binary (the tests
	// run in Electron); it uses `.tools/node` of this repository when present.
	const nodeBinary = !process.versions.electron ? process.execPath : [join(FileAccess.asFileUri('').fsPath, '..', '.tools', 'node', 'bin', 'node')].find(candidate => !isWindows && fs.existsSync(candidate));
	(nodeBinary ? test : test.skip)('starts on 127.0.0.1, pairs a device and relays it to the agent host', async function () {
		this.timeout(60_000);
		const dataDir = fs.mkdtempSync(join(tmpdir(), 'creaeditor-server-'));
		const home = fs.mkdtempSync(join(tmpdir(), 'creaeditor-server-home-'));
		const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, VSCODE_AGENT_HOST_CLAUDE_AGENT_ENABLED: 'false' };
		delete env.ELECTRON_RUN_AS_NODE;
		const main = FileAccess.asFileUri('vs/server/node/creaeditorServer/creaeditorServerMain.js').fsPath;
		const server = spawn(nodeBinary!, [main, '--host', '127.0.0.1', '--port', '0', '--data-dir', dataDir, '--disable-codex', '--enable-mock-agent'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
		try {
			const port = await new Promise<number>((resolve, reject) => {
				let output = '';
				server.stdout.on('data', (data: Buffer) => {
					output += data.toString();
					const match = /READY:(?<port>\d+)/.exec(output);
					if (match?.groups) {
						resolve(Number(match.groups.port));
					}
				});
				server.on('exit', code => reject(new Error(`The server stopped (code ${code}).`)));
			});
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			const health = parseCreaEditorServerHealth(await response.json());
			const info = JSON.parse(fs.readFileSync(join(dataDir, 'server.json'), 'utf8'));
			const adminToken = fs.readFileSync(join(dataDir, 'remote-access', 'admin-token'), 'utf8').trim();
			const pairing = await (await fetch(`http://127.0.0.1:${info.adminPort}/pair`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` } })).json();
			const unauthorized = await fetch(`http://127.0.0.1:${info.adminPort}/pair`, { method: 'POST' });
			const paired = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', body: JSON.stringify({ code: pairing.code, deviceName: 'Test' }) });
			const pairResult = parseCreaEditorServerPairResponse(paired.status, await paired.json());
			// The paired device reaches the agent host through the relay.
			const ahpAnswer = pairResult.ok ? await new Promise<string>((resolve, reject) => {
				const socket = new WebSocket(`ws://127.0.0.1:${port}/ahp?tkn=${encodeURIComponent(pairResult.deviceKey)}`);
				socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersions: ['0.0.1'], clientId: 'test' } }));
				socket.onmessage = event => {
					socket.close();
					resolve(String(event.data));
				};
				socket.onerror = () => reject(new Error('WebSocket failed'));
			}) : '';
			assert.deepStrictEqual({
				status: response.status,
				product: health?.product,
				unauthorized: unauthorized.status,
				paired: pairResult.ok,
				ahpAnswered: JSON.parse(ahpAnswer).id,
				files: ['pairing.txt', 'server.json', 'secrets/master.key'].map(file => fs.existsSync(join(dataDir, file))),
			}, { status: 200, product: 'CreaEditor Server', unauthorized: 401, paired: true, ahpAnswered: 1, files: [true, true, true] });
		} finally {
			if (server.exitCode === null && server.signalCode === null) {
				const exited = new Promise(resolve => server.once('exit', resolve));
				server.kill('SIGTERM');
				await exited;
			}
			fs.rmSync(dataDir, { recursive: true, force: true });
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});
