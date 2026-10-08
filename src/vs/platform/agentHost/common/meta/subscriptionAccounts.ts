/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: several Claude and Codex subscription accounts per provider, pooled behind one model
// picker entry. The agent host owns the accounts and publishes them as root state; clients change them
// by writing a request into the root config, which the agent host handles and clears (the same pattern
// as the Codex sign-in request). Tokens never appear in root state: a pasted Claude setup-token reaches
// the agent host through `authenticate` with {@link subscriptionAccountTokenResource}.

import { localize } from '../../../../nls.js';
import type { RootState } from '../state/protocol/state.js';

/** Root `_meta` key holding {@link ISubscriptionAccountsState}. */
export const SUBSCRIPTION_ACCOUNTS_META_KEY = 'creaeditor.subscriptionAccounts';
/** Root config key a client writes an {@link ISubscriptionAccountsRequest} to. */
export const SUBSCRIPTION_ACCOUNTS_REQUEST_KEY = 'creaeditor.subscriptionAccounts.request';
/** Root config key holding whether a used-up account hands the chat to the next account without asking. */
export const SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY = 'creaeditor.subscriptionAccounts.autoSwitch';
/**
 * Root config key holding the used share (1-99) from which an account counts as nearly used up, or 0 when
 * usage warnings are off: chats on it get a note, and the agent host reads its usage more often.
 */
export const SUBSCRIPTION_ACCOUNTS_WARNING_THRESHOLD_KEY = 'creaeditor.subscriptionAccounts.warningThreshold';

/** The default {@link SUBSCRIPTION_ACCOUNTS_WARNING_THRESHOLD_KEY}. */
export const SUBSCRIPTION_USAGE_WARNING_DEFAULT_PERCENT = 80;
/** The second, last warning before the limit. */
export const SUBSCRIPTION_USAGE_WARNING_HIGH_PERCENT = 95;

export type SubscriptionProvider = 'claude' | 'codex';

/**
 * How the account signs in:
 * - `token`: a Claude `claude setup-token` token, passed to the Claude CLI as `CLAUDE_CODE_OAUTH_TOKEN`.
 * - `login`: a browser login kept in the account's own config folder (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`),
 *   whose transcripts and settings are linked to the default folder so a chat can move between accounts.
 * - `default`: the login the CLI finds by itself (`~/.claude`, `~/.codex`), always listed first when present.
 */
export type SubscriptionAccountKind = 'token' | 'login' | 'default';

export type SubscriptionAccountStatus = 'signedIn' | 'signedOut' | 'signingIn' | 'limited' | 'error';

/** One usage window of a subscription, such as the 5-hour or the weekly limit. */
export interface ISubscriptionUsageWindow {
	/** `five_hour`, `seven_day`, `seven_day_opus`, ... or the window length for Codex (`300m`). */
	readonly kind: string;
	/** Human readable name, e.g. "5-hour" or "Weekly". */
	readonly label: string;
	/** 0-100. */
	readonly usedPercent: number;
	/** Epoch milliseconds. */
	readonly resetsAt?: number;
}

export interface ISubscriptionAccount {
	readonly id: string;
	readonly provider: SubscriptionProvider;
	/** Name the user gave the account. */
	readonly label: string;
	readonly kind: SubscriptionAccountKind;
	readonly status: SubscriptionAccountStatus;
	readonly email?: string;
	readonly planType?: string;
	readonly usage?: readonly ISubscriptionUsageWindow[];
	/** Epoch milliseconds of the last usage reading. */
	readonly usageUpdatedAt?: number;
	/** Epoch milliseconds until which the account is used up, when it hit a limit. */
	readonly limitedUntil?: number;
	readonly error?: string;
	/** Browser URL to finish a `login` sign-in, while `status` is `signingIn`. */
	readonly authUrl?: string;
}

export interface ISubscriptionAccountsState {
	/** In the order they are tried. */
	readonly accounts: readonly ISubscriptionAccount[];
}

export type ISubscriptionAccountsRequest =
	| { readonly id: string; readonly type: 'add'; readonly provider: SubscriptionProvider; readonly kind: 'token' | 'login'; readonly label: string; readonly accountId: string }
	| { readonly id: string; readonly type: 'remove'; readonly accountId: string }
	| { readonly id: string; readonly type: 'rename'; readonly accountId: string; readonly label: string }
	| { readonly id: string; readonly type: 'move'; readonly accountId: string; readonly index: number }
	| { readonly id: string; readonly type: 'signIn'; readonly accountId: string }
	| { readonly id: string; readonly type: 'refreshUsage'; readonly provider?: SubscriptionProvider }
	/** Continue the chat's interrupted turn on another account, after the user agreed to switch. */
	| { readonly id: string; readonly type: 'switchChat'; readonly chat: string; readonly accountId: string }
	/**
	 * Pins the chat to `accountId`: its next requests run there (the limit flow still offers another
	 * account when it is used up). Without `accountId` the chat goes back to the pool.
	 */
	| { readonly id: string; readonly type: 'pinChat'; readonly chat: string; readonly provider: SubscriptionProvider; readonly accountId?: string };

/** The `authenticate` resource that carries the setup-token of a `token` account. */
export function subscriptionAccountTokenResource(accountId: string): string {
	return `creaeditor-subscription-account:${accountId}`;
}

export function parseSubscriptionAccountTokenResource(resource: string): string | undefined {
	const prefix = 'creaeditor-subscription-account:';
	return resource.startsWith(prefix) ? resource.slice(prefix.length) : undefined;
}

/**
 * `_meta` of a chat error when the chat's account hit its limit (or its sign-in was refused). Without auto-switch the client offers
 * to continue on {@link nextAccountId} by sending a `switchChat` request.
 */
export const SUBSCRIPTION_LIMIT_ERROR_META_KEY = 'creaeditor.subscriptionLimit';

export interface ISubscriptionLimitErrorMeta {
	readonly provider: SubscriptionProvider;
	readonly accountId: string;
	readonly accountLabel: string;
	readonly resetsAt?: number;
	readonly nextAccountId?: string;
	readonly nextAccountLabel?: string;
	/** Why the account stopped: its usage limit (the default) or its provider refused its sign-in. */
	readonly reason?: 'usageLimit' | 'authentication';
}

/**
 * The agent host publishes the accounts as a transient root config value (root `_meta` cannot change
 * after the first snapshot); `_meta` is still read for hosts that put it there.
 */
export function readSubscriptionAccountsState(state: RootState | undefined): ISubscriptionAccountsState {
	const value = state?.config?.values[SUBSCRIPTION_ACCOUNTS_META_KEY] ?? state?._meta?.[SUBSCRIPTION_ACCOUNTS_META_KEY];
	if (!value || typeof value !== 'object' || !Array.isArray((value as ISubscriptionAccountsState).accounts)) {
		return { accounts: [] };
	}
	return value as ISubscriptionAccountsState;
}

/** Remaining share (0-100) of the tightest window of an account, or undefined without a reading. */
export function getRemainingPercent(account: ISubscriptionAccount): number | undefined {
	if (account.status === 'limited') {
		return 0;
	}
	if (!account.usage?.length) {
		return undefined;
	}
	return Math.max(0, 100 - Math.max(...account.usage.map(window => window.usedPercent)));
}

/**
 * The pool of one provider: the average remaining share over its signed-in accounts that have a
 * reading, and how many of them can take work now.
 */
export function getPoolSummary(accounts: readonly ISubscriptionAccount[], provider: SubscriptionProvider): { readonly remainingPercent: number | undefined; readonly available: number; readonly total: number } {
	const own = accounts.filter(account => account.provider === provider && account.status !== 'signedOut');
	const readings = own.map(getRemainingPercent).filter((value): value is number => value !== undefined);
	return {
		remainingPercent: readings.length ? Math.round(readings.reduce((sum, value) => sum + value, 0) / readings.length) : undefined,
		available: own.filter(account => account.status === 'signedIn' && getRemainingPercent(account) !== 0).length,
		total: own.length,
	};
}

/** The window of an account that is closest to its limit, and how close: level 1 from the threshold, 2 from 95%. */
export interface ISubscriptionUsageWarning {
	readonly window: ISubscriptionUsageWindow;
	readonly level: 1 | 2;
	/** Names the account, window, reset period and level, so each warning is given once. */
	readonly key: string;
}

/**
 * The usage warning of an account: its tightest window once it passed `threshold` (and again at
 * {@link SUBSCRIPTION_USAGE_WARNING_HIGH_PERCENT}), undefined below it, when warnings are off
 * (`threshold` 0) and once the account is used up (the limit flow takes over then).
 */
export function getUsageWarning(account: ISubscriptionAccount, threshold: number): ISubscriptionUsageWarning | undefined {
	if (threshold <= 0 || account.status !== 'signedIn' || !account.usage?.length) {
		return undefined;
	}
	const window = account.usage.reduce((tightest, candidate) => candidate.usedPercent > tightest.usedPercent ? candidate : tightest);
	if (window.usedPercent >= 100 || window.usedPercent < threshold) {
		return undefined;
	}
	const high = Math.max(threshold, SUBSCRIPTION_USAGE_WARNING_HIGH_PERCENT);
	const level = high > threshold && window.usedPercent >= high ? 2 : 1;
	// Reset times can move by a few seconds between readings: the period is named by its ten minutes.
	const period = window.resetsAt !== undefined ? Math.round(window.resetsAt / 600_000) : '';
	return { window, level, key: `${account.id}|${window.kind}|${period}|${level}` };
}

/** A short duration such as "45m", "3h", "3h 20m" or "2d 4h". */
export function formatShortDuration(milliseconds: number): string {
	const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
	if (minutes < 60) {
		return localize('subscriptionDuration.minutes', "{0}m", minutes);
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest && hours < 10 ? localize('subscriptionDuration.hoursMinutes', "{0}h {1}m", hours, rest) : localize('subscriptionDuration.hours', "{0}h", hours);
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? localize('subscriptionDuration.daysHours', "{0}d {1}h", days, restHours) : localize('subscriptionDuration.days', "{0}d", days);
}

/**
 * The warning text, e.g. "The Claude account Work has used 82% of its 5-hour limit (resets in 1h 12m)."
 */
export function formatUsageWarning(account: ISubscriptionAccount, warning: ISubscriptionUsageWarning, now: number): string {
	const provider = account.provider === 'claude' ? localize('subscriptionProvider.claude', "Claude") : localize('subscriptionProvider.codex', "Codex");
	const used = Math.floor(warning.window.usedPercent);
	return warning.window.resetsAt !== undefined && warning.window.resetsAt > now
		? localize('subscriptionUsageWarning.resets', "The {0} account {1} has used {2}% of its {3} limit (resets in {4}).", provider, account.label, used, warning.window.label, formatShortDuration(warning.window.resetsAt - now))
		: localize('subscriptionUsageWarning', "The {0} account {1} has used {2}% of its {3} limit.", provider, account.label, used, warning.window.label);
}
