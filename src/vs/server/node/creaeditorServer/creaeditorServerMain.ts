/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor Server: a headless CreaEditor agent host for laptops and phones.
//
// From sources: node out/vs/server/node/creaeditorServer/creaeditorServerMain.js [serve|pair|status] [--host <address>] [--port <port>] [--data-dir <folder>]
// Built (see scripts/creaeditor-build-server.sh): bin/creaeditor-server [serve|pair|status] ...

import { fileURLToPath } from 'url';

// Like agentHostServerMain, this process may start without bootstrap-esm: set the file root to `out/`.
// This file lives at out/vs/server/node/creaeditorServer/.
globalThis._VSCODE_FILE_ROOT ??= fileURLToPath(new URL('../../../..', import.meta.url));

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from '../../../base/common/path.js';
import product from '../../../platform/product/common/product.js';
import { CREAEDITOR_SERVER_HEALTH_PATH, parseCreaEditorServerHealth } from '../../../platform/agentHost/common/creaeditorServer.js';
import { FileSecretStore } from '../../../platform/agentHost/node/shared/fileSecretStore.js';
import { CreaEditorAgentHost } from './creaeditorServerAgentHost.js';
import { ensureCreaEditorServerDataDir, getCreaEditorServerDataLayout, ICreaEditorServerDataLayout, ICreaEditorServerRuntimeInfo, readCreaEditorServerRuntimeInfo, writePrivateFile } from './creaeditorServerDataDir.js';
import { ICreaEditorServerFront, startBasicFront } from './creaeditorServerFront.js';
import { createCreaEditorServerHealth, readMachine } from './creaeditorServerHealth.js';
import { CREAEDITOR_SERVER_USAGE, CreaEditorServerOptionsError, ICreaEditorServerOptions, parseCreaEditorServerOptions } from './creaeditorServerOptions.js';

const OUT_DIR = fileURLToPath(new URL('../../../..', import.meta.url));

function log(message: string): void {
	process.stderr.write(`[${new Date().toISOString()}] [CreaEditor Server] ${message}\n`);
}

function version(): string {
	return `${product.version}${product.commit ? ` (${product.commit.slice(0, 10)})` : ''}`;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** The address to reach the server at from this machine. */
function localUrl(info: Pick<ICreaEditorServerRuntimeInfo, 'host' | 'port'>): string {
	const host = info.host === '0.0.0.0' || info.host === '::' ? '127.0.0.1' : info.host;
	return `http://${host.includes(':') ? `[${host}]` : host}:${info.port}`;
}

/** The access token of the basic front, created on first run. */
function readOrCreateAccessToken(layout: ICreaEditorServerDataLayout): string {
	const file = join(layout.remoteAccess, 'access-token');
	try {
		const token = fs.readFileSync(file, 'utf8').trim();
		if (token) {
			return token;
		}
	} catch {
		// First run.
	}
	const token = randomBytes(32).toString('base64url');
	writePrivateFile(file, `${token}\n`);
	return token;
}

/** Writes the pairing link to `pairing.txt` (0600) and the log. */
function writePairingInfo(layout: ICreaEditorServerDataLayout, baseUrl: string, accessToken: string): void {
	// TODO(CreaEditor remote access): a one-time pairing code that is exchanged for a device key.
	const link = `${baseUrl}/?tkn=${accessToken}`;
	writePrivateFile(layout.pairingFile, [
		'CreaEditor Server pairing link (keep it private: it gives access to this server).',
		'In CreaEditor: Agents window > Add CreaEditor Server, and paste this link.',
		'',
		link,
		'',
	].join('\n'));
	log(`Pairing link written to ${layout.pairingFile}. Run 'creaeditor-server pair' to show it.`);
}

async function serve(options: ICreaEditorServerOptions): Promise<void> {
	const layout = getCreaEditorServerDataLayout(options.dataDir);
	ensureCreaEditorServerDataDir(layout);

	const running = readCreaEditorServerRuntimeInfo(layout);
	if (running && running.pid !== process.pid && isProcessAlive(running.pid)) {
		throw new CreaEditorServerOptionsError(`A CreaEditor Server already runs with this data folder (pid ${running.pid}, ${localUrl(running)}).`);
	}

	// Creates `secrets/master.key` on first run, before the agent host opens the store.
	new FileSecretStore(layout.secrets);
	const accessToken = readOrCreateAccessToken(layout);

	log(`CreaEditor Server ${version()} starting; data in ${layout.root}`);
	const startedAt = Date.now();
	const agentHost = new CreaEditorAgentHost({
		outDir: OUT_DIR,
		repoRoot: dirname(OUT_DIR),
		layout,
		logLevel: options.logLevel,
		enableCodex: options.enableCodex,
		enableMockAgent: options.enableMockAgent,
		log,
	});
	await agentHost.start();

	let front: ICreaEditorServerFront;
	try {
		front = await startBasicFront({
			host: options.host,
			port: options.port,
			accessToken,
			getAgentHost: () => agentHost.endpoint,
			getHealth: current => createCreaEditorServerHealth({
				version: product.version,
				commit: product.commit,
				startedAt,
				agentHost: agentHost.state,
				connectedClients: current.connectedClients,
			}, readMachine()),
			log,
		});
	} catch (error) {
		await agentHost.stop();
		throw error;
	}

	const info: ICreaEditorServerRuntimeInfo = {
		pid: process.pid,
		host: options.host,
		port: front.port,
		version: product.version,
		startedAt,
		...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
	};
	writePrivateFile(layout.runtimeFile, `${JSON.stringify(info, undefined, '\t')}\n`);
	const baseUrl = options.publicUrl ?? localUrl(info);
	if (!fs.existsSync(layout.pairingFile)) {
		writePairingInfo(layout, baseUrl, accessToken);
	}
	log(`Listening on ${options.host}:${front.port} (${baseUrl}); health at ${baseUrl}${CREAEDITOR_SERVER_HEALTH_PATH}`);
	process.stdout.write(`READY:${front.port}\n`);

	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) {
			return;
		}
		stopping = true;
		log(`Stopping (${signal})...`);
		front.dispose();
		await agentHost.stop();
		agentHost.dispose();
		try {
			if (readCreaEditorServerRuntimeInfo(layout)?.pid === process.pid) {
				fs.rmSync(layout.runtimeFile, { force: true });
			}
		} catch {
			// Best effort.
		}
		process.exit(0);
	};
	process.on('SIGTERM', () => void stop('SIGTERM'));
	process.on('SIGINT', () => void stop('SIGINT'));
}

async function status(options: ICreaEditorServerOptions): Promise<number> {
	const layout = getCreaEditorServerDataLayout(options.dataDir);
	const info = readCreaEditorServerRuntimeInfo(layout);
	if (!info || !isProcessAlive(info.pid)) {
		process.stdout.write(`CreaEditor Server is not running (data folder ${layout.root}).\n`);
		return 3;
	}
	const url = localUrl(info);
	process.stdout.write(`CreaEditor Server ${info.version} runs (pid ${info.pid}) at ${url}${info.publicUrl ? ` and ${info.publicUrl}` : ''}.\n`);
	process.stdout.write(`Data folder: ${layout.root}\n`);
	try {
		const response = await fetch(`${url}${CREAEDITOR_SERVER_HEALTH_PATH}`, { signal: AbortSignal.timeout(5000) });
		const health = parseCreaEditorServerHealth(await response.json());
		if (!health) {
			process.stdout.write('Its health endpoint did not answer like a CreaEditor Server.\n');
			return 1;
		}
		const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
		process.stdout.write([
			`Agent host: ${health.agentHost}`,
			`Up: ${Math.round(health.uptimeSeconds / 60)} min`,
			`CPU: ${health.cpu.percent}% of ${health.cpu.cores} cores`,
			`Memory: ${gib(health.memory.totalBytes - health.memory.freeBytes)} of ${gib(health.memory.totalBytes)} GiB in use`,
			...(health.connectedClients !== undefined ? [`Connected clients: ${health.connectedClients}`] : []),
			...(health.runningChats !== undefined ? [`Running chats: ${health.runningChats}`] : []),
			'',
		].join('\n'));
		return health.ok ? 0 : 1;
	} catch (error) {
		process.stdout.write(`Its health endpoint does not answer: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

function pair(options: ICreaEditorServerOptions): number {
	const layout = getCreaEditorServerDataLayout(options.dataDir);
	ensureCreaEditorServerDataDir(layout);
	const info = readCreaEditorServerRuntimeInfo(layout);
	const baseUrl = options.publicUrl ?? info?.publicUrl ?? localUrl(info ?? { host: options.host, port: options.port });
	writePairingInfo(layout, baseUrl, readOrCreateAccessToken(layout));
	process.stdout.write(fs.readFileSync(layout.pairingFile, 'utf8'));
	return 0;
}

async function main(): Promise<void> {
	let options: ICreaEditorServerOptions;
	try {
		options = parseCreaEditorServerOptions(process.argv.slice(2), {
			env: process.env,
			platform: process.platform,
			homeDir: os.homedir(),
			inDocker: process.env['CREAEDITOR_SERVER_DOCKER'] === '1' || fs.existsSync('/.dockerenv'),
		});
	} catch (error) {
		if (error instanceof CreaEditorServerOptionsError) {
			process.stderr.write(`${error.message}\n\n${CREAEDITOR_SERVER_USAGE}`);
			process.exit(2);
		}
		throw error;
	}

	switch (options.command) {
		case 'help':
			process.stdout.write(CREAEDITOR_SERVER_USAGE);
			return;
		case 'version':
			process.stdout.write(`${version()}\n`);
			return;
		case 'status':
			process.exit(await status(options));
			return;
		case 'pair':
			process.exit(pair(options));
			return;
		case 'serve':
			try {
				await serve(options);
			} catch (error) {
				log(error instanceof Error ? error.message : String(error));
				process.exit(1);
			}
			return;
	}
}

main();
