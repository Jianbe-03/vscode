/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the CreaEditor Server runs the standalone agent host (`agentHostServerMain`) as a child
// process on 127.0.0.1 with a private connection token, and restarts it when it stops. The server's
// front (web page, pairing, device keys) is the only way in from the network.

import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { AGENT_HOST_SECRETS_DIR_ENV_VAR } from '../../../platform/agentHost/node/shared/fileSecretStore.js';
import { AGENT_HOST_HEADLESS_SIGN_IN_ENV_VAR } from '../../../platform/agentHost/node/shared/subscriptionAccountsService.js';
import { AgentHostCodexAgentEnabledEnvVar } from '../../../platform/agentHost/common/agentService.js';
import { ICreaEditorServerDataLayout, writePrivateFile } from './creaeditorServerDataDir.js';

export type CreaEditorAgentHostState = 'starting' | 'running' | 'restarting' | 'stopped';

/** Where the running agent host listens, for the server's front. */
export interface ICreaEditorAgentHostEndpoint {
	readonly host: '127.0.0.1';
	readonly port: number;
	readonly connectionToken: string;
}

export interface ICreaEditorAgentHostOptions {
	/** The `out` folder with `bootstrap-fork.js`. */
	readonly outDir: string;
	/** The folder with `remote/node_modules`, to load native modules built for Node when running from sources. */
	readonly repoRoot: string;
	readonly layout: ICreaEditorServerDataLayout;
	readonly logLevel: string;
	readonly enableCodex: boolean;
	readonly enableMockAgent: boolean;
	readonly log: (message: string) => void;
}

/** After this many quick crashes in a row the server stops restarting the agent host. */
const MAX_QUICK_RESTARTS = 5;
/** A run longer than this resets the crash count. */
const STABLE_RUN_MS = 60_000;

/** Removes connection tokens from a log line of the agent host. */
export function redactConnectionTokens(line: string): string {
	return line.replace(/([?&]tkn=)[^\s&]+/g, '$1***');
}

/** Starts the agent host and keeps it running until disposed. */
export class CreaEditorAgentHost extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<CreaEditorAgentHostState>());
	readonly onDidChangeState: Event<CreaEditorAgentHostState> = this._onDidChangeState.event;

	private _state: CreaEditorAgentHostState = 'stopped';
	private _child: ChildProcess | undefined;
	private _endpoint: ICreaEditorAgentHostEndpoint | undefined;
	private _quickRestarts = 0;
	private _disposed = false;
	private _restartTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _connectionToken: string;

	constructor(private readonly _options: ICreaEditorAgentHostOptions) {
		super();
		this._connectionToken = randomBytes(32).toString('base64url');
		writePrivateFile(_options.layout.agentHostTokenFile, this._connectionToken);
	}

	get state(): CreaEditorAgentHostState {
		return this._state;
	}

	/** Where the agent host listens while it runs. */
	get endpoint(): ICreaEditorAgentHostEndpoint | undefined {
		return this._state === 'running' ? this._endpoint : undefined;
	}

	/** Process id of the agent host while it runs. */
	get pid(): number | undefined {
		return this._child?.pid;
	}

	/** Starts the agent host; resolves once it listens (or rejects when its first start fails). */
	start(): Promise<ICreaEditorAgentHostEndpoint> {
		this._setState('starting');
		return this._spawn();
	}

	private _spawn(): Promise<ICreaEditorAgentHostEndpoint> {
		const { outDir, repoRoot, layout, logLevel, enableCodex, enableMockAgent, log } = this._options;
		const bootstrap = join(outDir, 'bootstrap-fork.js');
		const nlsMessages = join(outDir, 'nls.messages.json');
		const fromSources = !fs.existsSync(nlsMessages);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			VSCODE_ESM_ENTRYPOINT: 'vs/platform/agentHost/node/agentHostServerMain',
			VSCODE_PARENT_PID: String(process.pid),
			VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
			[AGENT_HOST_SECRETS_DIR_ENV_VAR]: layout.secrets,
			[AGENT_HOST_HEADLESS_SIGN_IN_ENV_VAR]: '1',
			[AgentHostCodexAgentEnabledEnvVar]: enableCodex ? 'true' : 'false',
		};
		delete env['ELECTRON_RUN_AS_NODE'];
		if (fromSources) {
			env['VSCODE_DEV'] = '1';
			env['VSCODE_DEV_INJECT_NODE_MODULE_LOOKUP_PATH'] = join(repoRoot, 'remote', 'node_modules');
		} else {
			env['VSCODE_NLS_CONFIG'] = JSON.stringify({ userLocale: 'en', osLocale: 'en', resolvedLanguage: 'en', defaultMessagesFile: nlsMessages, locale: 'en', availableLanguages: {} });
		}
		const args = [
			bootstrap,
			'--host', '127.0.0.1',
			'--port', '0',
			'--connection-token-file', layout.agentHostTokenFile,
			'--user-data-dir', layout.agentHost,
			'--log', logLevel,
			...(enableMockAgent ? ['--enable-mock-agent'] : []),
		];
		const child = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
		this._child = child;
		const startedAt = Date.now();

		return new Promise<ICreaEditorAgentHostEndpoint>((resolve, reject) => {
			let ready = false;
			let stdout = '';
			child.stdout?.on('data', (data: Buffer) => {
				stdout += data.toString();
				const match = /READY:(?<port>\d+)/.exec(stdout);
				if (!ready && match?.groups) {
					ready = true;
					this._endpoint = { host: '127.0.0.1', port: Number(match.groups.port), connectionToken: this._connectionToken };
					this._setState('running');
					log(`Agent host running (pid ${child.pid}).`);
					resolve(this._endpoint);
				}
				if (stdout.length > 4096) {
					stdout = stdout.slice(-256);
				}
			});
			child.stderr?.on('data', (data: Buffer) => {
				for (const line of data.toString().split(/\r?\n/)) {
					if (line.trim()) {
						log(`[agent host] ${redactConnectionTokens(line)}`);
					}
				}
			});
			child.on('error', error => {
				log(`Agent host could not start: ${error.message}`);
			});
			child.on('exit', (code, signal) => {
				if (this._child === child) {
					this._child = undefined;
					this._endpoint = undefined;
				}
				if (this._disposed) {
					this._setState('stopped');
					return;
				}
				log(`Agent host stopped (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`);
				if (!ready) {
					reject(new Error(`The agent host stopped before it was ready (code ${code ?? 'none'}).`));
				}
				this._scheduleRestart(Date.now() - startedAt);
			});
		});
	}

	private _scheduleRestart(ranFor: number): void {
		this._quickRestarts = ranFor > STABLE_RUN_MS ? 0 : this._quickRestarts + 1;
		if (this._quickRestarts > MAX_QUICK_RESTARTS) {
			this._options.log('The agent host keeps stopping; not restarting it again. Check the logs, then restart the server.');
			this._setState('stopped');
			return;
		}
		this._setState('restarting');
		const delay = Math.min(30_000, 1000 * 2 ** (this._quickRestarts - 1));
		this._restartTimer = setTimeout(() => {
			this._restartTimer = undefined;
			this._spawn().catch(() => { /* the exit handler schedules the next attempt */ });
		}, delay);
	}

	private _setState(state: CreaEditorAgentHostState): void {
		if (this._state !== state) {
			this._state = state;
			this._onDidChangeState.fire(state);
		}
	}

	/** Stops the agent host and waits (up to `timeoutMs`) for it to finish writing its chats. */
	async stop(timeoutMs = 8000): Promise<void> {
		this._disposed = true;
		if (this._restartTimer) {
			clearTimeout(this._restartTimer);
			this._restartTimer = undefined;
		}
		const child = this._child;
		if (!child || child.exitCode !== null) {
			this._setState('stopped');
			return;
		}
		const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
		// The agent host drains its providers and persistence on SIGTERM.
		child.kill('SIGTERM');
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
		await exited;
		clearTimeout(timer);
	}

	override dispose(): void {
		this._disposed = true;
		if (this._restartTimer) {
			clearTimeout(this._restartTimer);
		}
		this._child?.kill('SIGTERM');
		super.dispose();
	}
}
