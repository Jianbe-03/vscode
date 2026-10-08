/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: several Claude subscription accounts behind the one native Claude model list.
//
// - `default`: the login the CLI finds by itself (`~/.claude`, keychain, `CLAUDE_CODE_OAUTH_TOKEN`).
// - `token`: a `claude setup-token` token. It reaches the agent host through `authenticate` with
//   `subscriptionAccountTokenResource(id)` and is only kept in memory: the agent host has no secret
//   storage, so the workbench re-sends the tokens from its secret storage on every connect.
// - `login`: its own `CLAUDE_CONFIG_DIR` under `~/.creaeditor/claude-accounts/<id>`, whose `projects`
//   folder (and settings, CLAUDE.md, agents, commands, skills, plugins) link to the default
//   `~/.claude`, so a chat's transcript resumes on every account. Signing in runs the bundled CLI's
//   `claude auth login` and publishes the browser URL it prints as `authUrl`.
//
// A chat runs on the first signed-in account that is not used up and keeps it until that account hits
// its limit; the limit hands the chat to the next account (auto switch) or ends the turn with an error
// carrying `SUBSCRIPTION_LIMIT_ERROR_META_KEY`. A refused sign-in during a chat is handled the same way.
//
// A `token` account is `unverified` until Anthropic accepted its token: the CLI's `accountInfo` only says
// a token is set, and the usage control request answers without readings (and without an error) for an
// invalid token and for an inference-only setup-token alike. So when a token arrives, when the account is
// added and when the user refreshes, an account without a usage reading runs a tiny real turn
// ({@link CLAUDE_PROBE_PROMPT} on Haiku): a 401 marks it `error`, a rejected limit marks it used up and
// its `rate_limit_event`s become its usage. The periodic refresh never runs that turn. Chats skip an
// unverified account while any verified one is available.

import type { AccountInfo, Options, SDKControlGetUsageResponse, SDKMessage, SDKRateLimitInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import { Limiter } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { ILogService } from '../../../log/common/log.js';
import type { AgentSignal } from '../../common/agent.js';
import { SUBSCRIPTION_LIMIT_ERROR_META_KEY, type ISubscriptionAccount, type ISubscriptionAccountsRequest, type ISubscriptionLimitErrorMeta, type ISubscriptionUsageWindow, type SubscriptionAccountKind, type SubscriptionAccountStatus } from '../../common/meta/subscriptionAccounts.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { createErrorResponsePart, type ErrorResponsePart } from '../../common/state/sessionState.js';
import { ISubscriptionAccountsService, type ISubscriptionAccountsProvider, type IStoredSubscriptionAccount } from '../shared/subscriptionAccountsService.js';
import { IClaudeAgentSdkService } from './claudeAgentSdkService.js';
import type { IClaudeAccountCredential } from './claudeProxyService.js';
import { buildModelEnumerationOptions } from './claudeSdkOptions.js';
import { isClaudeAccountSetUp } from './claudeTransportMode.js';

/** Id of the account the CLI finds by itself. */
export const CLAUDE_DEFAULT_ACCOUNT_ID = 'claude-default';

/** How long an account counts as used up when Claude did not say when its limit resets. */
const CLAUDE_DEFAULT_LIMIT_MS = 15 * 60 * 1000;
/** How long the check turn of a setup-token may take. */
const CLAUDE_PROBE_TIMEOUT_MS = 60 * 1000;
/** The cheapest model, for the check turn of a setup-token. */
const CLAUDE_PROBE_MODEL = 'haiku';
/** How long a `claude auth login` may wait for the browser. */
const CLAUDE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
/** Entries of the default config folder a `login` account shares, so chats move between accounts. */
const SHARED_CONFIG_ENTRIES = ['projects', 'settings.json', 'CLAUDE.md', 'agents', 'commands', 'skills', 'plugins'];
/** Prompt that continues an interrupted turn on another account. Sent to the model, never shown. */
export const CLAUDE_CONTINUE_PROMPT = 'Continue where you left off.';

/** The state of one Claude account, as the agent host keeps it. */
export interface IClaudeAccountState {
	readonly id: string;
	readonly label: string;
	readonly kind: SubscriptionAccountKind;
	readonly status: Exclude<SubscriptionAccountStatus, 'limited'>;
	readonly email?: string;
	readonly planType?: string;
	readonly usage?: readonly ISubscriptionUsageWindow[];
	readonly usageUpdatedAt?: number;
	readonly limitedUntil?: number;
	readonly error?: string;
	readonly authUrl?: string;
	/** Anthropic has not accepted this account's credential yet (or refused it): chats use it only as a last resort. */
	readonly unverified?: boolean;
}

/** What a session reports when its account hit a subscription limit during a turn. */
export interface IClaudeLimitSignal {
	readonly resetsAt?: number;
	readonly rateLimitType?: string;
	/** Set when Anthropic refused the account's credential instead of a usage limit. */
	readonly reason?: 'authentication';
}

/** What happens to a turn whose account hit its limit. */
export type ClaudeLimitDecision =
	| { readonly kind: 'retry'; readonly fromAccountLabel: string; readonly toAccountLabel: string; readonly reason?: 'authentication' }
	| { readonly kind: 'error'; readonly meta: ISubscriptionLimitErrorMeta };

// #region Pure helpers

/** Projects an account onto the published shape; an account whose limit has not reset yet is `limited`. */
export function toSubscriptionAccount(account: IClaudeAccountState, now: number): ISubscriptionAccount {
	const limited = account.limitedUntil !== undefined && account.limitedUntil > now;
	return {
		id: account.id,
		provider: 'claude',
		label: account.label,
		kind: account.kind,
		status: limited && account.status === 'signedIn' ? 'limited' : account.status,
		...(account.email ? { email: account.email } : {}),
		...(account.planType ? { planType: account.planType } : {}),
		...(account.usage ? { usage: account.usage } : {}),
		...(account.usageUpdatedAt !== undefined ? { usageUpdatedAt: account.usageUpdatedAt } : {}),
		...(limited ? { limitedUntil: account.limitedUntil } : {}),
		...(account.error ? { error: account.error } : {}),
		...(account.authUrl ? { authUrl: account.authUrl } : {}),
	};
}

/** Whether the account can take work at `now`: signed in, verified and not used up. */
export function isClaudeAccountAvailable(account: IClaudeAccountState, now: number): boolean {
	return account.status === 'signedIn' && !account.unverified && (account.limitedUntil === undefined || account.limitedUntil <= now);
}

/**
 * The account a chat runs on: its current account while that one is available, otherwise the first
 * available account in the user's order (skipping `excludeId`), otherwise undefined.
 */
export function selectClaudeAccount(accounts: readonly IClaudeAccountState[], now: number, current?: string, excludeId?: string): IClaudeAccountState | undefined {
	const currentAccount = current !== excludeId ? accounts.find(account => account.id === current) : undefined;
	if (currentAccount && isClaudeAccountAvailable(currentAccount, now)) {
		return currentAccount;
	}
	return accounts.find(account => account.id !== excludeId && isClaudeAccountAvailable(account, now));
}

/**
 * The environment a Claude subprocess needs to run on `account`. The machine's own login needs
 * nothing; a token or a config folder replaces every other credential the CLI would pick first.
 */
export function claudeAccountEnv(kind: SubscriptionAccountKind, credential: { readonly token?: string; readonly configDir?: string }): Record<string, string | undefined> {
	switch (kind) {
		case 'default':
			return {};
		case 'token':
			return { CLAUDE_CODE_OAUTH_TOKEN: credential.token, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined };
		case 'login':
			return { CLAUDE_CONFIG_DIR: credential.configDir, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined };
	}
}

/** Epoch milliseconds of a reset the CLI reports in epoch seconds (or milliseconds). */
function toEpochMs(value: number): number {
	return value < 1e12 ? value * 1000 : value;
}

function usageWindowLabel(kind: string): string {
	switch (kind) {
		case 'five_hour': return localize('claudeUsageWindow.fiveHour', "5-hour");
		case 'seven_day': return localize('claudeUsageWindow.weekly', "Weekly");
		case 'seven_day_opus': return localize('claudeUsageWindow.weeklyOpus', "Weekly (Opus)");
		case 'seven_day_sonnet': return localize('claudeUsageWindow.weeklySonnet', "Weekly (Sonnet)");
		case 'overage': return localize('claudeUsageWindow.overage', "Extra usage");
		default: return localize('claudeUsageWindow.other', "Weekly ({0})", kind);
	}
}

/** Maps the `/usage` rate limits of a Claude subscription onto usage windows, shortest first. */
export function claudeUsageWindows(rateLimits: SDKControlGetUsageResponse['rate_limits']): ISubscriptionUsageWindow[] {
	if (!rateLimits) {
		return [];
	}
	const windows: ISubscriptionUsageWindow[] = [];
	const add = (kind: string, label: string, window: { readonly utilization: number | null; readonly resets_at: string | null } | null | undefined) => {
		if (!window || window.utilization === null) {
			return;
		}
		const resetsAt = window.resets_at ? Date.parse(window.resets_at) : NaN;
		windows.push({ kind, label, usedPercent: Math.max(0, Math.min(100, window.utilization)), ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) });
	};
	for (const kind of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const) {
		add(kind, usageWindowLabel(kind), rateLimits[kind]);
	}
	for (const window of rateLimits.model_scoped ?? []) {
		add(`model:${window.display_name}`, localize('claudeUsageWindow.model', "Weekly ({0})", window.display_name), window);
	}
	return windows;
}

/** Merges one `rate_limit_event` into an account's usage windows. */
export function applyClaudeRateLimitInfo(usage: readonly ISubscriptionUsageWindow[] | undefined, info: SDKRateLimitInfo): readonly ISubscriptionUsageWindow[] | undefined {
	if (!info.rateLimitType || (info.utilization === undefined && info.status !== 'rejected')) {
		return usage;
	}
	const utilization = info.utilization === undefined ? 100 : info.utilization <= 1 ? info.utilization * 100 : info.utilization;
	const window: ISubscriptionUsageWindow = {
		kind: info.rateLimitType,
		label: usageWindowLabel(info.rateLimitType),
		usedPercent: info.status === 'rejected' ? 100 : Math.max(0, Math.min(100, utilization)),
		...(info.resetsAt !== undefined ? { resetsAt: toEpochMs(info.resetsAt) } : {}),
	};
	const others = (usage ?? []).filter(existing => existing.kind !== window.kind);
	return [...others, window];
}

/**
 * Whether an SDK message says the account ran out of its subscription: a `rate_limit_event` that
 * rejected the request, or an assistant message the CLI ended with a rate limit or billing error.
 * An assistant message the CLI ended with `authentication_failed` (after its own retries of the 401)
 * is a signal with reason `authentication`.
 */
export function getClaudeLimitSignal(message: SDKMessage): IClaudeLimitSignal | undefined {
	if (message.type === 'rate_limit_event' && message.rate_limit_info.status === 'rejected') {
		const info = message.rate_limit_info;
		return {
			...(info.resetsAt !== undefined ? { resetsAt: toEpochMs(info.resetsAt) } : {}),
			...(info.rateLimitType ? { rateLimitType: info.rateLimitType } : {}),
		};
	}
	if (message.type === 'assistant' && message.parent_tool_use_id === null && (message.error === 'rate_limit' || message.error === 'billing_error')) {
		return {};
	}
	if (message.type === 'assistant' && message.parent_tool_use_id === null && message.error === 'authentication_failed') {
		return { reason: 'authentication' };
	}
	return undefined;
}

/** The `_meta` of the error that ends a turn whose account hit its limit (or whose sign-in was refused). */
export function claudeLimitErrorMeta(account: IClaudeAccountState, next: IClaudeAccountState | undefined, reason?: 'authentication'): ISubscriptionLimitErrorMeta {
	return {
		provider: 'claude',
		accountId: account.id,
		accountLabel: account.label,
		...(account.limitedUntil !== undefined && !reason ? { resetsAt: account.limitedUntil } : {}),
		...(next ? { nextAccountId: next.id, nextAccountLabel: next.label } : {}),
		...(reason ? { reason } : {}),
	};
}

/** Prompt of the turn that checks a setup-token. Sent to the model, never shown. */
export const CLAUDE_PROBE_PROMPT = 'Reply with OK';

/** What the check turn of a setup-token found. */
export interface IClaudeProbeOutcome {
	/**
	 * - `ok`: Anthropic accepted the token.
	 * - `rejected`: Anthropic refused the token (401).
	 * - `limited`: the token works but its subscription is used up.
	 * - `failed`: no verdict (network error, timeout, CLI failure).
	 */
	readonly kind: 'ok' | 'rejected' | 'limited' | 'failed';
	/** Usage windows from the turn's `rate_limit_event`s. */
	readonly usage?: readonly ISubscriptionUsageWindow[];
	readonly resetsAt?: number;
	/** The CLI's own message for `rejected` and `failed`. */
	readonly error?: string;
}

/**
 * Reads the outcome of a check turn from its SDK messages and, when the stream threw, its error. The
 * CLI answers an invalid token with `api_retry` messages, an assistant message with
 * `error: 'authentication_failed'` and a `result` with `is_error` and `api_error_status: 401`.
 */
export function readClaudeProbeOutcome(messages: readonly SDKMessage[], error?: unknown): IClaudeProbeOutcome {
	let usage: readonly ISubscriptionUsageWindow[] | undefined;
	let limit: IClaudeLimitSignal | undefined;
	let authenticated = false;
	let rejected = false;
	let resultText: string | undefined;
	for (const message of messages) {
		if (message.type === 'rate_limit_event') {
			usage = applyClaudeRateLimitInfo(usage, message.rate_limit_info);
			authenticated = true;
		}
		const signal = getClaudeLimitSignal(message);
		if (signal?.reason === 'authentication') {
			rejected = true;
		} else if (signal && (!limit || signal.resetsAt !== undefined)) {
			// The assistant's rate limit error follows the event that says when the limit resets.
			limit = signal;
		} else if (!signal && message.type === 'assistant' && !message.error) {
			authenticated = true;
		}
		if (message.type === 'result') {
			resultText = message.subtype === 'success' ? message.result : message.errors.join('\n');
			if (message.is_error && message.subtype === 'success' && message.api_error_status === 401) {
				rejected = true;
			} else if (!message.is_error) {
				authenticated = true;
			}
		}
	}
	const usagePart = usage?.length ? { usage } : {};
	if (rejected) {
		return { kind: 'rejected', ...usagePart, ...(resultText ? { error: resultText } : {}) };
	}
	if (limit) {
		return { kind: 'limited', ...usagePart, ...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}) };
	}
	if (authenticated) {
		return { kind: 'ok', ...usagePart };
	}
	const errorText = error instanceof Error ? error.message : error !== undefined ? String(error) : resultText;
	return { kind: 'failed', ...usagePart, ...(errorText ? { error: errorText } : {}) };
}

function claudeTokenRejectedMessage(kind: SubscriptionAccountKind): string {
	return kind === 'token'
		? localize('claudeAccountTokenRejected', "Anthropic refused this setup-token. Create a new one with `claude setup-token` and add the account again.")
		: localize('claudeAccountLoginRejected', "Anthropic refused this account's sign-in. Sign in again.");
}

/**
 * How the outcome of a check turn changes an account. A `failed` check leaves a verified account as
 * it is and keeps an unverified one unverified, with a note.
 */
export function claudeProbePatch(account: IClaudeAccountState, outcome: IClaudeProbeOutcome, now: number): Partial<Omit<IClaudeAccountState, 'id' | 'kind'>> {
	const usage = outcome.usage?.length ? { usage: outcome.usage, usageUpdatedAt: now } : {};
	switch (outcome.kind) {
		case 'rejected':
			return { status: 'error', unverified: true, error: claudeTokenRejectedMessage(account.kind), usage: undefined, usageUpdatedAt: undefined, limitedUntil: undefined };
		case 'limited':
			return { status: 'signedIn', unverified: false, error: undefined, ...usage, limitedUntil: outcome.resetsAt ?? now + CLAUDE_DEFAULT_LIMIT_MS };
		case 'ok':
			return { status: 'signedIn', unverified: false, error: undefined, ...usage };
		case 'failed':
			return {
				status: account.status === 'error' && account.unverified ? 'error' : 'signedIn',
				...(account.unverified ? { error: localize('claudeAccountProbeFailed', "Could not check this account with Anthropic: {0} Refresh to try again.", outcome.error ?? '') } : {}),
			};
	}
}

// #endregion

// #region Turn limit tracking

/**
 * Watches one session's SDK messages and signals for subscription limits. When a turn hits one, the
 * tracker asks {@link resolve} what to do and rewrites the turn's end: a `retry` drops the turn's
 * error and completion so the agent can continue the turn on another account; an `error` ends the
 * turn with a resumable error that carries the limit `_meta`.
 */
export class ClaudeSubscriptionLimitTracker {
	private readonly _decisions = new Map<string, ClaudeLimitDecision>();
	private readonly _erroredTurns = new Set<string>();

	constructor(
		private readonly _resolve: (turnId: string, limit: IClaudeLimitSignal) => ClaudeLimitDecision | undefined,
		private readonly _onRateLimitInfo: (info: SDKRateLimitInfo) => void,
	) { }

	/** Records a limit (or a usage update) carried by a raw SDK message of `turnId`. */
	observe(message: SDKMessage, turnId: string | undefined): void {
		if (message.type === 'rate_limit_event') {
			this._onRateLimitInfo(message.rate_limit_info);
		}
		const limit = getClaudeLimitSignal(message);
		if (!limit || turnId === undefined) {
			return;
		}
		const previous = this._decisions.get(turnId);
		if (previous && limit.resetsAt === undefined) {
			return;
		}
		const decision = this._resolve(turnId, limit);
		if (decision) {
			this._decisions.set(turnId, decision);
		}
	}

	/** The signals to emit for `signal`. */
	filter(signal: AgentSignal): readonly AgentSignal[] {
		if (signal.kind !== 'action' || (signal.action.type !== ActionType.ChatError && signal.action.type !== ActionType.ChatTurnComplete)) {
			return [signal];
		}
		const turnId = signal.action.turnId;
		const decision = this._decisions.get(turnId);
		if (!decision) {
			return [signal];
		}
		if (decision.kind === 'retry') {
			return [];
		}
		if (signal.action.type === ActionType.ChatError) {
			this._erroredTurns.add(turnId);
			return [{ ...signal, action: { ...signal.action, part: this._errorPart(decision.meta, signal.action.part.error.message) } }];
		}
		// The turn completed without an error (the CLI ended it with its own message): end it with the limit error.
		this._decisions.delete(turnId);
		if (this._erroredTurns.delete(turnId)) {
			return [];
		}
		return [{
			kind: 'action',
			resource: signal.resource,
			action: { type: ActionType.ChatError, turnId, duration: signal.action.duration, part: this._errorPart(decision.meta, undefined) },
		}];
	}

	/** Whether `turnId` hit a limit that the agent should continue on another account; forgets it. */
	takeRetry(turnId: string): Extract<ClaudeLimitDecision, { kind: 'retry' }> | undefined {
		const decision = this._decisions.get(turnId);
		this._decisions.delete(turnId);
		this._erroredTurns.delete(turnId);
		return decision?.kind === 'retry' ? decision : undefined;
	}

	private _errorPart(meta: ISubscriptionLimitErrorMeta, sdkMessage: string | undefined): ErrorResponsePart {
		const message = meta.reason === 'authentication'
			? meta.nextAccountLabel
				? localize('claudeAccountRejected.withNext', "Anthropic refused the sign-in of Claude account {0}. Continue on {1}?", meta.accountLabel, meta.nextAccountLabel)
				: localize('claudeAccountRejected', "Anthropic refused the sign-in of Claude account {0}.", meta.accountLabel)
			: meta.nextAccountLabel
				? localize('claudeAccountLimit.withNext', "Claude account {0} hit its usage limit. Continue on {1}?", meta.accountLabel, meta.nextAccountLabel)
				: localize('claudeAccountLimit', "Claude account {0} hit its usage limit.", meta.accountLabel);
		// Resumable: after a `switchChat` request the client resumes the turn on the other account.
		return createErrorResponsePart({
			errorType: 'subscriptionLimit',
			message: sdkMessage ? `${message}\n\n${sdkMessage}` : message,
			_meta: { [SUBSCRIPTION_LIMIT_ERROR_META_KEY]: meta },
		}, true);
	}
}

// #endregion

/** What the Claude agent does for the account service besides reading accounts. */
export interface IClaudeSubscriptionAccountsDelegate {
	/** Moves `chat` to `accountId` and lets its next turn (or a resumed turn) run there. */
	switchChat(chat: string, accountId: string): Promise<void>;
	/** The default account's credential changed: the model list may change. */
	refreshModels(): void;
}

/**
 * The Claude accounts of the agent host: keeps their state and tokens, reads their usage through the
 * SDK, signs `login` accounts in and decides which account a chat runs on.
 */
/** How many accounts are read at the same time; every read runs its own Claude CLI process. */
const MAX_PARALLEL_ACCOUNT_READS = 2;

export class ClaudeSubscriptionAccounts extends Disposable implements ISubscriptionAccountsProvider {
	readonly provider = 'claude' as const;

	private readonly _onDidChangeAccounts = this._register(new Emitter<void>());
	readonly onDidChangeAccounts = this._onDidChangeAccounts.event;

	private _default: IClaudeAccountState | undefined;
	private readonly _accounts = new Map<string, IClaudeAccountState>();
	private readonly _tokens = new Map<string, string>();
	private readonly _chatAccounts = new Map<string, string>();
	private readonly _usageReads = new Map<string, { readonly validate: boolean; readonly read: Promise<void> }>();
	/** Each read starts a Claude CLI process, so with many accounts only a few run at once. */
	private readonly _readLimiter = this._register(new Limiter<void>(MAX_PARALLEL_ACCOUNT_READS));
	private readonly _logins = new Map<string, ChildProcess>();

	constructor(
		private readonly _delegate: IClaudeSubscriptionAccountsDelegate,
		@ISubscriptionAccountsService private readonly _accountsService: ISubscriptionAccountsService,
		@IClaudeAgentSdkService private readonly _sdkService: IClaudeAgentSdkService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		for (const stored of this._accountsService.getStoredAccounts('claude')) {
			this._accounts.set(stored.id, { id: stored.id, label: stored.label, kind: stored.kind, status: 'signedOut', ...(stored.kind === 'token' ? { unverified: true } : {}) });
		}
		this._register(toDisposable(() => {
			for (const login of this._logins.values()) {
				login.kill();
			}
			this._logins.clear();
		}));
		this._register(this._accountsService.registerProvider(this));
		// A `login` account keeps its credential on disk: read it now.
		queueMicrotask(() => {
			for (const account of this._accounts.values()) {
				if (account.kind === 'login') {
					void this._readAccount(account.id);
				}
			}
		});
	}

	// #region ISubscriptionAccountsProvider

	getAccounts(): readonly ISubscriptionAccount[] {
		const now = Date.now();
		return this._orderedAccounts().map(account => toSubscriptionAccount(account, now));
	}

	async handleRequest(request: ISubscriptionAccountsRequest): Promise<void> {
		switch (request.type) {
			case 'add':
				if (request.provider === 'claude') {
					await this._add(request.accountId, request.label, request.kind);
				}
				return;
			case 'remove':
				await this._remove(request.accountId);
				return;
			case 'rename':
				this._update(request.accountId, { label: request.label });
				this._storeAccounts();
				return;
			case 'move':
				this._move(request.accountId, request.index);
				return;
			case 'signIn':
				await this._signIn(request.accountId);
				return;
			case 'switchChat':
				this._chatAccounts.set(request.chat, request.accountId);
				await this._delegate.switchChat(request.chat, request.accountId);
				return;
			case 'refreshUsage':
				await this.refreshUsage({ explicit: true });
				return;
		}
	}

	/** An `explicit` refresh also checks token accounts without a usage reading with a tiny real turn. */
	async refreshUsage(options?: { readonly explicit?: boolean }): Promise<void> {
		await Promise.all(this._orderedAccounts()
			.filter(account => account.status === 'signedIn' || account.kind === 'login' || (account.kind === 'token' && this._tokens.has(account.id)))
			.map(account => this._readAccount(account.id, options?.explicit === true)));
	}

	// #endregion

	/** Whether any account besides the machine's own login exists, i.e. chats choose an account. */
	get hasAddedAccounts(): boolean {
		return this._accounts.size > 0;
	}

	/**
	 * Records what the SDK said about the machine's own login (from the model enumeration). An account
	 * that is not set up is not listed.
	 */
	setDefaultAccountInfo(info: AccountInfo | undefined): void {
		if (!isClaudeAccountSetUp(info) || (info?.apiProvider !== undefined && info.apiProvider !== 'firstParty')) {
			if (this._default) {
				this._default = undefined;
				this._onDidChangeAccounts.fire();
			}
			return;
		}
		this._default = {
			...this._default,
			id: CLAUDE_DEFAULT_ACCOUNT_ID,
			label: this._default?.label ?? localize('claudeDefaultAccount', "This Computer"),
			kind: 'default',
			status: 'signedIn',
			...(info?.email ? { email: info.email } : {}),
			...(info?.subscriptionType ? { planType: info.subscriptionType } : {}),
		};
		this._onDidChangeAccounts.fire();
		// Alone, the machine's login needs no usage reading until the client asks for one.
		if (this.hasAddedAccounts && this._default.usageUpdatedAt === undefined) {
			void this._readAccount(CLAUDE_DEFAULT_ACCOUNT_ID);
		}
	}

	/** Receives (or, with an empty token, revokes) the setup-token of a `token` account. */
	setToken(accountId: string, token: string): boolean {
		const account = this._accounts.get(accountId);
		if (!account) {
			// The token may arrive before the `add` request: keep it for the account.
			if (token) {
				this._tokens.set(accountId, token);
			} else {
				this._tokens.delete(accountId);
			}
			return true;
		}
		if (account.kind !== 'token') {
			return false;
		}
		if (!token) {
			this._tokens.delete(accountId);
			this._update(accountId, { status: 'signedOut', usage: undefined, email: undefined, planType: undefined, unverified: true });
			return true;
		}
		if (this._tokens.get(accountId) === token && account.status === 'signedIn') {
			return true;
		}
		if (this._tokens.get(accountId) !== token) {
			this._update(accountId, { unverified: true });
		}
		this._tokens.set(accountId, token);
		void this._readAccount(accountId, true);
		return true;
	}

	/**
	 * The account `chat` runs on now: its current one while available, else the first available one
	 * (remembered for the chat). Undefined when no added accounts exist, so the session keeps the
	 * CLI's own credential resolution.
	 */
	credentialForChat(chat: string): IClaudeAccountCredential | undefined {
		if (!this.hasAddedAccounts) {
			return undefined;
		}
		const accounts = this._orderedAccounts();
		const current = this._chatAccounts.get(chat);
		const selected = selectClaudeAccount(accounts, Date.now(), current)
			?? accounts.find(account => account.id === current)
			?? accounts.find(account => account.status === 'signedIn');
		if (!selected) {
			return undefined;
		}
		this._chatAccounts.set(chat, selected.id);
		return this._credential(selected);
	}

	/** An account that can stand in for the machine's own login to list the native models. */
	credentialForModels(): IClaudeAccountCredential | undefined {
		const account = selectClaudeAccount([...this._accounts.values()], Date.now());
		return account ? this._credential(account) : undefined;
	}

	/**
	 * `accountId` (the account a session of `chat` ran on) hit its limit: marks it used up and decides
	 * whether the turn continues on the next account (auto switch) or ends with the limit error.
	 * Anthropic refusing an added account's credential is handled the same way, but marks the account
	 * `error` until it is checked again. Undefined without added accounts, and for a refused machine
	 * login: the turn ends as the CLI ended it.
	 */
	handleLimit(chat: string, accountId: string | undefined, limit: IClaudeLimitSignal): ClaudeLimitDecision | undefined {
		if (!this.hasAddedAccounts) {
			// One account: the CLI's own limit message says it all.
			return undefined;
		}
		const id = accountId ?? CLAUDE_DEFAULT_ACCOUNT_ID;
		const now = Date.now();
		const reason = limit.reason;
		if (reason === 'authentication') {
			const refused = this._find(id);
			if (!refused || refused.kind === 'default') {
				return undefined;
			}
			this._update(id, { status: 'error', unverified: true, error: claudeTokenRejectedMessage(refused.kind), usage: undefined, usageUpdatedAt: undefined });
		} else {
			this._update(id, { limitedUntil: limit.resetsAt ?? now + CLAUDE_DEFAULT_LIMIT_MS });
		}
		const account = this._find(id) ?? { id, label: localize('claudeDefaultAccount', "This Computer"), kind: 'default' as const, status: 'signedIn' as const };
		const next = selectClaudeAccount(this._orderedAccounts(), now, undefined, id);
		if (!reason) {
			void this._readAccount(id);
		}
		if (next && this._accountsService.isAutoSwitchEnabled()) {
			this._chatAccounts.set(chat, next.id);
			return { kind: 'retry', fromAccountLabel: account.label, toAccountLabel: next.label, ...(reason ? { reason } : {}) };
		}
		return { kind: 'error', meta: claudeLimitErrorMeta(account, next, reason) };
	}

	/** Merges a `rate_limit_event` of a session running on `accountId` into that account's usage. */
	applyRateLimitInfo(accountId: string | undefined, info: SDKRateLimitInfo): void {
		const id = accountId ?? CLAUDE_DEFAULT_ACCOUNT_ID;
		const account = this._find(id);
		if (!account) {
			return;
		}
		this._update(id, { usage: applyClaudeRateLimitInfo(account.usage, info), usageUpdatedAt: Date.now() });
	}

	private _credential(account: IClaudeAccountState): IClaudeAccountCredential | undefined {
		if (account.kind === 'default') {
			return { id: account.id, env: {} };
		}
		return { id: account.id, env: claudeAccountEnv(account.kind, { token: this._tokens.get(account.id), configDir: this._configDir(account.id) }) };
	}

	private _orderedAccounts(): IClaudeAccountState[] {
		return [...(this._default ? [this._default] : []), ...this._accounts.values()];
	}

	private _find(id: string): IClaudeAccountState | undefined {
		return id === CLAUDE_DEFAULT_ACCOUNT_ID ? this._default : this._accounts.get(id);
	}

	private _update(id: string, patch: Partial<Omit<IClaudeAccountState, 'id' | 'kind'>>): void {
		const account = this._find(id);
		if (!account) {
			return;
		}
		const updated = { ...account, ...patch };
		if (id === CLAUDE_DEFAULT_ACCOUNT_ID) {
			this._default = updated;
		} else {
			this._accounts.set(id, updated);
		}
		this._onDidChangeAccounts.fire();
	}

	private _storeAccounts(): void {
		const stored: IStoredSubscriptionAccount[] = [...this._accounts.values()].map(account => ({ id: account.id, label: account.label, kind: account.kind === 'login' ? 'login' : 'token' }));
		this._accountsService.setStoredAccounts('claude', stored);
	}

	private async _add(id: string, label: string, kind: 'token' | 'login'): Promise<void> {
		if (this._accounts.has(id) || id === CLAUDE_DEFAULT_ACCOUNT_ID) {
			return;
		}
		this._accounts.set(id, { id, label, kind, status: 'signedOut', ...(kind === 'token' ? { unverified: true } : {}) });
		this._storeAccounts();
		this._onDidChangeAccounts.fire();
		if (kind === 'login') {
			await this._signIn(id);
		} else if (this._tokens.has(id)) {
			await this._readAccount(id, true);
		}
	}

	private async _remove(id: string): Promise<void> {
		const account = this._accounts.get(id);
		if (!account) {
			return;
		}
		this._logins.get(id)?.kill();
		this._logins.delete(id);
		this._accounts.delete(id);
		this._tokens.delete(id);
		for (const [chat, accountId] of this._chatAccounts) {
			if (accountId === id) {
				this._chatAccounts.delete(chat);
			}
		}
		this._storeAccounts();
		this._onDidChangeAccounts.fire();
		if (account.kind === 'login') {
			await this._removeConfigDir(id);
		}
	}

	private _move(id: string, index: number): void {
		const account = this._accounts.get(id);
		if (!account) {
			return;
		}
		// The default account is always first; indices count it when it is listed.
		const offset = this._default ? 1 : 0;
		const others = [...this._accounts.values()].filter(other => other.id !== id);
		others.splice(Math.max(0, Math.min(others.length, index - offset)), 0, account);
		this._accounts.clear();
		for (const other of others) {
			this._accounts.set(other.id, other);
		}
		this._storeAccounts();
		this._onDidChangeAccounts.fire();
	}

	/**
	 * Reads account info and usage of one account with a throwaway SDK query. With `validate`, an added
	 * account without a usage reading also runs the check turn (see {@link _probe}).
	 */
	private _readAccount(id: string, validate = false): Promise<void> {
		const pending = this._usageReads.get(id);
		if (pending && (pending.validate || !validate)) {
			return pending.read;
		}
		const queued = () => this._store.isDisposed ? Promise.resolve() : this._readLimiter.queue(() => this._doReadAccount(id, validate));
		const read = (pending ? pending.read.then(queued) : queued()).finally(() => {
			if (this._usageReads.get(id)?.read === read) {
				this._usageReads.delete(id);
			}
		});
		this._usageReads.set(id, { validate, read });
		return read;
	}

	private async _doReadAccount(id: string, validate: boolean): Promise<void> {
		const account = this._find(id);
		if (!account || !(await this._sdkService.canLoadWithoutDownload())) {
			return;
		}
		if (account.kind === 'token' && !this._tokens.has(id)) {
			return;
		}
		const credential = this._credential(account);
		const neverYieldingPrompt: AsyncIterable<SDKUserMessage> = {
			[Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => { /* never resolves */ }) }),
		};
		const options = buildModelEnumerationOptions(credential?.env);
		let info: AccountInfo;
		let usage: SDKControlGetUsageResponse | undefined;
		try {
			const query = await this._sdkService.query({ prompt: neverYieldingPrompt, options });
			try {
				info = await query.accountInfo();
				if (!isClaudeAccountSetUp(info)) {
					this._update(id, { status: 'signedOut', usage: undefined });
					return;
				}
				// The usage control request is experimental: an account without a reading is still signed in.
				try {
					usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
				} catch (error) {
					this._logService.warn(`[Claude] Failed to read the usage of subscription account ${id}`, error);
				}
			} finally {
				query.close();
				options.abortController?.abort();
			}
		} catch (error) {
			this._logService.warn(`[Claude] Failed to read subscription account ${id}`, error);
			this._update(id, { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		const hasReading = usage?.rate_limits_available === true;
		const before = this._find(id);
		if (!before) {
			return;
		}
		// Without a reading, an added account's credential is only known to work after a real turn.
		const probe = validate && !hasReading && before.kind !== 'default' && (before.kind === 'token' || before.unverified)
			? await this._probe(id, credential?.env)
			: undefined;
		const current = this._find(id);
		if (!current) {
			return;
		}
		const windows = claudeUsageWindows(usage?.rate_limits ?? null);
		const now = Date.now();
		const full = windows.filter(window => window.usedPercent >= 100 && window.resetsAt !== undefined && window.resetsAt > now);
		const wasSignedIn = current.status === 'signedIn';
		this._update(id, {
			status: current.status === 'error' && current.unverified && !hasReading ? 'error' : 'signedIn',
			...(hasReading || !current.unverified ? { error: undefined } : {}),
			authUrl: undefined,
			...(info.email ? { email: info.email } : {}),
			...(usage?.subscription_type ?? info.subscriptionType ? { planType: usage?.subscription_type ?? info.subscriptionType } : {}),
			...(hasReading ? { usage: windows, usageUpdatedAt: now, unverified: false } : {}),
			limitedUntil: full.length ? Math.max(...full.map(window => window.resetsAt!)) : current.limitedUntil !== undefined && current.limitedUntil > now ? current.limitedUntil : undefined,
		});
		if (probe) {
			const updated = this._find(id);
			if (updated) {
				this._update(id, claudeProbePatch(updated, probe, now));
			}
		}
		if (!wasSignedIn && this._find(id)?.status === 'signedIn' && id !== CLAUDE_DEFAULT_ACCOUNT_ID) {
			// A first signed-in account can stand in for a missing machine login.
			this._delegate.refreshModels();
		}
	}

	/**
	 * Runs the check turn of an added account: {@link CLAUDE_PROBE_PROMPT} on the cheapest model, one
	 * turn, no tools, no transcript. Only the user's explicit actions run it (adding the account, a new
	 * token, a refresh), never the periodic refresh, as it spends a little of the subscription.
	 */
	private async _probe(id: string, env: Record<string, string | undefined> | undefined): Promise<IClaudeProbeOutcome> {
		const options: Options = {
			...buildModelEnumerationOptions(env),
			model: CLAUDE_PROBE_MODEL,
			maxTurns: 1,
			tools: [],
			systemPrompt: CLAUDE_PROBE_PROMPT,
			persistSession: false,
			settingSources: [],
		};
		const messages: SDKMessage[] = [];
		const timeout = setTimeout(() => options.abortController?.abort(), CLAUDE_PROBE_TIMEOUT_MS);
		let error: unknown;
		try {
			const query = await this._sdkService.query({ prompt: CLAUDE_PROBE_PROMPT, options });
			try {
				for await (const message of query) {
					messages.push(message);
					if (message.type === 'result') {
						break;
					}
				}
			} catch (streamError) {
				// The CLI also throws after an error result; the result already says what happened.
				error = streamError;
			} finally {
				query.close();
			}
		} catch (startError) {
			error = startError;
		} finally {
			clearTimeout(timeout);
			options.abortController?.abort();
		}
		const outcome = readClaudeProbeOutcome(messages, error ?? (messages.length ? undefined : localize('claudeAccountProbeTimeout', "No answer.")));
		this._logService.info(`[Claude] Checked subscription account ${id}: ${outcome.kind}${outcome.error ? ` (${outcome.error})` : ''}`);
		return outcome;
	}

	// #region login accounts

	private _configDir(id: string): string {
		return join(this._environmentService.userHome.fsPath, '.creaeditor', 'claude-accounts', id);
	}

	private _defaultConfigDir(): string {
		return process.env['CLAUDE_CONFIG_DIR'] || join(this._environmentService.userHome.fsPath, '.claude');
	}

	/** Creates the account's config folder with links to the shared parts of the default one. */
	private async _prepareConfigDir(id: string): Promise<string> {
		const dir = this._configDir(id);
		const shared = this._defaultConfigDir();
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.mkdir(join(shared, 'projects'), { recursive: true });
		for (const entry of SHARED_CONFIG_ENTRIES) {
			const target = join(shared, entry);
			const link = join(dir, entry);
			try {
				await fs.promises.lstat(link);
				continue;
			} catch {
				// Not linked yet.
			}
			try {
				const stat = await fs.promises.stat(target);
				await fs.promises.symlink(target, link, stat.isDirectory() ? 'junction' : 'file');
			} catch {
				// The default folder has no such entry.
			}
		}
		return dir;
	}

	private async _removeConfigDir(id: string): Promise<void> {
		const dir = this._configDir(id);
		try {
			const cli = await this._sdkService.resolveCliExecutable?.();
			if (cli) {
				await new Promise<void>(resolve => {
					const logout = spawn(cli, ['auth', 'logout'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir, ELECTRON_RUN_AS_NODE: undefined }, stdio: 'ignore' });
					logout.on('error', () => resolve());
					logout.on('exit', () => resolve());
				});
			}
			// Only the links and the account's own files: the shared entries are links, not copies.
			await fs.promises.rm(dir, { recursive: true, force: true });
		} catch (error) {
			this._logService.warn(`[Claude] Failed to remove the config folder of account ${id}`, error);
		}
	}

	private _manualLoginError(dir: string): string {
		return localize('claudeAccountManualLogin', "Run `CLAUDE_CONFIG_DIR=\"{0}\" claude auth login` in a terminal, then refresh the account.", dir);
	}

	private async _signIn(id: string): Promise<void> {
		const account = this._accounts.get(id);
		if (!account || account.kind !== 'login' || this._logins.has(id)) {
			if (account?.kind === 'token' && !this._tokens.has(id)) {
				this._update(id, { status: 'signedOut', error: localize('claudeAccountTokenMissing', "Paste a token from `claude setup-token` to sign in.") });
			}
			return;
		}
		const dir = await this._prepareConfigDir(id);
		const cli = await this._sdkService.resolveCliExecutable?.();
		if (!cli) {
			this._update(id, { status: 'signedOut', error: this._manualLoginError(dir) });
			return;
		}
		this._update(id, { status: 'signingIn', error: undefined, authUrl: undefined });
		const login = spawn(cli, ['auth', 'login', '--claudeai'], {
			env: { ...process.env, CLAUDE_CONFIG_DIR: dir, ELECTRON_RUN_AS_NODE: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this._logins.set(id, login);
		const timeout = setTimeout(() => login.kill(), CLAUDE_LOGIN_TIMEOUT_MS);
		const onOutput = (data: Buffer) => {
			const url = /https:\/\/\S+/.exec(data.toString())?.[0];
			if (url && !this._find(id)?.authUrl) {
				this._update(id, { authUrl: url });
			}
		};
		login.stdout?.on('data', onOutput);
		login.stderr?.on('data', onOutput);
		const exitCode = await new Promise<number | null>(resolve => {
			login.on('error', () => resolve(null));
			login.on('exit', code => resolve(code));
		});
		clearTimeout(timeout);
		if (this._logins.get(id) !== login) {
			return;
		}
		this._logins.delete(id);
		if (exitCode === 0) {
			this._update(id, { authUrl: undefined });
			await this._readAccount(id, true);
			return;
		}
		this._update(id, { status: 'signedOut', authUrl: undefined, error: this._manualLoginError(dir) });
	}

	// #endregion
}
