/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: one place that publishes the pooled Claude and Codex subscription accounts and routes
// the client's account requests to the agent that owns them.
//
// Usage from an agent (Claude, Codex):
//   1. Inject `ISubscriptionAccountsService` and call `registerProvider({ provider, onDidChangeAccounts,
//      getAccounts, handleRequest, refreshUsage })`; dispose the returned disposable with the agent.
//   2. Fire `onDidChangeAccounts` whenever an account (status, usage, label, order, ...) changes. The
//      service merges every provider's `getAccounts()` and publishes them as the root value
//      `SUBSCRIPTION_ACCOUNTS_META_KEY` (`readSubscriptionAccountsState` reads it on the client).
//   3. Requests a client writes to the root config key `SUBSCRIPTION_ACCOUNTS_REQUEST_KEY` are cleared
//      and handed to `handleRequest` of the owning provider: `add` by its `provider`, `refreshUsage`
//      to `refreshUsage` of one or every provider, everything else by its `accountId`.
//   4. Keep the user-added accounts (id, label, kind, order) through `getStoredAccounts` /
//      `setStoredAccounts`; the service writes them to `agent-subscription-accounts.json` next to the
//      agent host config. Never store credentials there.
//   5. Read `isAutoSwitchEnabled()` when an account hits its limit.
//
// Credentials: the agent host has no secret storage. A Claude setup-token arrives through
// `authenticate` with `subscriptionAccountTokenResource(id)` and is only kept in memory, so the
// workbench re-sends the tokens it keeps in its secret storage on every connect. `login` accounts keep
// their credentials in their own CLI config folder, where the CLI itself stores them.
//
// The service also refreshes the usage of every provider every ten minutes.

import * as fs from 'fs';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/path.js';
import { createDecorator } from '../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../log/common/log.js';
import { SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY, SUBSCRIPTION_ACCOUNTS_META_KEY, SUBSCRIPTION_ACCOUNTS_REQUEST_KEY, type ISubscriptionAccount, type ISubscriptionAccountsRequest, type ISubscriptionAccountsState, type SubscriptionAccountKind, type SubscriptionProvider } from '../../common/meta/subscriptionAccounts.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';

/** How often the service asks every provider to read its accounts' usage. */
const USAGE_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

/** A user-added account as it is kept on disk: no status, no usage and never a credential. */
export interface IStoredSubscriptionAccount {
	readonly id: string;
	readonly label: string;
	readonly kind: Exclude<SubscriptionAccountKind, 'default'>;
}

/** The part of an agent that owns the accounts of one {@link SubscriptionProvider}. */
export interface ISubscriptionAccountsProvider {
	readonly provider: SubscriptionProvider;
	/** Fires when anything in {@link getAccounts} changed. */
	readonly onDidChangeAccounts: Event<void>;
	/** The provider's accounts in the order they are tried, including the `default` one. */
	getAccounts(): readonly ISubscriptionAccount[];
	/** Handles `add`, `remove`, `rename`, `move`, `signIn` and `switchChat` for this provider. */
	handleRequest(request: ISubscriptionAccountsRequest): Promise<void>;
	/** Reads the usage of the provider's signed-in accounts. */
	refreshUsage(): Promise<void>;
}

export const ISubscriptionAccountsService = createDecorator<ISubscriptionAccountsService>('subscriptionAccountsService');

/** Publishes the pooled subscription accounts and routes client requests to their providers. */
export interface ISubscriptionAccountsService {
	readonly _serviceBrand: undefined;
	/** Fires when a provider's stored accounts were replaced with {@link setStoredAccounts}. */
	readonly onDidChangeStoredAccounts: Event<SubscriptionProvider>;
	registerProvider(provider: ISubscriptionAccountsProvider): IDisposable;
	/** The user-added accounts of `provider`, in order. */
	getStoredAccounts(provider: SubscriptionProvider): readonly IStoredSubscriptionAccount[];
	/** Replaces and persists the user-added accounts of `provider`. */
	setStoredAccounts(provider: SubscriptionProvider, accounts: readonly IStoredSubscriptionAccount[]): void;
	/** Whether a used-up account hands its chat to the next account without asking. */
	isAutoSwitchEnabled(): boolean;
	/** Publishes the merged accounts now. Providers normally fire `onDidChangeAccounts` instead. */
	publish(): void;
}

type StoredAccountsFile = { readonly [provider in SubscriptionProvider]?: readonly IStoredSubscriptionAccount[] };

export class SubscriptionAccountsService extends Disposable implements ISubscriptionAccountsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStoredAccounts = this._register(new Emitter<SubscriptionProvider>());
	readonly onDidChangeStoredAccounts = this._onDidChangeStoredAccounts.event;

	private readonly _providers = new Map<SubscriptionProvider, ISubscriptionAccountsProvider>();
	private _stored: StoredAccountsFile;
	private _write = Promise.resolve();
	private _lastPublished: string | undefined;
	private _lastRequestId: string | undefined;
	private readonly _usageTimer = this._register(new IntervalTimer());

	/**
	 * @param _storagePath JSON file that keeps the user-added accounts; `undefined` keeps them in memory.
	 */
	constructor(
		private readonly _storagePath: string | undefined,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._stored = this._read();
		this._register(this._configurationService.onDidRootConfigChange(() => this._handlePendingRequest()));
		this._usageTimer.cancelAndSet(() => this._refreshAllUsage(), USAGE_REFRESH_INTERVAL_MS);
	}

	registerProvider(provider: ISubscriptionAccountsProvider): IDisposable {
		if (this._providers.has(provider.provider)) {
			throw new Error(`Subscription accounts of '${provider.provider}' are already registered`);
		}
		this._providers.set(provider.provider, provider);
		const listener = provider.onDidChangeAccounts(() => this.publish());
		this.publish();
		// A request may have been written before the provider was ready.
		this._handlePendingRequest();
		return toDisposable(() => {
			listener.dispose();
			if (this._providers.get(provider.provider) === provider) {
				this._providers.delete(provider.provider);
				this.publish();
			}
		});
	}

	getStoredAccounts(provider: SubscriptionProvider): readonly IStoredSubscriptionAccount[] {
		return this._stored[provider] ?? [];
	}

	setStoredAccounts(provider: SubscriptionProvider, accounts: readonly IStoredSubscriptionAccount[]): void {
		this._stored = { ...this._stored, [provider]: accounts.map(account => ({ id: account.id, label: account.label, kind: account.kind })) };
		this._persist();
		this._onDidChangeStoredAccounts.fire(provider);
	}

	isAutoSwitchEnabled(): boolean {
		return this._configurationService.getRootConfigValues?.()[SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY] === true;
	}

	publish(): void {
		const state: ISubscriptionAccountsState = {
			accounts: [...this._providers.values()].flatMap(provider => provider.getAccounts()),
		};
		const serialized = JSON.stringify(state);
		if (serialized === this._lastPublished) {
			return;
		}
		this._lastPublished = serialized;
		this._configurationService.publishRootTransientValues?.({ [SUBSCRIPTION_ACCOUNTS_META_KEY]: state });
	}

	private _handlePendingRequest(): void {
		const request = this._configurationService.getRootConfigValues?.()[SUBSCRIPTION_ACCOUNTS_REQUEST_KEY];
		if (!isRequest(request) || request.id === this._lastRequestId) {
			return;
		}
		const provider = this._findProvider(request);
		if (request.type !== 'refreshUsage' && !provider) {
			// Not ours yet: the provider that owns it may still register.
			return;
		}
		this._lastRequestId = request.id;
		this._configurationService.updateRootConfig({ [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: undefined });
		void this._route(request, provider).catch(error => this._logService.error(error, `[SubscriptionAccounts] Request '${request.type}' failed`));
	}

	private async _route(request: ISubscriptionAccountsRequest, provider: ISubscriptionAccountsProvider | undefined): Promise<void> {
		if (request.type === 'refreshUsage') {
			const providers = request.provider ? [this._providers.get(request.provider)] : [...this._providers.values()];
			await Promise.all(providers.map(target => target?.refreshUsage()));
			return;
		}
		await provider?.handleRequest(request);
	}

	private _findProvider(request: ISubscriptionAccountsRequest): ISubscriptionAccountsProvider | undefined {
		if (request.type === 'add') {
			return this._providers.get(request.provider);
		}
		if (request.type === 'refreshUsage') {
			return request.provider ? this._providers.get(request.provider) : undefined;
		}
		return [...this._providers.values()].find(provider => provider.getAccounts().some(account => account.id === request.accountId));
	}

	private _refreshAllUsage(): void {
		for (const provider of this._providers.values()) {
			if (provider.getAccounts().some(account => account.status === 'signedIn' || account.status === 'limited')) {
				void provider.refreshUsage().catch(error => this._logService.warn(`[SubscriptionAccounts] Periodic usage refresh of '${provider.provider}' failed`, error));
			}
		}
	}

	private _read(): StoredAccountsFile {
		if (!this._storagePath) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this._storagePath, 'utf8'));
			if (!parsed || typeof parsed !== 'object') {
				return {};
			}
			const file = parsed as Record<string, unknown>;
			return { claude: readStoredAccounts(file.claude), codex: readStoredAccounts(file.codex) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this._logService.warn(`[SubscriptionAccounts] Failed to read ${this._storagePath}`, error);
			}
			return {};
		}
	}

	private _persist(): void {
		const path = this._storagePath;
		if (!path) {
			return;
		}
		const content = `${JSON.stringify(this._stored, undefined, '\t')}\n`;
		this._write = this._write.then(async () => {
			await fs.promises.mkdir(dirname(path), { recursive: true });
			await fs.promises.writeFile(path, content, 'utf8');
		}).catch(error => this._logService.error(error, `[SubscriptionAccounts] Failed to write ${path}`));
	}
}

function readStoredAccounts(value: unknown): readonly IStoredSubscriptionAccount[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((entry): entry is IStoredSubscriptionAccount => !!entry && typeof entry === 'object'
		&& typeof entry.id === 'string' && typeof entry.label === 'string' && (entry.kind === 'token' || entry.kind === 'login'));
}

function isRequest(value: unknown): value is ISubscriptionAccountsRequest {
	return !!value && typeof value === 'object' && typeof (value as ISubscriptionAccountsRequest).id === 'string' && typeof (value as ISubscriptionAccountsRequest).type === 'string';
}
