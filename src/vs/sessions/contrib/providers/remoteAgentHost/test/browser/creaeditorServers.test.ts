/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { RemoteAgentHostConnectionStatus } from '../../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { describeCreaEditorServer, parseStoredCreaEditorServers } from '../../browser/creaeditorServers.js';
import { buildCreaEditorServerSshScript, parseCreaEditorServerInstallOutput } from '../../browser/creaeditorServerSshInstall.js';

suite('CreaEditor Servers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const health = { product: 'CreaEditor Server', version: '1.140.0', publicMode: false, webUi: true, uptimeSeconds: 60 };
	const machine = { cpuPercent: 12, cores: 8, memoryTotalBytes: 16 * 1024 ** 3, memoryFreeBytes: 12 * 1024 ** 3, updatedAt: 0 };

	test('keeps only well-formed stored servers', () => {
		assert.deepStrictEqual([
			parseStoredCreaEditorServers(undefined),
			parseStoredCreaEditorServers('not json'),
			parseStoredCreaEditorServers(JSON.stringify([
				{ id: 'a', name: 'Box', serverUrl: 'http://100.64.0.2:31600', deviceId: 'd1', addedAt: 1, deviceKey: 'never stored' },
				{ id: 'b', name: 'Broken' },
			])),
		], [
			[],
			[],
			[{ id: 'a', name: 'Box', serverUrl: 'http://100.64.0.2:31600', deviceId: 'd1', addedAt: 1 }],
		]);
	});

	test('describes each server state', () => {
		const now = 10 * 60 * 1000;
		const views = [
			describeCreaEditorServer({ health: { reachable: true, health, lastSeen: now }, connection: RemoteAgentHostConnectionStatus.connected, machine, runningChats: 2 }, now),
			describeCreaEditorServer({ health: { reachable: false, health, lastSeen: now - 5 * 60 * 1000 }, connection: RemoteAgentHostConnectionStatus.disconnected, machine, runningChats: 2 }, now),
			describeCreaEditorServer({ health: { reachable: true, health: { ...health, publicMode: true }, lastSeen: now }, connection: RemoteAgentHostConnectionStatus.connecting, machine: undefined, runningChats: undefined }, now),
			describeCreaEditorServer({ health: undefined, connection: undefined, machine: undefined, runningChats: undefined }, now),
			describeCreaEditorServer({ health: { reachable: true, health, lastSeen: now }, connection: RemoteAgentHostConnectionStatus.disconnected, machine: undefined, runningChats: undefined }, now),
		];
		assert.deepStrictEqual(views.map(view => ({ icon: view.icon.id, status: view.status, details: view.details })), [
			{ icon: 'server', status: 'Online', details: ['Version 1.140.0', 'CPU 12% of 8 cores', 'Memory 4.0 of 16.0 GB', '2 chats running'] },
			{ icon: 'debug-disconnect', status: 'Offline, last seen 5 mins ago', details: ['Version 1.140.0'] },
			{ icon: 'loading', status: 'Online, connecting...', details: ['Version 1.140.0', 'Public'] },
			{ icon: 'loading', status: 'Checking...', details: [] },
			{ icon: 'warning', status: 'Online, not connected', details: ['Version 1.140.0'] },
		]);
	});

	test('builds the SSH install scripts and reads the pairing link they print', () => {
		const docker = buildCreaEditorServerSshScript({ kind: 'docker', image: `my'image` }, 'tailscale');
		const tarball = buildCreaEditorServerSshScript({ kind: 'tarball', remoteTarball: '/tmp/ce.tar.gz' }, 'all', 4000);
		const download = buildCreaEditorServerSshScript({ kind: 'download', downloadUrl: 'https://downloads.example.com/ce/' }, 'local');
		const output = [
			'CreaEditor Server 1.140.0 runs (pid 12) at http://100.64.0.2:31600.',
			'Pair a laptop or phone with this CreaEditor Server:',
			'',
			'  Pairing code: ABCDE-12345 (works once, for 10 minutes)',
			'  Link:         http://100.64.0.2:31600/#pair=ABCDE-12345',
		].join('\n');
		assert.deepStrictEqual({
			dockerQuotesImage: docker.includes(`IMAGE='my'\\''image'`),
			dockerPublishes: docker.includes('-p "$HOST:$PORT:31600"') && docker.includes('docker exec creaeditor-server creaeditor-server pair'),
			tarballInstalls: tarball.includes(`tar -xzf '/tmp/ce.tar.gz' -C "$DIR"`) && tarball.includes('PORT=4000') && tarball.includes('install.sh" --host "$HOST" --port "$PORT"'),
			downloadUrl: download.includes(`curl -fsSL 'https://downloads.example.com/ce'"/creaeditor-server-$OS-$ARCH.tar.gz"`),
			parsed: parseCreaEditorServerInstallOutput(output),
			nothing: parseCreaEditorServerInstallOutput('Installing failed'),
		}, {
			dockerQuotesImage: true,
			dockerPublishes: true,
			tarballInstalls: true,
			downloadUrl: true,
			parsed: { baseUrl: 'http://100.64.0.2:31600', pairingCode: 'ABCDE-12345', suggestedName: '100.64.0.2' },
			nothing: undefined,
		});
	});
});
