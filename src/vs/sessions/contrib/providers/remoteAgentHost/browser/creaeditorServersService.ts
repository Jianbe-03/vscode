/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: keeps the paired CreaEditor Servers (list in application storage, device keys in secret
// storage), checks their `/health`, and makes each one a remote agent host of the kind
// `RemoteAgentHostEntryType.CreaEditorServer` whose connection token is the device key.

import { IntervalTimer } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { derived, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { AgentHostProtocolClient } from '../../../../../platform/agentHost/browser/agentHostProtocolClient.js';
import { WebSocketClientTransport } from '../../../../../platform/agentHost/browser/webSocketClientTransport.js';
import { agentsWindowAgentHostClientInfo } from '../../../../../platform/agentHost/common/agentHostClientInfo.js';
import { CREAEDITOR_SERVER_HEALTH_PATH, CREAEDITOR_SERVER_PAIR_PATH, CreaEditorServerPairResult, getCreaEditorServerAgentHostAddress, parseCreaEditorServerHealth, parseCreaEditorServerInput, parseCreaEditorServerPairResponse } from '../../../../../platform/agentHost/common/creaeditorServer.js';
import { getEntryAddress, IRemoteAgentHostConnectionFactory, IRemoteAgentHostConnectOptions, IRemoteAgentHostCreatedConnection, IRemoteAgentHostEntry, IRemoteAgentHostService, RemoteAgentHostEntryType } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { asJson, IRequestService } from '../../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { CREAEDITOR_SERVERS_STORAGE_KEY, getCreaEditorServerDeviceKeyName, ICreaEditorServer, ICreaEditorServerCheck, ICreaEditorServerHealthState, ICreaEditorServersService, parseStoredCreaEditorServers } from './creaeditorServers.js';
import { EntryDrivenProviderContribution, IEntryDrivenProviderOptions } from './entryDrivenProviderContribution.js';

/** How often the servers' `/health` is checked while the window has focus. */
const HEALTH_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

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

	/** Device keys read from secret storage, by server id. */
	private readonly _deviceKeys = observableValue<ReadonlyMap<string, string>>(this, new Map());
	private readonly _healthTimer = this._register(new IntervalTimer());

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IRequestService private readonly _requestService: IRequestService,
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
				const deviceKey = keys.get(server.id);
				return deviceKey ? [{
					name: server.name,
					connectionToken: deviceKey,
					connection: { type: RemoteAgentHostEntryType.CreaEditorServer, address: this.getAgentHostAddress(server), serverUrl: server.serverUrl, serverId: server.id },
				}] : [];
			});
		});
		this._register(this._remoteAgentHostService.registerConnectionFactory(new CreaEditorServerConnectionFactory(entries, instantiationService)));

		void this._loadDeviceKeys();
		void this.refreshHealth();
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
			const context = await this._requestService.request({
				type: 'POST',
				url: `${serverUrl}${CREAEDITOR_SERVER_PAIR_PATH}`,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({ code, deviceName, ...(password ? { password } : {}) }),
				timeout: REQUEST_TIMEOUT_MS,
				callSite: 'creaeditorServers.pair',
			}, CancellationToken.None);
			return parseCreaEditorServerPairResponse(context.res.statusCode ?? 0, await asJson(context).catch(() => undefined));
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

	async removeServer(serverId: string): Promise<void> {
		const server = this._servers.get().find(candidate => candidate.id === serverId);
		if (!server) {
			return;
		}
		const deviceKey = this._deviceKeys.get().get(serverId);
		if (deviceKey) {
			// Best effort: the server forgets this device, so the key is useless even if it leaked.
			await this._requestService.request({
				type: 'POST',
				url: `${server.serverUrl}/api/sign-out`,
				headers: { 'Authorization': `Bearer ${deviceKey}` },
				timeout: REQUEST_TIMEOUT_MS,
				callSite: 'creaeditorServers.signOut',
			}, CancellationToken.None).catch(error => this._logService.info(`[CreaEditor Servers] Could not sign out of ${server.serverUrl}`, error));
		}
		await this._secretStorageService.delete(getCreaEditorServerDeviceKeyName(serverId));
		const keys = new Map(this._deviceKeys.get());
		keys.delete(serverId);
		this._deviceKeys.set(keys, undefined);
		this._storeServers(this._servers.get().filter(candidate => candidate.id !== serverId));
		await this._remoteAgentHostService.removeRemoteAgentHost(this.getAgentHostAddress(server)).catch(() => undefined);
		const states = new Map(this._healthStates.get());
		states.delete(serverId);
		this._healthStates.set(states, undefined);
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
	}

	private async _fetchHealth(serverUrl: string) {
		const context = await this._requestService.request({
			type: 'GET',
			url: `${serverUrl}${CREAEDITOR_SERVER_HEALTH_PATH}`,
			timeout: REQUEST_TIMEOUT_MS,
			disableCache: true,
			callSite: 'creaeditorServers.health',
		}, CancellationToken.None);
		return parseCreaEditorServerHealth(await asJson(context));
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
			...(serverId ? { removeOnDemand: () => this._serversService.removeServer(serverId) } : {}),
		};
	}
}

registerSingleton(ICreaEditorServersService, CreaEditorServersService, InstantiationType.Delayed);
registerWorkbenchContribution2(CreaEditorServersAgentHostContribution.ID, CreaEditorServersAgentHostContribution, WorkbenchPhase.AfterRestored);
