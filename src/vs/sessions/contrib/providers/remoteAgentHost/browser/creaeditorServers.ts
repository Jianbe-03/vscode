/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the CreaEditor Servers this machine paired with (see `creaeditorServersService.ts`), how
// they are kept, and how their status reads in the Servers list.

import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { IObservable } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { CreaEditorServerPairResult, ICreaEditorServerChats, ICreaEditorServerHealth, ICreaEditorServerInput, ICreaEditorServerMachine } from '../../../../../platform/agentHost/common/creaeditorServer.js';
import { ICreaEditorServerCostsResponse, ICreaEditorServerPairingResponse, IServerCostBudgets } from '../../../../../platform/agentHost/common/creaeditorCosts.js';
import { RemoteAgentHostConnectionStatus } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

/** A paired CreaEditor Server. Its device key is in secret storage, never here. */
export interface ICreaEditorServer {
	readonly id: string;
	readonly name: string;
	/** `http(s)://host[:port]`. */
	readonly serverUrl: string;
	/** The id the server gave this machine when it paired (its device in the server's devices list). */
	readonly deviceId: string;
	/** Epoch milliseconds. */
	readonly addedAt: number;
	/** The SSH host the server was installed on from here, if it was. */
	readonly sshHost?: string;
}

/** Application storage key of the servers list. */
export const CREAEDITOR_SERVERS_STORAGE_KEY = 'creaeditor.servers';

/** The secret storage key of a server's device key. */
export function getCreaEditorServerDeviceKeyName(serverId: string): string {
	return `creaeditor.server.deviceKey.${serverId}`;
}

/** Reads the stored servers list, skipping anything malformed. */
export function parseStoredCreaEditorServers(raw: string | undefined): ICreaEditorServer[] {
	if (!raw) {
		return [];
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is ICreaEditorServer => !!entry && typeof entry === 'object'
		&& typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.serverUrl === 'string'
		&& typeof entry.deviceId === 'string' && typeof entry.addedAt === 'number'
		&& (entry.sshHost === undefined || typeof entry.sshHost === 'string'))
		.map(entry => ({ id: entry.id, name: entry.name, serverUrl: entry.serverUrl, deviceId: entry.deviceId, addedAt: entry.addedAt, ...(entry.sshHost ? { sshHost: entry.sshHost } : {}) }));
}

/** What the last `/health` check of a server found. */
export interface ICreaEditorServerHealthState {
	/** Undefined while the first check runs. */
	readonly reachable: boolean | undefined;
	readonly health?: ICreaEditorServerHealth;
	/** Epoch milliseconds of the last answer. */
	readonly lastSeen?: number;
}

/** Everything known about a server, for {@link describeCreaEditorServer}. */
export interface ICreaEditorServerStatusInput {
	readonly health: ICreaEditorServerHealthState | undefined;
	readonly connection: RemoteAgentHostConnectionStatus | undefined;
	readonly machine: ICreaEditorServerMachine | undefined;
	readonly runningChats: number | undefined;
	/** Running and queued chats when the server limits how many run at once. */
	readonly chats?: ICreaEditorServerChats;
}

/** How a server shows in the Servers list. */
export interface ICreaEditorServerView {
	readonly icon: ThemeIcon;
	readonly status: string;
	readonly details: readonly string[];
}

function formatGigabytes(bytes: number): string {
	return (bytes / 1024 ** 3).toFixed(1);
}

/** The status line and details of a server, e.g. "Online" and "Version 1.140.0 · CPU 12% · 2 chats running". */
export function describeCreaEditorServer(input: ICreaEditorServerStatusInput, now: number): ICreaEditorServerView {
	const { health, connection, machine, runningChats, chats } = input;
	const connected = RemoteAgentHostConnectionStatus.isConnected(connection);
	const details: string[] = [];
	if (health?.health) {
		details.push(localize('creaeditorServer.version', "Version {0}", health.health.version));
	}
	// The machine reading is only current while connected.
	if (connected && machine) {
		details.push(localize('creaeditorServer.cpu', "CPU {0}% of {1} cores", machine.cpuPercent, machine.cores));
		details.push(localize('creaeditorServer.memory', "Memory {0} of {1} GB", formatGigabytes(machine.memoryTotalBytes - machine.memoryFreeBytes), formatGigabytes(machine.memoryTotalBytes)));
	}
	if (connected && chats) {
		details.push(localize('creaeditorServer.chatsOfMax', "{0} of {1} chats running", chats.running, chats.max));
		if (chats.queued) {
			details.push(chats.queued === 1 ? localize('creaeditorServer.oneQueued', "1 queued") : localize('creaeditorServer.queued', "{0} queued", chats.queued));
		}
	} else if (connected && runningChats !== undefined) {
		details.push(runningChats === 1 ? localize('creaeditorServer.oneChat', "1 chat running") : localize('creaeditorServer.chats', "{0} chats running", runningChats));
	}
	if (health?.health?.publicMode) {
		details.push(localize('creaeditorServer.public', "Public"));
	}

	if (health?.reachable === false) {
		return {
			icon: Codicon.debugDisconnect,
			status: health.lastSeen !== undefined
				? localize('creaeditorServer.offlineSeen', "Offline, last seen {0}", fromNow(Date.now() - (now - health.lastSeen), true))
				: localize('creaeditorServer.offline', "Offline"),
			details,
		};
	}
	if (health?.reachable === undefined && !connected) {
		return { icon: Codicon.loading, status: localize('creaeditorServer.checking', "Checking..."), details };
	}
	if (connected) {
		return { icon: Codicon.server, status: localize('creaeditorServer.online', "Online"), details };
	}
	if (RemoteAgentHostConnectionStatus.isIncompatible(connection)) {
		return { icon: Codicon.warning, status: localize('creaeditorServer.incompatible', "Online, needs an update"), details };
	}
	if (RemoteAgentHostConnectionStatus.isConnecting(connection) || RemoteAgentHostConnectionStatus.isReconnecting(connection)) {
		return { icon: Codicon.loading, status: localize('creaeditorServer.connecting', "Online, connecting..."), details };
	}
	// Reachable, but the agent host connection failed: usually a device key the server signed out.
	return { icon: Codicon.warning, status: localize('creaeditorServer.notConnected', "Online, not connected"), details };
}

/** What checking a typed server address found. */
export interface ICreaEditorServerCheck {
	readonly input: ICreaEditorServerInput;
	/** Set when the address answered like a CreaEditor Server. */
	readonly health?: ICreaEditorServerHealth;
}

export const ICreaEditorServersService = createDecorator<ICreaEditorServersService>('creaeditorServersService');

/** The CreaEditor Servers this machine paired with; each is a remote agent host of its own kind. */
export interface ICreaEditorServersService {
	readonly _serviceBrand: undefined;
	readonly servers: IObservable<readonly ICreaEditorServer[]>;
	/** The last health check of each server, by server id. */
	readonly healthStates: IObservable<ReadonlyMap<string, ICreaEditorServerHealthState>>;
	/** Reads an address or pairing link and asks the server for `/health`; undefined for no address. */
	checkAddress(input: string): Promise<ICreaEditorServerCheck | undefined>;
	/**
	 * Exchanges a pairing code (and the password of a public server) for a device key; the server lists
	 * this machine as `deviceName`.
	 */
	pair(serverUrl: string, code: string, password: string | undefined, deviceName: string): Promise<CreaEditorServerPairResult>;
	/** Keeps a paired server (its device key in secret storage) and connects to it. */
	addServer(server: { readonly name: string; readonly serverUrl: string; readonly sshHost?: string }, pairing: { readonly deviceId: string; readonly deviceKey: string }): Promise<ICreaEditorServer>;
	/** Signs this machine out of the server (when it answers), forgets its device key and removes it. */
	removeServer(serverId: string): Promise<void>;
	/** Checks `/health` of every server now. */
	refreshHealth(): Promise<void>;
	/** The remote agent host address of a server (`IRemoteAgentHostService`). */
	getAgentHostAddress(server: ICreaEditorServer): string;
	/** A new one-time pairing code from the server (for Pair Phone); undefined when the server cannot make one (older version, offline). */
	createPairing(serverId: string): Promise<ICreaEditorServerPairingResponse | undefined>;
	/** New entries of the server's AI cost ledger after `cursor`; undefined when it does not answer. */
	fetchCosts(serverId: string, cursor: number): Promise<ICreaEditorServerCostsResponse | undefined>;
	/** Sends the hard-stop budgets to the server; false when it did not take them. */
	pushBudgets(serverId: string, budgets: IServerCostBudgets): Promise<boolean>;
}
