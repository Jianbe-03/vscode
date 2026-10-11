/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor Server: a headless CreaEditor agent host for laptops and phones. It serves the web Agents
// window, pairing and the authenticated agent host WebSocket (Remote Access, see
// src/vs/platform/agentHost/node/remoteAccess/README.md) and relays paired devices to the agent host,
// which it runs as a supervised child process.
//
// From sources: node out/vs/server/node/creaeditorServer/creaeditorServerMain.js [serve|pair|password|status] [--host <address>] [--port <port>] [--data-dir <folder>]
// Built (see scripts/creaeditor-build-server.sh): bin/creaeditor-server [serve|pair|password|status] ...

import { fileURLToPath } from 'url';

// Like agentHostServerMain, this process may start without bootstrap-esm: set the file root to `out/`.
// This file lives at out/vs/server/node/creaeditorServer/.
globalThis._VSCODE_FILE_ROOT ??= fileURLToPath(new URL('../../../..', import.meta.url));

import * as fs from 'fs';
import * as os from 'os';
import { dirname, join } from '../../../base/common/path.js';
import { ConsoleMainLogger, LogLevel, parseLogLevel } from '../../../platform/log/common/log.js';
import { LogService } from '../../../platform/log/common/logService.js';
import product from '../../../platform/product/common/product.js';
import { FileSecretStore } from '../../../platform/agentHost/node/shared/fileSecretStore.js';
import { readServerChatsStatus } from '../../../platform/agentHost/node/shared/serverChatsStatus.js';
import { RemoteAccessAuth, REMOTE_ACCESS_MIN_PASSWORD_LENGTH } from '../../../platform/agentHost/node/remoteAccess/remoteAccessAuth.js';
import { createSocketRelayConnector, startRemoteAccessServer } from '../../../platform/agentHost/node/remoteAccess/remoteAccessServer.js';
import { callCreaEditorServerAdmin, createCreaEditorServerStatus, ICreaEditorServerStatus, readMachine, readOrCreateAdminToken, startCreaEditorServerAdmin } from './creaeditorServerAdmin.js';
import { CreaEditorAgentHost } from './creaeditorServerAgentHost.js';
import { createCreaEditorServerApi } from './creaeditorServerApi.js';
import { CreaEditorDelegationApi, getCreaEditorDelegationLayout } from './creaeditorServerDelegation.js';
import { AgentHostSessionsWatcher } from './creaeditorServerSessions.js';
import { DelegationWorktreeCleanup } from './creaeditorServerWorktreeCleanup.js';
import { ensureCreaEditorServerDataDir, getCreaEditorServerDataLayout, ICreaEditorServerDataLayout, ICreaEditorServerRuntimeInfo, readCreaEditorServerRuntimeInfo, writePrivateFile } from './creaeditorServerDataDir.js';
import { CREAEDITOR_SERVER_USAGE, CreaEditorServerOptionsError, ICreaEditorServerOptions, parseCreaEditorServerOptions } from './creaeditorServerOptions.js';
import { formatPairingText, getPairingLink, renderTerminalQrCode } from './creaeditorServerPairing.js';

const OUT_DIR = fileURLToPath(new URL('../../../..', import.meta.url));
const ROOT_DIR = dirname(OUT_DIR);
const PRODUCT_NAME = 'CreaEditor Server';

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

/** The web Agents window build: `out-sessions-web/` in a packaged server, else a build in the repository. */
function findWebRoot(): string | undefined {
	const candidates = [process.env['CREAEDITOR_SERVER_WEB_ROOT'], join(ROOT_DIR, 'out-sessions-web'), join(ROOT_DIR, '.build', 'out-sessions-web')];
	return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate));
}

/** The running server of a data folder, or an explanation why there is none. */
function findRunningServer(layout: ICreaEditorServerDataLayout): { readonly info: ICreaEditorServerRuntimeInfo; readonly token: string } | string {
	const info = readCreaEditorServerRuntimeInfo(layout);
	if (!info || !isProcessAlive(info.pid)) {
		return `CreaEditor Server is not running with data folder ${layout.root}. Start it first (creaeditor-server serve), or pass --data-dir.`;
	}
	try {
		return { info, token: fs.readFileSync(layout.adminTokenFile, 'utf8').trim() };
	} catch {
		return `Cannot read ${layout.adminTokenFile}: run this as the user the server runs as.`;
	}
}

async function serve(options: ICreaEditorServerOptions): Promise<void> {
	const layout = getCreaEditorServerDataLayout(options.dataDir);
	ensureCreaEditorServerDataDir(layout);

	const running = readCreaEditorServerRuntimeInfo(layout);
	if (running && running.pid !== process.pid && isProcessAlive(running.pid)) {
		throw new CreaEditorServerOptionsError(`A CreaEditor Server already runs with this data folder (pid ${running.pid}, ${localUrl(running)}).`);
	}

	const logService = new LogService(new ConsoleMainLogger(parseLogLevel(options.logLevel) ?? LogLevel.Info));
	// Creates `secrets/master.key` on first run, before the agent host opens the store.
	new FileSecretStore(layout.secrets);
	// CreaEditor: the code receiver of Delegate to Server; its key pair exists before the agent host
	// starts, which reads it to open the accounts of delegated chats.
	// CreaEditor: the front follows the agent host's chats over its socket (the cleanup of delegated
	// worktrees and Clean Up Server... need their archived state); the agent host starts below.
	let agentHostForSessions: CreaEditorAgentHost | undefined;
	const sessions = new AgentHostSessionsWatcher(async () => {
		if (!agentHostForSessions) {
			throw new Error('The agent host is not started yet.');
		}
		await agentHostForSessions.whenRunning();
		return agentHostForSessions.socketPath;
	}, logService);
	const delegationApi = new CreaEditorDelegationApi({ layout: getCreaEditorDelegationLayout(layout.root, layout.secrets), serverName: os.hostname(), logService, sessions });
	await delegationApi.getKeyPair();

	log(`CreaEditor Server ${version()} starting; data in ${layout.root}`);
	const startedAt = Date.now();
	const agentHost = new CreaEditorAgentHost({
		outDir: OUT_DIR,
		repoRoot: ROOT_DIR,
		layout,
		logLevel: options.logLevel,
		enableCodex: options.enableCodex,
		enableMockAgent: options.enableMockAgent,
		maxRunningChats: options.maxRunningChats,
		serverName: os.hostname(),
		// CreaEditor: the address notifications open (known up front unless the port is picked at random).
		webUrl: options.publicUrl ?? (options.port ? localUrl({ host: options.host, port: options.port }) : undefined),
		log,
	});
	await agentHost.start();
	agentHostForSessions = agentHost;
	const cleanup = new DelegationWorktreeCleanup(delegationApi, sessions, logService);
	sessions.start();
	cleanup.scheduleSweep();
	// After a restart its chat list may have changed while nobody listened.
	agentHost.onDidChangeState(state => {
		if (state === 'running') {
			sessions.start();
			cleanup.scheduleSweep();
		}
	});

	const auth = await RemoteAccessAuth.create(layout.remoteAccess, logService);
	const webRoot = findWebRoot();
	if (!webRoot) {
		log('The web Agents window is not part of this build: browsers see the pairing page only.');
	}
	// Set once the front listens (the pairing link needs its address).
	let createPairing: (() => { code: string; expiresAt: number; link: string }) | undefined;
	const serverApi = createCreaEditorServerApi({
		costsDir: layout.costs,
		createPairing: () => {
			if (!createPairing) {
				throw new Error('The server is still starting.');
			}
			return createPairing();
		},
		logService,
	});
	// For a paired device, `/health` also tells how busy the server is.
	const getHealthDetails = () => {
		const machine = readMachine();
		const chats = readServerChatsStatus(layout.chatsStatusFile);
		return {
			agentHost: agentHost.state,
			cpuPercent: Math.min(100, Math.round(machine.loadAverage / Math.max(1, machine.cores) * 100)),
			cores: machine.cores,
			memoryTotalBytes: machine.totalBytes,
			memoryFreeBytes: machine.freeBytes,
			...(chats ? { runningChats: chats.running, queuedChats: chats.queued, maxRunningChats: chats.max } : { maxRunningChats: options.maxRunningChats }),
		};
	};
	let front;
	try {
		front = await startRemoteAccessServer({
			hosts: [options.host],
			port: options.port,
			webRoot,
			auth,
			publicMode: options.public,
			// The agent host restarts on its own; a connection that comes in meanwhile waits for it.
			connector: createSocketRelayConnector(async () => {
				await agentHost.whenRunning();
				return agentHost.socketPath;
			}, logService),
			logService,
			product: { name: PRODUCT_NAME, version: product.version, commit: product.commit },
			hostName: os.hostname(),
			apiHandlers: [delegationApi, serverApi],
			getHealthDetails,
		});
	} catch (error) {
		cleanup.dispose();
		sessions.dispose();
		await agentHost.stop();
		auth.dispose();
		throw error;
	}

	const baseUrl = options.publicUrl ?? localUrl({ host: options.host, port: front.port });
	createPairing = () => {
		const pairing = auth.createPairingCode();
		const link = getPairingLink(baseUrl, pairing.code);
		writePrivateFile(layout.pairingFile, formatPairingText(link, pairing.code, pairing.expiresAt, undefined));
		return { code: pairing.code, expiresAt: pairing.expiresAt, link };
	};
	const getStatus = (): ICreaEditorServerStatus => createCreaEditorServerStatus({
		version: product.version,
		...(product.commit ? { commit: product.commit } : {}),
		startedAt,
		agentHost: agentHost.state,
		publicMode: front.publicMode,
		hasPassword: auth.hasPassword(),
		pairedDevices: auth.listDevices().length,
		connections: front.connectionCount,
	}, readMachine());
	const admin = await startCreaEditorServerAdmin(readOrCreateAdminToken(layout.adminTokenFile), {
		createPairing,
		setPassword: password => auth.setPassword(password),
		getStatus,
	});

	const info: ICreaEditorServerRuntimeInfo = {
		pid: process.pid,
		host: options.host,
		port: front.port,
		version: product.version,
		startedAt,
		adminPort: admin.port,
		...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
	};
	writePrivateFile(layout.runtimeFile, `${JSON.stringify(info, undefined, '\t')}\n`);
	log(`Listening on ${options.host}:${front.port} (${baseUrl})${options.public ? '; public: pairing needs the password' : ''}`);

	// First run: no device yet, so show how to pair one.
	if (auth.listDevices().length === 0) {
		const pairing = createPairing();
		log(`No device is paired yet. Pairing code ${pairing.code} (also in ${layout.pairingFile}); open ${pairing.link}`);
		if (options.public && !auth.hasPassword()) {
			log('Public mode needs a password before a device can pair: run `creaeditor-server password`.');
		}
	}
	process.stdout.write(`READY:${front.port}\n`);

	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) {
			return;
		}
		stopping = true;
		log(`Stopping (${signal})...`);
		admin.dispose();
		cleanup.dispose();
		sessions.dispose();
		await front.close();
		await agentHost.stop();
		agentHost.dispose();
		auth.dispose();
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
	const running = findRunningServer(layout);
	if (typeof running === 'string') {
		process.stdout.write(`${running}\n`);
		return 3;
	}
	const { info, token } = running;
	process.stdout.write(`CreaEditor Server ${info.version} runs (pid ${info.pid}) at ${localUrl(info)}${info.publicUrl ? ` and ${info.publicUrl}` : ''}.\n`);
	process.stdout.write(`Data folder: ${layout.root}\n`);
	try {
		const state = await callCreaEditorServerAdmin<ICreaEditorServerStatus>(info.adminPort, token, 'GET', '/status');
		const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
		process.stdout.write([
			`Agent host: ${state.agentHost}`,
			`Up: ${Math.round(state.uptimeSeconds / 60)} min`,
			`Public: ${state.publicMode ? `yes (password ${state.hasPassword ? 'set' : 'NOT set'})` : 'no'}`,
			`Paired devices: ${state.pairedDevices}, connected now: ${state.connections}`,
			`CPU: ${state.cpuPercent}% of ${state.cores} cores`,
			`Memory: ${gib(state.memoryTotalBytes - state.memoryFreeBytes)} of ${gib(state.memoryTotalBytes)} GiB in use`,
			'',
		].join('\n'));
		return state.agentHost === 'running' ? 0 : 1;
	} catch (error) {
		process.stdout.write(`It does not answer: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

async function pair(options: ICreaEditorServerOptions): Promise<number> {
	const running = findRunningServer(getCreaEditorServerDataLayout(options.dataDir));
	if (typeof running === 'string') {
		process.stderr.write(`${running}\n`);
		return 3;
	}
	const pairing = await callCreaEditorServerAdmin<{ code: string; expiresAt: number; link: string }>(running.info.adminPort, running.token, 'POST', '/pair');
	const qr = process.stdout.isTTY ? renderTerminalQrCode(pairing.link) : undefined;
	process.stdout.write(formatPairingText(pairing.link, pairing.code, pairing.expiresAt, qr));
	return 0;
}

/** Reads a line from the terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
	return new Promise(resolve => {
		const stdin = process.stdin;
		process.stdout.write(prompt);
		stdin.setRawMode(true);
		stdin.setEncoding('utf8');
		stdin.resume();
		let value = '';
		const done = () => {
			stdin.off('data', onData);
			stdin.setRawMode(false);
			stdin.pause();
			process.stdout.write('\n');
			resolve(value);
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') {
					done();
					return;
				}
				if (char === '\u0003') {
					stdin.setRawMode(false);
					process.exit(130);
				}
				value = char === '\u007f' || char === '\b' ? value.slice(0, -1) : value + char;
			}
		};
		stdin.on('data', onData);
	});
}

async function password(options: ICreaEditorServerOptions): Promise<number> {
	const running = findRunningServer(getCreaEditorServerDataLayout(options.dataDir));
	if (typeof running === 'string') {
		process.stderr.write(`${running}\n`);
		return 3;
	}
	// From a pipe (`echo ... | creaeditor-server password`) or typed twice in a terminal; empty removes it.
	let value: string;
	if (process.stdin.isTTY) {
		value = await readHidden(`New password (at least ${REMOTE_ACCESS_MIN_PASSWORD_LENGTH} characters, empty to remove): `);
		if (value && value !== await readHidden('Again: ')) {
			process.stderr.write('The passwords do not match.\n');
			return 1;
		}
	} else {
		value = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
	}
	if (value && value.length < REMOTE_ACCESS_MIN_PASSWORD_LENGTH) {
		process.stderr.write(`The password needs at least ${REMOTE_ACCESS_MIN_PASSWORD_LENGTH} characters.\n`);
		return 1;
	}
	await callCreaEditorServerAdmin(running.info.adminPort, running.token, 'POST', '/password', { password: value });
	process.stdout.write(value ? 'Password set. Devices pairing over the public address need it.\n' : 'Password removed.\n');
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

	try {
		switch (options.command) {
			case 'help':
				process.stdout.write(CREAEDITOR_SERVER_USAGE);
				return;
			case 'version':
				process.stdout.write(`${version()}\n`);
				return;
			case 'status':
				process.exit(await status(options));
			case 'pair':
				process.exit(await pair(options));
			case 'password':
				process.exit(await password(options));
			case 'serve':
				await serve(options);
				return;
		}
	} catch (error) {
		log(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

main();
