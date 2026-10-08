/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: several Claude and Codex subscription accounts per provider, pooled behind one model
// picker entry. The agent host owns the accounts and publishes them as root state; clients change them
// by writing a request into the root config, which the agent host handles and clears (the same pattern
// as the Codex sign-in request). Tokens never appear in root state: a pasted Claude setup-token reaches
// the agent host through `authenticate` with {@link subscriptionAccountTokenResource}.

import type { RootState } from '../state/protocol/state.js';

/** Root `_meta` key holding {@link ISubscriptionAccountsState}. */
export const SUBSCRIPTION_ACCOUNTS_META_KEY = 'creaeditor.subscriptionAccounts';
/** Root config key a client writes an {@link ISubscriptionAccountsRequest} to. */
export const SUBSCRIPTION_ACCOUNTS_REQUEST_KEY = 'creaeditor.subscriptionAccounts.request';
/** Root config key holding whether a used-up account hands the chat to the next account without asking. */
export const SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY = 'creaeditor.subscriptionAccounts.autoSwitch';

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
	| { readonly id: string; readonly type: 'switchChat'; readonly chat: string; readonly accountId: string };

/** The `authenticate` resource that carries the setup-token of a `token` account. */
export function subscriptionAccountTokenResource(accountId: string): string {
	return `creaeditor-subscription-account:${accountId}`;
}

export function parseSubscriptionAccountTokenResource(resource: string): string | undefined {
	const prefix = 'creaeditor-subscription-account:';
	return resource.startsWith(prefix) ? resource.slice(prefix.length) : undefined;
}

/**
 * `_meta` of a chat error when the chat's account hit its limit. Without auto-switch the client offers
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
}

export function readSubscriptionAccountsState(state: RootState | undefined): ISubscriptionAccountsState {
	const value = state?._meta?.[SUBSCRIPTION_ACCOUNTS_META_KEY];
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
