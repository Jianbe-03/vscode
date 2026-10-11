/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: keeps the paired CreaEditor Servers (list in application storage, device keys in secret
// storage), checks their `/health`, and makes each one a remote agent host of the kind
// `RemoteAgentHostEntryType.CreaEditorServer` whose connection token is the device key. HTTP goes
// through ICreaEditorServerHttpService (the main process on desktop: renderer fetch is blocked by CORS
// and the window CSP). A server that no longer knows this computer's device key (it signed this
// computer out, or its data was wiped) answers 401/403: the server then needs pairing again, and its
// agent host connection stops (no reconnect attempts with a dead key).

import { IntervalTimer } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { derived, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { AgentHostProtocolClient } from '../../../../../platform/agentHost/browser/agentHostProtocolClient.js';
import { WebSocketClientTransport } from '../../../../../platform/agentHost/browser/webSocketClientTransport.js';
import { agentsWindowAgentHostClientInfo } from '../../../../../platform/agentHost/common/agentHostClientInfo.js';
import { CREAEDITOR_SERVER_API_BUDGETS, CREAEDITOR_SERVER_API_COSTS, CREAEDITOR_SERVER_API_PAIRING, CREAEDITOR_SERVER_API_PREFIX, ICreaEditorServerCostsResponse, ICreaEditorServerPairingResponse, IServerCostBudgets } from '../../../../../platform/agentHost/common/creaeditorCosts.js';
import { ICreaEditorServerHttpService } from '../../../../../platform/agentHost/common/creaeditorServerHttp.js';
import { CREAEDITOR_SERVER_HEALTH_PATH, CREAEDITOR_SERVER_PAIR_PATH, CreaEditorServerPairResult, getCreaEditorServerAgentHostAddress, parseCreaEditorServerHealth, parseCreaEditorServerInput, parseCreaEditorServerPairResponse } from '../../../../../platform/agentHost/common/creaeditorServer.js';
import { getEntryAddress, IRemoteAgentHostConnectionFactory, IRemoteAgentHostConnectOptions, IRemoteAgentHostCreatedConnection, IRemoteAgentHostEntry, IRemoteAgentHostService, RemoteAgentHostConnectionStatus, RemoteAgentHostEntryType } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { CREAEDITOR_SERVERS_STORAGE_KEY, getCreaEditorServerDeviceKeyName, ICreaEditorServer, ICreaEditorServerCheck, ICreaEditorServerHealthState, ICreaEditorServersService, parseStoredCreaEditorServers } from './creaeditorServers.js';
import { pairAgainWithCreaEditorServer } from './creaeditorServerPairFlow.js';
import { EntryDrivenProviderContribution, IEntryDrivenProviderOptions } from './entryDrivenProviderContribution.js';

/** How often the servers' `/health` is checked while the window has focus. */
const HEALTH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** How often the device key of a server whose connection fails is checked at most. */
const DEVICE_KEY_CHECK_INTERVAL_MS = 30_000;
/** Where a server answers who a device key belongs to (401 for an unknown key). */
const DEVICE_PATH = '/api/device';

/** Whether an HTTP status means the server does not accept this computer's device key. */
function isDeviceKeyRejected(status: number): boolean {
	return status === 401 || status === 403;
}

/** Reads a JSON answer; undefined when it is empty or not JSON. */
function parseJson(text: string): unknown {
	try {
		return text ? JSON.parse(text) : undefined;
	} catch {
		return undefined;
	}
}

/** Builds the WebSocket connections of CreaEditor Servers, with the device key as the token. */
class CreaEditorServerConnectionFactory implements IRemoteAgentHostConnectionFactory {
	readonly kind = RemoteAgentHostEntryType.CreaEditorServer;

	constructor(
		readonly entries: IObservable<readonly IRemoteAgentHostEntry[]>,
		private readonly _instantiationService: IInstantiationService,
	) { }

	createConnection(entry: IRemoteAgentHostEntry, _options: IRemoteAgentHostConnectOptions): Promise<IRemoteAgentHostCreatedConnection> {
		const connection = entry.connection;
		if (connection.type !== RemoteAgentHostEntryType.CreaEditorServer) {
			throw new Error(`CreaEditor Server factory cannot create a ${connection.type} connection.`);
		}
		const address = getEntryAddress(entry);
		// The protocol client creates a transport for every reconnect attempt.
		const transportFactory = () => this._instantiationService.createInstance(WebSocketClientTransport, connection.address, entry.connectionToken, undefined);
		return Promise.resolve({
			connection: this._instantiationService.createInstance(AgentHostProtocolClient, address, transportFactory, { clientInfo: agentsWindowAgentHostClientInfo }),
		});
	}
}

export class CreaEditorServersService extends Disposable implements ICreaEditorServersService {
	declare readonly _serviceBrand: undefined;

	private readonly _servers = observableValue<readonly ICreaEditorServer[]>(this, []);
	readonly servers: IObservable<readonly ICreaEditorServer[]> = this._servers;

	private readonly _healthStates = observableValue<ReadonlyMap<string, ICreaEditorServerHealthState>>(this, new Map());
	readonly healthStates: IObservable<ReadonlyMap<string, ICreaEditorServerHealthState>> = this._healthStates;

	private readonly _needsPairing = observableValue<ReadonlySet<string>>(this, new Set());
	readonly needsPairing: IObservable<ReadonlySet<string>> = this._needsPairing;

	/** Device keys read from secret storage, by server id. */
	private readonly _deviceKeys = observableValue<ReadonlyMap<string, string>>(this, new Map());
	private readonly _healthTimer = this._register(new IntervalTimer());
	/** When the device key of a server was last checked, by server id. */
	private readonly _deviceKeyCheckedAt = new Map<string, number>();

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@ICreaEditorServerHttpService private readonly _httpService: ICreaEditorServerHttpService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IHostService private readonly _hostService: IHostService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._servers.set(parseStoredCreaEditorServers(this._storageService.get(CREAEDITOR_SERVERS_STORAGE_KEY, StorageScope.APPLICATION)), undefined);

		const entries = derived(this, reader => {
			const keys = this._deviceKeys.read(reader);
			return this._servers.read(reader).flatMap((server): IRemoteAgentHostEntry[] => {
				// A server that rejects the key keeps its entry (and so its chats stay open on this
				// connection): Pair Again swaps the key and reconnects. The server limits failed keys
				// apart from pairing, so the retries cannot lock pairing out.
				const deviceKey = keys.get(server.id);
				return deviceKey ? [{
					name: server.name,
					connectionToken: deviceKey,
					connection: { type: RemoteAgentHostEntryType.CreaEditorServer, address: this.getAgentHostAddress(server), serverUrl: server.serverUrl, serverId: server.id },
				}] : [];
			});
		});
		this._register(this._remoteAgentHostService.registerConnectionFactory(new CreaEditorServerConnectionFactory(entries, instantiationService)));

		// A connection that fails may mean the server forgot this computer: check its key.
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => {
			for (const server of this._servers.get()) {
				const status = this._remoteAgentHostService.connections.find(candidate => candidate.address === this.getAgentHostAddress(server))?.status;
				if (status && !RemoteAgentHostConnectionStatus.isConnected(status) && !RemoteAgentHostConnectionStatus.isConnecting(status)) {
					void this._checkDeviceKey(server, false);
				}
			}
		}));

		void this._loadDeviceKeys().then(() => this.refreshHealth());
		this._healthTimer.cancelAndSet(() => {
			if (this._hostService.hasFocus) {
				void this.refreshHealth();
			}
		}, HEALTH_INTERVAL_MS);
	}

	getAgentHostAddress(server: ICreaEditorServer): string {
		return getCreaEditorServerAgentHostAddress(server.serverUrl);
	}

	async checkAddress(input: string): Promise<ICreaEditorServerCheck | undefined> {
		const parsed = parseCreaEditorServerInput(input);
		if (!parsed) {
			return undefined;
		}
		const health = await this._fetchHealth(parsed.baseUrl).catch(() => undefined);
		return { input: parsed, ...(health ? { health } : {}) };
	}

	async pair(serverUrl: string, code: string, password: string | undefined, deviceName: string): Promise<CreaEditorServerPairResult> {
		try {
			const response = await this._httpService.request({
				method: 'POST',
				url: `${serverUrl}${CREAEDITOR_SERVER_PAIR_PATH}`,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code, deviceName, ...(password ? { password } : {}) }),
				timeoutMs: REQUEST_TIMEOUT_MS,
			});
			return parseCreaEditorServerPairResponse(response.status, parseJson(response.body));
		} catch (error) {
			this._logService.warn(`[CreaEditor Servers] Pairing with ${serverUrl} failed`, error);
			return { ok: false, error: 'unreachable' };
		}
	}

	async addServer(server: { readonly name: string; readonly serverUrl: string; readonly sshHost?: string }, pairing: { readonly deviceId: string; readonly deviceKey: string }): Promise<ICreaEditorServer> {
		const added: ICreaEditorServer = {
			id: generateUuid(),
			name: server.name,
			serverUrl: server.serverUrl,
			deviceId: pairing.deviceId,
			addedAt: Date.now(),
			...(server.sshHost ? { sshHost: server.sshHost } : {}),
		};
		await this._secretStorageService.set(getCreaEditorServerDeviceKeyName(added.id), pairing.deviceKey);
		// A server at the same address replaces the old one (paired again).
		const replaced = this._servers.get().filter(existing => existing.serverUrl === added.serverUrl);
		for (const old of replaced) {
			await this._secretStorageService.delete(getCreaEditorServerDeviceKeyName(old.id));
		}
		const keys = new Map(this._deviceKeys.get());
		replaced.forEach(old => keys.delete(old.id));
		keys.set(added.id, pairing.deviceKey);
		this._deviceKeys.set(keys, undefined);
		this._storeServers([...this._servers.get().filter(existing => existing.serverUrl !== added.serverUrl), added]);
		void this.refreshHealth();
		return added;
	}

	async replaceDeviceKey(serverId: string, pairing: { readonly deviceId: string; readonly deviceKey: string }): Promise<ICreaEditorServer | undefined> {
		const server = this._servers.get().find(candidate => candidate.id === serverId);
		if (!server) {
			return undefined;
		}
		await this._secretStorageService.set(getCreaEditorServerDeviceKeyName(serverId), pairing.deviceKey);
		const updated: ICreaEditorServer = { ...server, deviceId: pairing.deviceId };
		const keys = new Map(this._deviceKeys.get());
		keys.set(serverId, pairing.deviceKey);
		this._deviceKeys.set(keys, undefined);
		this._setNeedsPairing(serverId, false);
		this._deviceKeyCheckedAt.delete(serverId);
		this._storeServers(this._servers.get().map(candidate => candidate.id === serverId ? updated : candidate));
		// The connection still dials with the old key: start over with the new one.
		this._remoteAgentHostService.reconnect(this.getAgentHostAddress(updated));
		void this.refreshHealth();
		return updated;
	}

	async removeServer(serverId: string): Promise<void> {
		const server = this._servers.get().find(candidate => candidate.id === serverId);
		if (!server) {
			return;
		}
		const deviceKey = this._deviceKeys.get().get(serverId);
		if (deviceKey) {
			// Best effort: the server forgets this device, so the key is useless even if it leaked.
			await this._httpService.request({
				method: 'POST',
				url: `${server.serverUrl}/api/sign-out`,
				headers: { 'Authorization': `Bearer ${deviceKey}` },
				timeoutMs: REQUEST_TIMEOUT_MS,
			}).catch(error => this._logService.info(`[CreaEditor Servers] Could not sign out of ${server.serverUrl}`, error));
		}
		await this._secretStorageService.delete(getCreaEditorServerDeviceKeyName(serverId));
		const keys = new Map(this._deviceKeys.get());
		keys.delete(serverId);
		this._deviceKeys.set(keys, undefined);
		this._setNeedsPairing(serverId, false);
		this._storeServers(this._servers.get().filter(candidate => candidate.id !== serverId));
		await this._remoteAgentHostService.removeRemoteAgentHost(this.getAgentHostAddress(server)).catch(() => undefined);
		const states = new Map(this._healthStates.get());
		states.delete(serverId);
		this._healthStates.set(states, undefined);
	}

	async createPairing(serverId: string): Promise<ICreaEditorServerPairingResponse | undefined> {
		const answer = await this._apiRequest<Partial<ICreaEditorServerPairingResponse>>(serverId, 'POST', CREAEDITOR_SERVER_API_PAIRING);
		return answer && typeof answer.code === 'string' && typeof answer.link === 'string' && typeof answer.expiresAt === 'number'
			? { code: answer.code, link: answer.link, expiresAt: answer.expiresAt }
			: undefined;
	}

	async fetchCosts(serverId: string, cursor: number): Promise<ICreaEditorServerCostsResponse | undefined> {
		const answer = await this._apiRequest<Partial<ICreaEditorServerCostsResponse>>(serverId, 'GET', `${CREAEDITOR_SERVER_API_COSTS}?after=${cursor}`);
		return answer && Array.isArray(answer.entries) && typeof answer.cursor === 'number'
			? { entries: answer.entries, cursor: answer.cursor, reset: answer.reset === true }
			: undefined;
	}

	async pushBudgets(serverId: string, budgets: IServerCostBudgets): Promise<boolean> {
		return !!await this._apiRequest(serverId, 'PUT', CREAEDITOR_SERVER_API_BUDGETS, budgets);
	}

	/** A request to the server's own API with this computer's device key; undefined on any failure. */
	private async _apiRequest<T>(serverId: string, type: 'GET' | 'POST' | 'PUT', path: string, body?: object): Promise<T | undefined> {
		const server = this._servers.get().find(candidate => candidate.id === serverId);
		const deviceKey = this._deviceKeys.get().get(serverId);
		if (!server || !deviceKey || this._needsPairing.get().has(serverId)) {
			return undefined;
		}
		try {
			const response = await this._httpService.request({
				method: type,
				url: `${server.serverUrl}${CREAEDITOR_SERVER_API_PREFIX}${path}`,
				headers: { 'Authorization': `Bearer ${deviceKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
				...(body ? { body: JSON.stringify(body) } : {}),
				timeoutMs: REQUEST_TIMEOUT_MS,
			});
			const status = response.status;
			if (status < 200 || status >= 300) {
				this._logService.info(`[CreaEditor Servers] ${server.name} answered ${status} to ${type} ${path.split('?')[0]}`);
				if (isDeviceKeyRejected(status)) {
					this._markNeedsPairing(server);
				}
				return undefined;
			}
			return (parseJson(response.body) as T | undefined) ?? undefined;
		} catch (error) {
			this._logService.info(`[CreaEditor Servers] ${type} ${path.split('?')[0]} on ${server.name} failed`, error);
			return undefined;
		}
	}

	async refreshHealth(): Promise<void> {
		const servers = this._servers.get();
		const results = await Promise.all(servers.map(async server => [server.id, await this._fetchHealth(server.serverUrl).catch(() => undefined)] as const));
		const previous = this._healthStates.get();
		const states = new Map<string, ICreaEditorServerHealthState>();
		const now = Date.now();
		for (const [id, health] of results) {
			states.set(id, health
				? { reachable: true, health, lastSeen: now }
				: { reachable: false, lastSeen: previous.get(id)?.lastSeen, health: previous.get(id)?.health });
		}
		this._healthStates.set(states, undefined);
		// A reachable server may still have forgotten this computer (signed out, data wiped).
		await Promise.all(servers.filter(server => states.get(server.id)?.reachable).map(server => this._checkDeviceKey(server, true)));
	}

	/**
	 * Asks the server whether it still knows this computer's device key (at most every
	 * {@link DEVICE_KEY_CHECK_INTERVAL_MS} unless `force`); a 401/403 marks it as needing pairing.
	 */
	private async _checkDeviceKey(server: ICreaEditorServer, force: boolean): Promise<void> {
		const deviceKey = this._deviceKeys.get().get(server.id);
		const now = Date.now();
		if (!deviceKey || this._needsPairing.get().has(server.id) || (!force && now - (this._deviceKeyCheckedAt.get(server.id) ?? 0) < DEVICE_KEY_CHECK_INTERVAL_MS)) {
			return;
		}
		this._deviceKeyCheckedAt.set(server.id, now);
		try {
			const response = await this._httpService.request({
				method: 'GET',
				url: `${server.serverUrl}${DEVICE_PATH}`,
				headers: { 'Authorization': `Bearer ${deviceKey}` },
				timeoutMs: REQUEST_TIMEOUT_MS,
			});
			// Only when the key is still the one checked: Pair Again may have replaced it meanwhile.
			if (isDeviceKeyRejected(response.status) && this._deviceKeys.get().get(server.id) === deviceKey) {
				this._markNeedsPairing(server);
			}
		} catch {
			// Unreachable: the health check reports that.
		}
	}

	private _markNeedsPairing(server: ICreaEditorServer): void {
		if (!this._needsPairing.get().has(server.id)) {
			this._logService.warn(`[CreaEditor Servers] ${server.name} no longer accepts this computer's device key; it needs pairing again`);
			this._setNeedsPairing(server.id, true);
		}
	}

	private _setNeedsPairing(serverId: string, needsPairing: boolean): void {
		const current = this._needsPairing.get();
		if (current.has(serverId) === needsPairing) {
			return;
		}
		const next = new Set(current);
		if (needsPairing) {
			next.add(serverId);
		} else {
			next.delete(serverId);
		}
		this._needsPairing.set(next, undefined);
	}

	private async _fetchHealth(serverUrl: string) {
		const response = await this._httpService.request({
			method: 'GET',
			url: `${serverUrl}${CREAEDITOR_SERVER_HEALTH_PATH}`,
			timeoutMs: REQUEST_TIMEOUT_MS,
		});
		return parseCreaEditorServerHealth(parseJson(response.body));
	}

	private async _loadDeviceKeys(): Promise<void> {
		const keys = new Map<string, string>();
		for (const server of this._servers.get()) {
			try {
				const key = await this._secretStorageService.get(getCreaEditorServerDeviceKeyName(server.id));
				if (key) {
					keys.set(server.id, key);
				}
			} catch (error) {
				this._logService.warn(`[CreaEditor Servers] Could not read the device key of ${server.name}`, error);
			}
		}
		// Keys added meanwhile (a server paired while this ran) win.
		this._deviceKeys.set(new Map([...keys, ...this._deviceKeys.get()]), undefined);
	}

	private _storeServers(servers: readonly ICreaEditorServer[]): void {
		this._servers.set(servers, undefined);
		if (servers.length) {
			this._storageService.store(CREAEDITOR_SERVERS_STORAGE_KEY, JSON.stringify(servers), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this._storageService.remove(CREAEDITOR_SERVERS_STORAGE_KEY, StorageScope.APPLICATION);
		}
	}
}

/** Gives every CreaEditor Server a sessions provider in the Agents window, like other remote hosts. */
export class CreaEditorServersAgentHostContribution extends EntryDrivenProviderContribution implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.creaeditorServersAgentHost';

	protected readonly _entryType = RemoteAgentHostEntryType.CreaEditorServer;

	constructor(
		@IRemoteAgentHostService remoteAgentHostService: IRemoteAgentHostService,
		@IConfigurationService configurationService: IConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsProvidersService sessionsProvidersService: ISessionsProvidersService,
		@INotificationService notificationService: INotificationService,
		@ICreaEditorServersService private readonly _serversService: ICreaEditorServersService,
	) {
		super(remoteAgentHostService, configurationService, instantiationService, sessionsProvidersService, notificationService);
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => this._reconcile()));
		this._register(this._remoteAgentHostService.onDidChangeConfiguredEntries(() => this._reconcile()));
		this._reconcile();
	}

	protected override _getProviderOptions(entry: IRemoteAgentHostEntry): IEntryDrivenProviderOptions {
		const serverId = entry.connection.type === RemoteAgentHostEntryType.CreaEditorServer ? entry.connection.serverId : undefined;
		return {
			workspaceTypeIcon: Codicon.server,
			...(serverId ? {
				removeOnDemand: () => this._serversService.removeServer(serverId),
				// Reconnecting cannot help a server that forgot this computer: say so, with Pair Again.
				connectionNotice: derived(reader => {
					const server = this._serversService.servers.read(reader).find(candidate => candidate.id === serverId);
					if (!server || !this._serversService.needsPairing.read(reader).has(serverId)) {
						return undefined;
					}
					return {
						message: localize('creaeditorServers.needsPairingBanner', "{0} no longer knows this computer.", server.name),
						action: { label: localize('creaeditorServers.pairAgainButton', "Pair Again"), run: () => void this._instantiationService.invokeFunction(pairAgainWithCreaEditorServer, server) },
					};
				}),
			} : {}),
		};
	}
}

registerSingleton(ICreaEditorServersService, CreaEditorServersService, InstantiationType.Delayed);
registerWorkbenchContribution2(CreaEditorServersAgentHostContribution.ID, CreaEditorServersAgentHostContribution, WorkbenchPhase.AfterRestored);
