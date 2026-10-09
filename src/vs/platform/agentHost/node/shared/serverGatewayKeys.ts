/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the OpenRouter/LiteLLM keys delegated chats brought to a CreaEditor Server (Delegate to
// Server), kept encrypted in the agent host's file secret store by `<vendor>/<group>`, and the work
// context (repository, branch, title) of each delegated chat's worktree for the cost ledger. The
// server's gateway connection (`gatewayDirectConnection.ts`) serves these keys' models.

import { Emitter, Event } from '../../../../base/common/event.js';
import { isEqualOrParent } from '../../../../base/common/extpath.js';
import { IDelegationAccountsPayload, IDelegationGatewayKey, IDelegationWorkContext } from '../../common/creaeditorDelegation.js';
import { FileSecretStore, getAgentHostSecretStore } from './fileSecretStore.js';

const GATEWAY_KEY_SECRET_PREFIX = 'gateway-key:';
const WORK_CONTEXTS_SECRET_NAME = 'delegation-work-contexts';
/** The newest delegated chats' work contexts that are kept. */
const MAX_WORK_CONTEXTS = 500;

/** The store name of a gateway key. */
export function gatewayKeySecretName(vendor: string, group: string): string {
	return `${GATEWAY_KEY_SECRET_PREFIX}${vendor}/${group}`;
}

/** The delegated gateway keys of this server. */
export class ServerGatewayKeys {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(private readonly _store: FileSecretStore) { }

	get keys(): readonly IDelegationGatewayKey[] {
		const keys: IDelegationGatewayKey[] = [];
		for (const name of this._store.keys(GATEWAY_KEY_SECRET_PREFIX)) {
			try {
				const value = this._store.get(name);
				if (value) {
					keys.push(JSON.parse(value) as IDelegationGatewayKey);
				}
			} catch {
				// A key that cannot be read is left out; the next delegation replaces it.
			}
		}
		return keys;
	}

	getKey(vendor: string, group: string): IDelegationGatewayKey | undefined {
		return this.keys.find(key => key.providerId === vendor && key.label === group);
	}

	/** Keeps the gateway key and the work context of a delegated chat (the latest key of a group wins). */
	async addFromDelegation(payload: IDelegationAccountsPayload): Promise<void> {
		if (payload.gatewayKey) {
			const { providerId, label } = payload.gatewayKey;
			await this._store.set(gatewayKeySecretName(providerId, label), JSON.stringify(payload.gatewayKey));
		}
		if (payload.workContext) {
			const contexts = this._readWorkContexts().filter(context => context.worktree !== payload.workContext!.worktree);
			contexts.push(payload.workContext);
			await this._store.set(WORK_CONTEXTS_SECRET_NAME, JSON.stringify(contexts.slice(-MAX_WORK_CONTEXTS)));
		}
		if (payload.gatewayKey || payload.workContext) {
			this._onDidChange.fire();
		}
	}

	/** The work context of the delegated chat whose worktree holds `workingDirectory`. */
	findWorkContext(workingDirectory: string | undefined): IDelegationWorkContext | undefined {
		if (!workingDirectory) {
			return undefined;
		}
		let best: IDelegationWorkContext | undefined;
		for (const context of this._readWorkContexts()) {
			if (isEqualOrParent(workingDirectory, context.worktree) && (!best || context.worktree.length > best.worktree.length)) {
				best = context;
			}
		}
		return best;
	}

	private _readWorkContexts(): IDelegationWorkContext[] {
		try {
			const value = this._store.get(WORK_CONTEXTS_SECRET_NAME);
			const parsed: unknown = value ? JSON.parse(value) : [];
			return Array.isArray(parsed) ? parsed.filter((item): item is IDelegationWorkContext => !!item && typeof item.worktree === 'string') : [];
		} catch {
			return [];
		}
	}
}

let serverGatewayKeys: ServerGatewayKeys | null | undefined;

/** The delegated gateway keys when this agent host runs on a CreaEditor Server (it has a file secret store), else undefined. */
export function getServerGatewayKeys(): ServerGatewayKeys | undefined {
	if (serverGatewayKeys === undefined) {
		const store = getAgentHostSecretStore();
		serverGatewayKeys = store ? new ServerGatewayKeys(store) : null;
	}
	return serverGatewayKeys ?? undefined;
}
