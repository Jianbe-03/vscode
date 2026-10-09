/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: runs Remote Access in the main process, so it survives window reloads and stops when
// the app quits. Devices' agent host connections are relayed to the agent host's on-demand socket,
// so they share the sessions of every window. Keeps the Mac awake while a chat runs.

import { powerSaveBlocker } from 'electron';
import { promises as fs } from 'fs';
import { hostname } from 'os';
import { join } from '../../../base/common/path.js';
import { Sequencer } from '../../../base/common/async.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { equals } from '../../../base/common/objects.js';
import { localize } from '../../../nls.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IRemoteAccessPairing, IRemoteAccessService, IRemoteAccessStatus, REMOTE_ACCESS_DEFAULT_PORT, RemoteAccessEnabledSettingId, RemoteAccessNetwork, RemoteAccessNetworkSettingId, RemoteAccessPortSettingId, RemoteAccessState } from '../common/remoteAccess.js';
import { AgentHostProcessManager } from '../node/agentHostService.js';
import { REMOTE_ACCESS_MIN_PASSWORD_LENGTH, RemoteAccessAuth } from '../node/remoteAccess/remoteAccessAuth.js';
import { createSocketRelayConnector, IRemoteAccessServerHandle, startRemoteAccessServer } from '../node/remoteAccess/remoteAccessServer.js';
import { disableTailscaleFunnel, enableTailscaleFunnel, findTailscaleLink, getTailscaleFunnelUrl, getTailscaleStatus, ITailscaleStatus } from '../node/remoteAccess/tailscale.js';

const STATE_FILE_NAME = 'remote-access-state.json';
const KEEP_AWAKE_POLL_MS = 15_000;
const TAILSCALE_POLL_MS = 60_000;
const LOCALHOST = '127.0.0.1';

interface IPersistedState {
	readonly publicAccess: boolean;
}

interface IServerConfig {
	readonly hosts: readonly string[];
	readonly port: number;
	readonly webRoot: string;
}

export class RemoteAccessMainService extends Disposable implements IRemoteAccessService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<IRemoteAccessStatus>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _storageDir: string;
	private readonly _webRoot: string;
	private readonly _sequencer = new Sequencer();
	private readonly _whileOn = this._register(new DisposableStore());

	private _auth: Promise<RemoteAccessAuth> | undefined;
	private _server: { readonly handle: IRemoteAccessServerHandle; readonly config: IServerConfig } | undefined;
	private _publicAccess: boolean | undefined;
	private _tailscale: ITailscaleStatus = { installed: false, running: false };
	private _publicUrl: string | undefined;
	private _error: string | undefined;
	private _starting = false;
	private _webUi = false;
	private _powerSaveBlockerId: number | undefined;
	private _shuttingDown = false;
	private _status: IRemoteAccessStatus;

	constructor(
		private readonly _agentHostProcessManager: AgentHostProcessManager,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@ILogService private readonly _logService: ILogService,
		@IProductService private readonly _productService: IProductService,
	) {
		super();
		this._storageDir = join(environmentMainService.userDataPath, 'remote-access');
		this._webRoot = join(environmentMainService.appRoot, 'out-sessions-web');
		this._status = this._computeStatus();

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(RemoteAccessEnabledSettingId) || e.affectsConfiguration(RemoteAccessNetworkSettingId) || e.affectsConfiguration(RemoteAccessPortSettingId)) {
				void this._apply();
			}
		}));
		this._register(lifecycleMainService.onWillShutdown(e => {
			this._shuttingDown = true;
			e.join('remoteAccess', this._sequencer.queue(() => this._stop()));
		}));
		this._register(toDisposable(() => this._setKeepAwake(false)));

		void this._apply();
	}

	async getStatus(): Promise<IRemoteAccessStatus> {
		return this._status;
	}

	async createPairing(): Promise<IRemoteAccessPairing> {
		const status = this._status;
		const base = status.publicAccess && status.publicUrl ? status.publicUrl : status.url;
		if (status.state !== RemoteAccessState.On || !base) {
			throw new Error(localize('remoteAccess.notOn', "Turn on Remote Access first."));
		}
		const pairing = (await this._getAuth()).createPairingCode();
		return { code: pairing.code, expiresAt: pairing.expiresAt, url: `${base.replace(/\/$/, '')}/#pair=${encodeURIComponent(pairing.code)}` };
	}

	async signOutDevice(id: string): Promise<void> {
		await (await this._getAuth()).revokeDevice(id);
	}

	async setPassword(password: string | undefined): Promise<void> {
		if (password !== undefined && password.length < REMOTE_ACCESS_MIN_PASSWORD_LENGTH) {
			throw new Error(localize('remoteAccess.passwordTooShort', "Use at least {0} characters.", REMOTE_ACCESS_MIN_PASSWORD_LENGTH));
		}
		if (password === undefined && await this._getPublicAccess()) {
			throw new Error(localize('remoteAccess.passwordNeededForPublic', "Turn off public access before removing the password."));
		}
		await (await this._getAuth()).setPassword(password);
		this._updateStatus();
	}

	setPublicAccess(enabled: boolean): Promise<void> {
		return this._sequencer.queue(async () => {
			if (enabled) {
				await this._enablePublicAccess();
			} else {
				await this._disablePublicAccess();
			}
		});
	}

	async refresh(): Promise<void> {
		await this._apply();
	}

	// ---- Server lifecycle ---------------------------------------------------

	private _apply(): Promise<void> {
		return this._sequencer.queue(() => this._doApply());
	}

	private async _doApply(): Promise<void> {
		if (this._shuttingDown) {
			return;
		}
		const enabled = this._configurationService.getValue<boolean>(RemoteAccessEnabledSettingId) === true;
		if (!enabled) {
			if (await this._getPublicAccess()) {
				// Turning Remote Access off also closes the public door.
				await this._disablePublicAccess();
			}
			await this._stop();
			this._error = undefined;
			this._updateStatus();
			return;
		}

		this._starting = !this._server;
		this._updateStatus();
		const network = this._getNetwork();
		const port = this._getPort();
		const publicAccess = await this._getPublicAccess();
		this._webUi = await exists(join(this._webRoot, 'vs', 'sessions', 'sessions.web.main.internal.js'));
		this._tailscale = await getTailscaleStatus();

		let hosts: string[];
		if (network === RemoteAccessNetwork.Localhost) {
			hosts = [LOCALHOST];
		} else if (this._tailscale.running && this._tailscale.ipv4) {
			// Funnel forwards to 127.0.0.1, so public access also listens there.
			hosts = publicAccess ? [this._tailscale.ipv4, LOCALHOST] : [this._tailscale.ipv4];
		} else {
			await this._stop();
			this._starting = false;
			this._error = this._tailscale.installed
				? localize('remoteAccess.tailscaleNotRunning', "Tailscale is not connected. Open Tailscale and sign in, then try again.")
				: localize('remoteAccess.tailscaleMissing', "Install and sign in to Tailscale to reach this Mac from your other devices.");
			this._updateStatus();
			return;
		}

		const config: IServerConfig = { hosts, port, webRoot: this._webRoot };
		if (!this._server || !equals(this._server.config, config)) {
			await this._stop();
			try {
				const auth = await this._getAuth();
				const handle = await startRemoteAccessServer({
					...config,
					auth,
					publicMode: publicAccess,
					connector: createSocketRelayConnector(async () => {
						const management = await this._agentHostProcessManager.getManagementService(true);
						if (!management) {
							throw new Error('The agent host is not running.');
						}
						return (await management.startWebSocketServer()).socketPath;
					}, this._logService),
					logService: this._logService,
					product: { name: this._productService.nameLong, version: this._productService.version, commit: this._productService.commit },
					hostName: hostname().replace(/\.local$/, ''),
				});
				this._server = { handle, config };
				this._whileOn.add(handle.onDidChangeConnectionCount(() => this._updateStatus()));
				this._whileOn.add(auth.onDidChangeDevices(() => this._updateStatus()));
				this._startPolling();
				this._error = undefined;
			} catch (error) {
				this._logService.error('[RemoteAccess] Could not start', error);
				this._error = (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
					? localize('remoteAccess.portInUse', "Port {0} is already in use. Choose another port in the Remote Access: Port setting.", port)
					: localize('remoteAccess.startFailed', "Remote Access could not start: {0}", error instanceof Error ? error.message : String(error));
			}
		}
		this._server?.handle.setPublicMode(publicAccess);
		if (publicAccess && this._tailscale.cliPath && this._server) {
			this._publicUrl = await getTailscaleFunnelUrl(this._tailscale.cliPath, port);
		} else {
			this._publicUrl = undefined;
		}
		this._starting = false;
		this._updateStatus();
	}

	private async _stop(): Promise<void> {
		this._whileOn.clear();
		this._setKeepAwake(false);
		const server = this._server;
		this._server = undefined;
		this._publicUrl = undefined;
		if (server) {
			await server.handle.close();
		}
	}

	private _startPolling(): void {
		const keepAwake = setInterval(() => void this._checkKeepAwake(), KEEP_AWAKE_POLL_MS);
		this._whileOn.add(toDisposable(() => clearInterval(keepAwake)));
		void this._checkKeepAwake();
		if (this._getNetwork() === RemoteAccessNetwork.Tailscale) {
			// The Tailscale address changes when the Mac signs in to another tailnet.
			const tailscale = setInterval(async () => {
				const current = await getTailscaleStatus(this._tailscale.cliPath);
				if (current.ipv4 !== this._tailscale.ipv4 || current.running !== this._tailscale.running) {
					void this._apply();
				}
			}, TAILSCALE_POLL_MS);
			this._whileOn.add(toDisposable(() => clearInterval(tailscale)));
		}
	}

	private async _checkKeepAwake(): Promise<void> {
		let running = false;
		try {
			// Only ask a running agent host; never start one just to check.
			const management = await this._agentHostProcessManager.getManagementService(false);
			running = (await management?.getActiveSessionCount()) ? true : false;
		} catch (error) {
			this._logService.trace('[RemoteAccess] Could not read the running chats', error);
		}
		if (this._server) {
			this._setKeepAwake(running);
		}
	}

	private _setKeepAwake(keepAwake: boolean): void {
		if (keepAwake && this._powerSaveBlockerId === undefined) {
			this._powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
			this._logService.info('[RemoteAccess] Keeping this Mac awake while chats run');
			this._updateStatus();
		} else if (!keepAwake && this._powerSaveBlockerId !== undefined) {
			powerSaveBlocker.stop(this._powerSaveBlockerId);
			this._powerSaveBlockerId = undefined;
			this._updateStatus();
		}
	}

	// ---- Public access ------------------------------------------------------

	private async _enablePublicAccess(): Promise<void> {
		if (this._configurationService.getValue<boolean>(RemoteAccessEnabledSettingId) !== true || !this._server) {
			throw new Error(localize('remoteAccess.notOn', "Turn on Remote Access first."));
		}
		const tailscale = await getTailscaleStatus();
		if (this._getNetwork() !== RemoteAccessNetwork.Tailscale || !tailscale.running || !tailscale.cliPath) {
			throw new Error(localize('remoteAccess.publicNeedsTailscale', "Public access uses Tailscale Funnel. Use the Tailscale network and sign in to Tailscale first."));
		}
		if (!(await this._getAuth()).hasPassword()) {
			throw new Error(localize('remoteAccess.publicNeedsPassword', "Set a password first: devices must enter it to pair over public access."));
		}
		await this._setPublicAccessState(true);
		await this._doApply(); // listen on 127.0.0.1 for Funnel
		try {
			await enableTailscaleFunnel(tailscale.cliPath, this._getPort());
		} catch (error) {
			await this._setPublicAccessState(false);
			await this._doApply();
			const output = error instanceof Error ? error.message : String(error);
			const link = findTailscaleLink(output);
			this._logService.error('[RemoteAccess] Could not turn on Tailscale Funnel', output);
			throw new Error(link
				? localize('remoteAccess.funnelNeedsApproval', "Tailscale Funnel is not allowed for this Mac yet. Allow it at {0}, then try again.", link)
				: localize('remoteAccess.funnelFailed', "Tailscale Funnel could not be turned on: {0}", output));
		}
		this._logService.info('[RemoteAccess] Public access turned on');
		await this._doApply();
	}

	private async _disablePublicAccess(): Promise<void> {
		await this._setPublicAccessState(false);
		const cli = this._tailscale.cliPath ?? (await getTailscaleStatus()).cliPath;
		if (cli) {
			try {
				await disableTailscaleFunnel(cli);
				this._logService.info('[RemoteAccess] Public access turned off');
			} catch (error) {
				this._logService.error('[RemoteAccess] Could not turn off Tailscale Funnel', error);
			}
		}
		if (this._configurationService.getValue<boolean>(RemoteAccessEnabledSettingId) === true) {
			await this._doApply();
		}
	}

	private async _getPublicAccess(): Promise<boolean> {
		if (this._publicAccess === undefined) {
			try {
				const state = JSON.parse(await fs.readFile(join(this._storageDir, STATE_FILE_NAME), 'utf8')) as Partial<IPersistedState>;
				this._publicAccess = state.publicAccess === true;
			} catch {
				this._publicAccess = false;
			}
		}
		return this._publicAccess;
	}

	private async _setPublicAccessState(publicAccess: boolean): Promise<void> {
		this._publicAccess = publicAccess;
		const state: IPersistedState = { publicAccess };
		await fs.mkdir(this._storageDir, { recursive: true, mode: 0o700 });
		await fs.writeFile(join(this._storageDir, STATE_FILE_NAME), JSON.stringify(state), { mode: 0o600 });
	}

	// ---- Status -------------------------------------------------------------

	private _getAuth(): Promise<RemoteAccessAuth> {
		if (!this._auth) {
			this._auth = RemoteAccessAuth.create(this._storageDir, this._logService).then(auth => this._register(auth));
		}
		return this._auth;
	}

	private _getNetwork(): RemoteAccessNetwork {
		return this._configurationService.getValue<string>(RemoteAccessNetworkSettingId) === RemoteAccessNetwork.Localhost ? RemoteAccessNetwork.Localhost : RemoteAccessNetwork.Tailscale;
	}

	private _getPort(): number {
		const port = this._configurationService.getValue<number>(RemoteAccessPortSettingId);
		return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : REMOTE_ACCESS_DEFAULT_PORT;
	}

	private _updateStatus(): void {
		void this._computeStatusWithAuth().then(status => {
			if (!equals(status, this._status)) {
				this._status = status;
				this._onDidChangeStatus.fire(status);
			}
		});
	}

	private async _computeStatusWithAuth(): Promise<IRemoteAccessStatus> {
		const auth = await this._getAuth();
		return this._computeStatus(auth);
	}

	private _computeStatus(auth?: RemoteAccessAuth): IRemoteAccessStatus {
		const enabled = this._configurationService.getValue<boolean>(RemoteAccessEnabledSettingId) === true;
		const network = this._getNetwork();
		const server = this._server;
		const port = server?.handle.port ?? this._getPort();
		const state = !enabled ? RemoteAccessState.Off
			: server ? RemoteAccessState.On
				: this._starting ? RemoteAccessState.Starting
					: this._error ? RemoteAccessState.Error : RemoteAccessState.Starting;
		const address = network === RemoteAccessNetwork.Localhost ? LOCALHOST : this._tailscale.ipv4;
		return {
			state,
			network,
			port,
			url: server && address ? `http://${address}:${port}` : undefined,
			magicDnsUrl: server && network === RemoteAccessNetwork.Tailscale && this._tailscale.dnsName ? `http://${this._tailscale.dnsName}:${port}` : undefined,
			publicAccess: this._publicAccess === true,
			publicUrl: this._publicUrl,
			tailscale: {
				installed: this._tailscale.installed,
				running: this._tailscale.running,
				backendState: this._tailscale.backendState,
				ipv4: this._tailscale.ipv4,
				dnsName: this._tailscale.dnsName,
			},
			hasPassword: auth?.hasPassword() ?? false,
			keepingAwake: this._powerSaveBlockerId !== undefined,
			connections: server?.handle.connectionCount ?? 0,
			devices: auth?.listDevices() ?? [],
			webUi: this._webUi,
			error: state === RemoteAccessState.Error ? this._error : undefined,
		};
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}
