/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the client side of pooled Claude and Codex subscription accounts. The agent host owns
// the accounts (see `subscriptionAccounts.ts`); this service reads them from the root state, sends
// changes as root config requests, and keeps the pasted Claude setup-tokens in the secret storage so
// they can be handed to the agent host again after every (re)start.

import { disposableTimeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IObservable, derived, observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IAgentHostService, type IAgentConnection } from '../../../../platform/agentHost/common/agentService.js';
import { ISubscriptionAccount, ISubscriptionAccountsRequest, SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY, SUBSCRIPTION_ACCOUNTS_REQUEST_KEY, SUBSCRIPTION_ACCOUNTS_WARNING_THRESHOLD_KEY, SUBSCRIPTION_USAGE_WARNING_DEFAULT_PERCENT, SubscriptionProvider, formatShortDuration, getPoolSummary, getRemainingPercent, readSubscriptionAccountsState, subscriptionAccountTokenResource } from '../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { ActionType } from '../../../../platform/agentHost/common/state/sessionActions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import type { RootState } from '../../../../platform/agentHost/common/state/protocol/state.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { openCodexAuthUrl } from './codexAccountService.js';

/** Whether a used-up Claude or Codex account hands the chat to the next account without asking. */
export const SubscriptionAccountsAutoSwitchSettingId = 'chat.subscriptionAccounts.autoSwitch';
/** The used share (1-99) of an account's tightest window from which it warns; 0 turns usage warnings off. */
export const SubscriptionAccountsUsageWarningThresholdSettingId = 'chat.subscriptionAccounts.usageWarningThreshold';
/** What a chat does when its account is used up and no other account is left: `ask` or `waitForReset`. */
export const SubscriptionAccountsWhenNoAccountLeftSettingId = 'chat.subscriptionAccounts.whenNoAccountLeft';

export const SUBSCRIPTION_PROVIDERS: readonly SubscriptionProvider[] = ['claude', 'codex'];

export { formatShortDuration };

export interface ISubscriptionPoolSummary {
	readonly provider: SubscriptionProvider;
	/** Average remaining share (0-100) over the accounts with a usage reading. */
	readonly remainingPercent: number | undefined;
	/** Accounts that can take work now. */
	readonly available: number;
	/** Accounts that are not signed out. */
	readonly total: number;
	/** Epoch milliseconds of the first limit that resets, if any. */
	readonly earliestResetAt: number | undefined;
}

export const ISubscriptionAccountsService = createDecorator<ISubscriptionAccountsService>('subscriptionAccountsService');

export interface ISubscriptionAccountsService {
	readonly _serviceBrand: undefined;

	/** All accounts of the local agent host, in the order they are tried. */
	readonly accounts: IObservable<readonly ISubscriptionAccount[]>;

	/** One summary per provider that has at least one account. */
	readonly pools: IObservable<readonly ISubscriptionPoolSummary[]>;

	/** Mirrors the {@link SubscriptionAccountsAutoSwitchSettingId} setting. */
	readonly autoSwitch: IObservable<boolean>;

	/** Mirrors the {@link SubscriptionAccountsUsageWarningThresholdSettingId} setting; 0 when warnings are off. */
	readonly warningThreshold: IObservable<number>;

	/**
	 * Adds an account and returns its id. A `token` account needs the setup-token, which is kept in
	 * the secret storage and handed to the agent host; a `login` account starts a browser sign-in.
	 */
	add(provider: SubscriptionProvider, kind: 'token' | 'login', label: string, token?: string): Promise<string>;
	remove(accountId: string): Promise<void>;
	rename(accountId: string, label: string): void;
	move(accountId: string, index: number): void;
	/** Starts a browser sign-in; a Codex sign-in page opens once the agent host publishes it. */
	signIn(accountId: string): void;
	refreshUsage(provider?: SubscriptionProvider): void;
	/** Continues the interrupted turn of `chat` (an agent host chat URI) on another account. */
	switchChat(chat: string, accountId: string): void;
	/**
	 * The accounts chats are pinned to in the model picker, by chat session resource. A pinned chat's
	 * next requests run on that account (the agent host gets the pin with each request).
	 */
	readonly pinnedAccounts: IObservable<ReadonlyMap<string, string>>;
	/** Pins the chat of `sessionResource` to `accountId`, or back to the pool without one. */
	pinChat(sessionResource: URI, accountId: string | undefined): void;
	setAutoSwitch(value: boolean): Promise<void>;
}

type SubscriptionAccountsRequest = ISubscriptionAccountsRequest extends infer T ? T extends unknown ? Omit<T, 'id'> : never : never;

/**
 * Writes a subscription accounts request into the root config of `connection`. The agent host
 * handles it and clears the key again.
 */
export function dispatchSubscriptionAccountsRequest(connection: Pick<IAgentConnection, 'dispatch'>, request: SubscriptionAccountsRequest): string {
	const id = generateUuid();
	connection.dispatch(ROOT_STATE_URI, {
		type: ActionType.RootConfigChanged,
		config: { [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: { ...request, id } },
	});
	return id;
}

/**
 * Resolves once the agent host handled the request with `requestId` (it showed up in the root
 * config and was cleared or replaced again), or after `timeoutMs`.
 */
export function waitForSubscriptionAccountsRequest(connection: Pick<IAgentConnection, 'rootState'>, requestId: string, token: CancellationToken, timeoutMs = 10_000): Promise<void> {
	const isPending = () => {
		const state = connection.rootState.value;
		const value = state && !(state instanceof Error) ? state.config?.values[SUBSCRIPTION_ACCOUNTS_REQUEST_KEY] : undefined;
		return typeof value === 'object' && value !== null && (value as { id?: unknown }).id === requestId;
	};
	return new Promise<void>(resolve => {
		const store = new DisposableStore();
		let seen = false;
		const done = () => {
			store.dispose();
			resolve();
		};
		const check = () => {
			if (isPending()) {
				seen = true;
			} else if (seen) {
				done();
			}
		};
		store.add(connection.rootState.onDidChange(check));
		store.add(token.onCancellationRequested(done));
		store.add(disposableTimeout(done, timeoutMs));
		check();
	});
}

/** The secret storage key of the setup-token of a `token` account. */
export function getSubscriptionAccountSecretKey(accountId: string): string {
	return `creaeditor.subscriptionAccount.${accountId}`;
}

export function getSubscriptionProviderLabel(provider: SubscriptionProvider): string {
	return provider === 'claude' ? localize('subscriptionProvider.claude', "Claude") : localize('subscriptionProvider.codex', "Codex");
}

/** The first moment a used-up window or account of `provider` frees up again, in the future. */
export function getEarliestReset(accounts: readonly ISubscriptionAccount[], provider: SubscriptionProvider, now: number): number | undefined {
	let earliest: number | undefined;
	for (const account of accounts) {
		if (account.provider !== provider || account.status === 'signedOut') {
			continue;
		}
		const resets = [account.limitedUntil, ...(account.usage ?? []).map(window => window.resetsAt)];
		for (const resetsAt of resets) {
			if (resetsAt !== undefined && resetsAt > now && (earliest === undefined || resetsAt < earliest)) {
				earliest = resetsAt;
			}
		}
	}
	return earliest;
}

export function getPoolSummaries(accounts: readonly ISubscriptionAccount[], now: number): ISubscriptionPoolSummary[] {
	return SUBSCRIPTION_PROVIDERS
		.filter(provider => accounts.some(account => account.provider === provider))
		.map(provider => ({ provider, ...getPoolSummary(accounts, provider), earliestResetAt: getEarliestReset(accounts, provider, now) }));
}

export function formatResetsIn(resetsAt: number, now: number): string {
	return resetsAt <= now
		? localize('subscriptionResetsNow', "resets now")
		: localize('subscriptionResetsIn', "resets in {0}", formatShortDuration(resetsAt - now));
}

/** E.g. "62% left" for the remaining share of an account or pool. */
export function formatRemaining(remainingPercent: number | undefined): string {
	return remainingPercent === undefined
		? localize('subscriptionNoReading', "No usage reading yet")
		: localize('subscriptionRemaining', "{0}% left", remainingPercent);
}

/** E.g. "2 of 3 accounts available". */
export function formatAvailability(summary: Pick<ISubscriptionPoolSummary, 'available' | 'total'>): string {
	return summary.total === 1
		? (summary.available ? localize('subscriptionOneAvailable', "1 of 1 account available") : localize('subscriptionOneUnavailable', "0 of 1 account available"))
		: localize('subscriptionAvailability', "{0} of {1} accounts available", summary.available, summary.total);
}

/** The compact status bar text, e.g. "Claude 62% · Codex 80%". */
export function formatPoolsStatusText(pools: readonly ISubscriptionPoolSummary[]): string {
	return pools.map(pool => pool.remainingPercent === undefined
		? getSubscriptionProviderLabel(pool.provider)
		: localize('subscriptionPoolStatus', "{0} {1}%", getSubscriptionProviderLabel(pool.provider), pool.remainingPercent)
	).join(' \u00b7 ');
}

/** One line per account for hovers, e.g. "Work: 40% left · resets in 3h". */
export function formatAccountLine(account: ISubscriptionAccount, now: number): string {
	return localize('subscriptionAccountLine', "{0}: {1}", account.label, formatAccountState(account, now));
}

/** The state of an account in a few words, e.g. "40% left · resets in 3h" or "signed out". */
export function formatAccountState(account: ISubscriptionAccount, now: number): string {
	const details: string[] = [];
	switch (account.status) {
		case 'signedOut': details.push(localize('subscriptionStatus.signedOut', "signed out")); break;
		case 'signingIn': details.push(localize('subscriptionStatus.signingIn', "signing in")); break;
		case 'error': details.push(localize('subscriptionStatus.error', "error")); break;
		default: details.push(formatRemaining(getRemainingPercent(account)));
	}
	const resetsAt = getEarliestReset([account], account.provider, now);
	if (resetsAt !== undefined && (account.status === 'limited' || getRemainingPercent(account) !== undefined)) {
		details.push(formatResetsIn(resetsAt, now));
	}
	return details.join(' \u00b7 ');
}

/** The CLI login command an agent host error asks to run in a terminal, such as `claude login`. */
export function getCliLoginCommand(error: string | undefined): string | undefined {
	const match = error?.match(/`(?<command>[^`\n]*\b(?:claude|codex)\b[^`\n]*)`/);
	return match?.groups?.command.trim();
}

export function openClaudeAuthUrl(openerService: Pick<IOpenerService, 'open'>, authUrl: string): Promise<boolean> {
	let url: URL;
	try {
		url = new URL(authUrl);
	} catch {
		return Promise.resolve(false);
	}
	const hostname = url.hostname.toLowerCase();
	if (url.protocol !== 'https:' || !['claude.ai', 'claude.com', 'anthropic.com'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`))) {
		return Promise.resolve(false);
	}
	return openerService.open(url.href, { openExternal: true, skipValidation: true });
}

export class SubscriptionAccountsService extends Disposable implements ISubscriptionAccountsService {
	declare readonly _serviceBrand: undefined;

	private readonly _accounts = observableValue<readonly ISubscriptionAccount[]>(this, []);
	readonly accounts: IObservable<readonly ISubscriptionAccount[]> = this._accounts;

	readonly pools: IObservable<readonly ISubscriptionPoolSummary[]> = derived(this, reader => getPoolSummaries(this._accounts.read(reader), Date.now()));

	private readonly _autoSwitch = observableValue<boolean>(this, false);
	readonly autoSwitch: IObservable<boolean> = this._autoSwitch;

	private readonly _warningThreshold = observableValue<number>(this, SUBSCRIPTION_USAGE_WARNING_DEFAULT_PERCENT);
	readonly warningThreshold: IObservable<number> = this._warningThreshold;

	private readonly _pinnedAccounts = observableValue<ReadonlyMap<string, string>>(this, new Map());
	readonly pinnedAccounts: IObservable<ReadonlyMap<string, string>> = this._pinnedAccounts;

	private readonly _rootStateListeners = this._register(new DisposableStore());
	/** Token accounts whose setup-token went to the agent host since it last started. */
	private readonly _sentTokens = new Set<string>();
	/**
	 * Codex accounts whose browser sign-in this window started, with the sign-in URL it already opened.
	 * The Claude CLI opens its sign-in page itself, so Claude pages are only offered (see the flows).
	 */
	private readonly _pendingSignIns = new Map<string, string | undefined>();
	private _autoSwitchSent = false;

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._autoSwitch.set(this._configurationService.getValue<boolean>(SubscriptionAccountsAutoSwitchSettingId) === true, undefined);
		this._warningThreshold.set(this._readWarningThreshold(), undefined);
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SubscriptionAccountsAutoSwitchSettingId) || e.affectsConfiguration(SubscriptionAccountsUsageWarningThresholdSettingId)) {
				this._autoSwitch.set(this._configurationService.getValue<boolean>(SubscriptionAccountsAutoSwitchSettingId) === true, undefined);
				this._warningThreshold.set(this._readWarningThreshold(), undefined);
				this._autoSwitchSent = false;
				this._syncAutoSwitch(this._readRootState());
			}
		}));
		// The root state is a placeholder until the agent host connects and is replaced on every
		// restart, so listen again on every start. The new process may not know the setup-tokens.
		this._register(this._agentHostService.onAgentHostStart(() => {
			this._sentTokens.clear();
			this._autoSwitchSent = false;
			this._bindRootState();
		}));
		this._bindRootState();
	}

	async add(provider: SubscriptionProvider, kind: 'token' | 'login', label: string, token?: string): Promise<string> {
		const accountId = generateUuid();
		if (kind === 'token') {
			if (!token) {
				throw new Error('A token account needs a setup-token.');
			}
			await this._secretStorageService.set(getSubscriptionAccountSecretKey(accountId), token);
		} else if (provider === 'codex') {
			this._pendingSignIns.set(accountId, undefined);
		}
		this._request({ type: 'add', provider, kind, label, accountId });
		if (kind === 'token') {
			// The agent host holds a token that arrives before its account is added.
			this._sentTokens.add(accountId);
			void this._sendToken(accountId);
		}
		return accountId;
	}

	async remove(accountId: string): Promise<void> {
		this._pendingSignIns.delete(accountId);
		this._sentTokens.delete(accountId);
		const account = this._accounts.get().find(candidate => candidate.id === accountId);
		this._request({ type: 'remove', accountId });
		if (account?.kind === 'token') {
			// An empty token makes the agent host forget the one it holds in memory.
			try {
				await this._agentHostService.authenticate({ resource: subscriptionAccountTokenResource(accountId), token: '' });
			} catch (error) {
				this._logService.warn(`[SubscriptionAccounts] Could not clear the setup-token of account ${accountId}`, error);
			}
		}
		await this._secretStorageService.delete(getSubscriptionAccountSecretKey(accountId));
	}

	rename(accountId: string, label: string): void {
		this._request({ type: 'rename', accountId, label });
	}

	move(accountId: string, index: number): void {
		this._request({ type: 'move', accountId, index });
	}

	signIn(accountId: string): void {
		const account = this._accounts.get().find(candidate => candidate.id === accountId);
		if (account?.kind === 'token') {
			// A token account signs in with its stored setup-token: hand it over again.
			this._sentTokens.delete(accountId);
			this._sendTokens(this._accounts.get());
		} else if (account?.provider === 'codex') {
			this._pendingSignIns.set(accountId, undefined);
		}
		this._request({ type: 'signIn', accountId });
	}

	refreshUsage(provider?: SubscriptionProvider): void {
		this._request(provider ? { type: 'refreshUsage', provider } : { type: 'refreshUsage' });
	}

	switchChat(chat: string, accountId: string): void {
		this._request({ type: 'switchChat', chat, accountId });
	}

	pinChat(sessionResource: URI, accountId: string | undefined): void {
		const pins = new Map(this._pinnedAccounts.get());
		if (accountId) {
			pins.set(sessionResource.toString(), accountId);
		} else {
			pins.delete(sessionResource.toString());
		}
		this._pinnedAccounts.set(pins, undefined);
	}

	async setAutoSwitch(value: boolean): Promise<void> {
		await this._configurationService.updateValue(SubscriptionAccountsAutoSwitchSettingId, value);
	}

	private _readWarningThreshold(): number {
		const value = this._configurationService.getValue<unknown>(SubscriptionAccountsUsageWarningThresholdSettingId);
		return typeof value === 'number' && value >= 0 && value < 100 ? Math.round(value) : SUBSCRIPTION_USAGE_WARNING_DEFAULT_PERCENT;
	}

	private _request(request: SubscriptionAccountsRequest): void {
		dispatchSubscriptionAccountsRequest(this._agentHostService, request);
	}

	private _readRootState(): RootState | undefined {
		const value = this._agentHostService.rootState.value;
		return value instanceof Error ? undefined : value;
	}

	private _bindRootState(): void {
		this._rootStateListeners.clear();
		this._rootStateListeners.add(this._agentHostService.rootState.onDidChange(state => this._update(state)));
		this._update(this._readRootState());
	}

	private _update(state: RootState | undefined): void {
		const accounts = readSubscriptionAccountsState(state).accounts;
		this._accounts.set(accounts, undefined);
		if (!state) {
			return;
		}
		this._syncAutoSwitch(state);
		this._sendTokens(accounts);
		this._openSignInPages(accounts);
	}

	/** Mirrors the auto-switch and usage warning settings into the root config once per agent host start and on every change. */
	private _syncAutoSwitch(state: RootState | undefined): void {
		if (!state || this._autoSwitchSent) {
			return;
		}
		this._autoSwitchSent = true;
		const values: Record<string, unknown> = {
			[SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY]: this._autoSwitch.get(),
			[SUBSCRIPTION_ACCOUNTS_WARNING_THRESHOLD_KEY]: this._warningThreshold.get(),
		};
		const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => state.config?.values[key] !== value));
		if (!Object.keys(changed).length) {
			return;
		}
		this._agentHostService.dispatch(ROOT_STATE_URI, {
			type: ActionType.RootConfigChanged,
			config: changed,
		});
	}

	private _sendTokens(accounts: readonly ISubscriptionAccount[]): void {
		for (const account of accounts) {
			if (account.kind !== 'token' || this._sentTokens.has(account.id)) {
				continue;
			}
			this._sentTokens.add(account.id);
			void this._sendToken(account.id);
		}
	}

	private async _sendToken(accountId: string): Promise<void> {
		try {
			const token = await this._secretStorageService.get(getSubscriptionAccountSecretKey(accountId));
			if (!token || !this._sentTokens.has(accountId)) {
				return;
			}
			await this._agentHostService.authenticate({ resource: subscriptionAccountTokenResource(accountId), token });
		} catch (error) {
			this._logService.warn(`[SubscriptionAccounts] Could not hand the setup-token of account ${accountId} to the agent host`, error);
		}
	}

	private _openSignInPages(accounts: readonly ISubscriptionAccount[]): void {
		for (const [accountId, openedUrl] of this._pendingSignIns) {
			const account = accounts.find(candidate => candidate.id === accountId);
			if (!account) {
				continue;
			}
			if (account.status === 'signedIn' || account.status === 'error') {
				this._pendingSignIns.delete(accountId);
				continue;
			}
			if (account.authUrl && account.authUrl !== openedUrl) {
				this._pendingSignIns.set(accountId, account.authUrl);
				void openCodexAuthUrl(this._openerService, account.authUrl);
			}
		}
	}
}

registerSingleton(ISubscriptionAccountsService, SubscriptionAccountsService, InstantiationType.Delayed);
