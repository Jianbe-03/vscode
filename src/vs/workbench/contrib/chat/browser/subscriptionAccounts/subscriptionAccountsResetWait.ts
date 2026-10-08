/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: "Continue When Usage Resets". The chat waits (as a running request, so Stop cancels it)
// until the used-up account's limit resets, reads the account's usage again to confirm, and then
// continues the interrupted turn on that account through the same path as "Continue on ...".
//
// The wait lives in the window, not in the agent host: a Claude turn resumes from the client (the chat
// resends its request), so the window running the chat must stay open. It checks the clock every
// minute, so a computer that slept through the reset continues right after it wakes.

import { timeout } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { language } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import type { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { ISubscriptionAccount, SubscriptionProvider, readSubscriptionAccountsState } from '../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { dispatchSubscriptionAccountsRequest, waitForSubscriptionAccountsRequest } from '../../../../services/agentHost/browser/subscriptionAccountsService.js';

/** How long after the reset the chat continues, so the provider's own clock has passed it too. */
export const SUBSCRIPTION_RESET_WAIT_MARGIN_MS = 60 * 1000;
/** How often a waiting chat looks at the clock. */
const RESET_WAIT_TICK_MS = 60 * 1000;
/** How long a waiting chat waits for the usage reading it asked for after the reset. */
const RESET_READING_TIMEOUT_MS = 30 * 1000;
/** How often a wait moves on to a later reset (such as the weekly one) before it gives up. */
const MAX_RESET_WAITS = 4;

/** What a chat waits for: the account whose limit resets, and when. */
export interface ISubscriptionResetWait {
	readonly provider: SubscriptionProvider;
	readonly accountId: string;
	readonly accountLabel: string;
	/** Epoch milliseconds. */
	readonly resetsAt: number;
}

/** When the wait for `resetsAt` ends. */
export function getResetWaitEnd(resetsAt: number): number {
	return resetsAt + SUBSCRIPTION_RESET_WAIT_MARGIN_MS;
}

/**
 * Whether the chat can continue on `account` after its reset: yes when it is no longer used up (or
 * there is no reading to say otherwise), or the later reset to wait for, such as the weekly one.
 */
export function checkResetWaitAccount(account: ISubscriptionAccount | undefined, now: number): { readonly kind: 'continue' } | { readonly kind: 'wait'; readonly resetsAt: number } | { readonly kind: 'unavailable' } {
	if (!account || account.status === 'signedOut' || account.status === 'error') {
		return { kind: 'unavailable' };
	}
	const resets = [
		...(account.status === 'limited' && account.limitedUntil !== undefined ? [account.limitedUntil] : []),
		...(account.usage ?? []).filter(window => window.usedPercent >= 100 && window.resetsAt !== undefined).map(window => window.resetsAt!),
	].filter(resetsAt => resetsAt > now);
	return resets.length ? { kind: 'wait', resetsAt: Math.max(...resets) } : { kind: 'continue' };
}

/** The window of `account` that resets at `resetsAt`, such as "5-hour". */
export function getResetWindowLabel(account: ISubscriptionAccount | undefined, resetsAt: number): string | undefined {
	return account?.usage?.find(window => window.resetsAt !== undefined && Math.abs(window.resetsAt - resetsAt) < 10 * 60 * 1000 && window.usedPercent >= 100)?.label
		?? account?.usage?.find(window => window.usedPercent >= 100)?.label;
}

/** A moment as "14:05", or "Fri 14:05" when it is not today. */
export function formatResetTime(time: number, now: number): string {
	const date = new Date(time);
	const sameDay = date.toDateString() === new Date(now).toDateString();
	return sameDay
		? date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
		: date.toLocaleString(language, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** E.g. "Waiting for the Work account's 5-hour limit to reset at 14:05…". */
export function formatResetWaitMessage(wait: ISubscriptionResetWait, windowLabel: string | undefined, now: number): string {
	const time = formatResetTime(wait.resetsAt, now);
	return windowLabel
		? localize('subscriptionResetWait.window', "Waiting for the {0} account's {1} limit to reset at {2}…", wait.accountLabel, windowLabel, time)
		: localize('subscriptionResetWait', "Waiting for the {0} account's limit to reset at {1}…", wait.accountLabel, time);
}

/** The clock of a wait; replaced in tests. */
export interface IResetWaitClock {
	now(): number;
	sleep(milliseconds: number, token: CancellationToken): Promise<void>;
}

const realClock: IResetWaitClock = { now: () => Date.now(), sleep: (milliseconds, token) => timeout(milliseconds, token) };

/**
 * Waits until the account of `wait` can take work again: until its reset (plus a margin), then reads
 * its usage to confirm and waits for a later reset when one still blocks it. `report` gets the waiting
 * message whenever it changes. Resolves with whether the account is available; a cancelled `token`
 * rejects with a cancellation error.
 */
export async function waitForSubscriptionReset(
	connection: Pick<IAgentConnection, 'rootState' | 'dispatch'>,
	wait: ISubscriptionResetWait,
	report: (message: string) => void,
	token: CancellationToken,
	clock: IResetWaitClock = realClock,
): Promise<boolean> {
	let resetsAt = wait.resetsAt;
	for (let attempt = 0; attempt < MAX_RESET_WAITS; attempt++) {
		const before = findAccount(connection, wait.accountId);
		report(formatResetWaitMessage({ ...wait, resetsAt }, getResetWindowLabel(before, resetsAt), clock.now()));
		const end = getResetWaitEnd(resetsAt);
		while (clock.now() < end) {
			await clock.sleep(Math.min(RESET_WAIT_TICK_MS, end - clock.now()), token);
		}
		const askedAt = clock.now();
		const requestId = dispatchSubscriptionAccountsRequest(connection, { type: 'refreshUsage', provider: wait.provider });
		await waitForSubscriptionAccountsRequest(connection, requestId, token);
		await waitForReading(connection, wait.accountId, askedAt, token, clock);
		const decision = checkResetWaitAccount(findAccount(connection, wait.accountId), clock.now());
		if (decision.kind !== 'wait') {
			return decision.kind === 'continue';
		}
		resetsAt = decision.resetsAt;
	}
	return false;
}

function findAccount(connection: Pick<IAgentConnection, 'rootState'>, accountId: string): ISubscriptionAccount | undefined {
	const state = connection.rootState.value;
	return readSubscriptionAccountsState(state instanceof Error ? undefined : state).accounts.find(account => account.id === accountId);
}

/** Waits (up to half a minute) for a usage reading of the account taken after `since`. */
async function waitForReading(connection: Pick<IAgentConnection, 'rootState'>, accountId: string, since: number, token: CancellationToken, clock: IResetWaitClock): Promise<void> {
	const deadline = clock.now() + RESET_READING_TIMEOUT_MS;
	while (clock.now() < deadline) {
		const account = findAccount(connection, accountId);
		if (!account || (account.usageUpdatedAt ?? 0) >= since) {
			return;
		}
		await clock.sleep(1000, token);
	}
}
