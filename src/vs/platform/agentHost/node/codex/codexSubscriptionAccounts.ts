/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Codex side of the pooled subscription accounts: usage windows, which account takes
// the next chat, and when a turn failed because the account's subscription is used up.

import { localize } from '../../../../nls.js';
import type { ICodexAccountRateLimitInfo } from '../../common/codexAccount.js';
import type { ISubscriptionAccount, ISubscriptionLimitErrorMeta, ISubscriptionUsageWindow } from '../../common/meta/subscriptionAccounts.js';
import type { TurnError } from './protocol/generated/v2/TurnError.js';

/** How long an account counts as used up when Codex did not say when its limit resets. */
const CODEX_DEFAULT_LIMIT_MS = 60 * 60 * 1000;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** Human readable name of a Codex rate limit window, such as "5-hour" or "Weekly". */
export function codexUsageWindowLabel(windowDurationMins: number | undefined): string {
	if (windowDurationMins === undefined) {
		return localize('codexUsageWindow.unknown', "Usage");
	}
	if (windowDurationMins === MINUTES_PER_WEEK) {
		return localize('codexUsageWindow.weekly', "Weekly");
	}
	if (windowDurationMins % MINUTES_PER_DAY === 0) {
		return localize('codexUsageWindow.days', "{0}-day", windowDurationMins / MINUTES_PER_DAY);
	}
	if (windowDurationMins % MINUTES_PER_HOUR === 0) {
		return localize('codexUsageWindow.hours', "{0}-hour", windowDurationMins / MINUTES_PER_HOUR);
	}
	return localize('codexUsageWindow.minutes', "{0}-minute", windowDurationMins);
}

/** Maps Codex rate limit windows (reset times in epoch seconds) to subscription usage windows, shortest first. */
export function codexUsageWindows(rateLimits: readonly ICodexAccountRateLimitInfo[]): ISubscriptionUsageWindow[] {
	return [...rateLimits]
		.sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity))
		.map(window => ({
			kind: window.windowDurationMins === undefined ? 'unknown' : `${window.windowDurationMins}m`,
			label: codexUsageWindowLabel(window.windowDurationMins),
			usedPercent: window.usedPercent,
			...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt * 1000 } : {}),
		}));
}

/**
 * Whether a failed turn ran out of the account's subscription. `rateLimitExceeded` is a short-lived
 * request throttle that Codex retries itself, so it does not make the account used up.
 */
export function isCodexUsageLimitError(error: TurnError | null | undefined): boolean {
	return error?.codexErrorInfo === 'usageLimitExceeded';
}

/** Until when an account that hit its limit stays used up: the latest reset of a full window. */
export function codexLimitedUntil(usage: readonly ISubscriptionUsageWindow[] | undefined, now: number): number {
	const resets = (usage ?? []).filter(window => window.usedPercent >= 100 && window.resetsAt !== undefined && window.resetsAt > now).map(window => window.resetsAt!);
	if (resets.length) {
		return Math.max(...resets);
	}
	const anyReset = (usage ?? []).map(window => window.resetsAt).filter((resetsAt): resetsAt is number => resetsAt !== undefined && resetsAt > now);
	return anyReset.length ? Math.min(...anyReset) : now + CODEX_DEFAULT_LIMIT_MS;
}

/** Whether the account can take work at `now`: signed in and not (or no longer) used up. */
export function isCodexAccountAvailable(account: ISubscriptionAccount, now: number): boolean {
	if (account.provider !== 'codex') {
		return false;
	}
	if (account.limitedUntil !== undefined && account.limitedUntil > now) {
		return false;
	}
	return account.status === 'signedIn' || account.status === 'limited';
}

/** The first account, in the user's order, that can take work, skipping `excludeId`. */
export function selectCodexAccount(accounts: readonly ISubscriptionAccount[], now: number, excludeId?: string): ISubscriptionAccount | undefined {
	return accounts.find(account => account.id !== excludeId && isCodexAccountAvailable(account, now));
}

/** The `_meta` of the chat error raised when `account` hit its limit and the chat was not moved on. */
export function codexLimitErrorMeta(account: ISubscriptionAccount, next: ISubscriptionAccount | undefined): ISubscriptionLimitErrorMeta {
	return {
		provider: 'codex',
		accountId: account.id,
		accountLabel: account.label,
		...(account.limitedUntil !== undefined ? { resetsAt: account.limitedUntil } : {}),
		...(next ? { nextAccountId: next.id, nextAccountLabel: next.label } : {}),
	};
}

/**
 * The input that continues a turn Codex refused because the account was used up. The thread already
 * holds the request and any work done before the limit, so the model is asked to pick up from there;
 * the request is repeated in case the refused turn never reached the thread. Model input, not UI text.
 */
export function codexContinuationPrompt(originalPrompt: string): string {
	const preamble = 'The previous attempt stopped because the subscription account reached its usage limit; this conversation now continues on another account. Continue the task where it stopped.';
	const request = originalPrompt.trim();
	if (request.startsWith(preamble)) {
		return request;
	}
	return request ? `${preamble} The request was:\n\n${request}` : preamble;
}
