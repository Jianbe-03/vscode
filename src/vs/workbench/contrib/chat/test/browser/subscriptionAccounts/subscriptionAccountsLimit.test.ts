/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { ISubscriptionAccount, SUBSCRIPTION_ACCOUNTS_META_KEY, SUBSCRIPTION_ACCOUNTS_REQUEST_KEY, SUBSCRIPTION_LIMIT_ERROR_META_KEY } from '../../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import type { IAgentConnection } from '../../../../../../platform/agentHost/common/agentService.js';
import type { RootState } from '../../../../../../platform/agentHost/common/state/protocol/state.js';
import type { IRootConfigChangedAction } from '../../../../../../platform/agentHost/common/state/sessionActions.js';
import { ADD_CLAUDE_ACCOUNT_COMMAND_ID, SHOW_SUBSCRIPTION_USAGE_COMMAND_ID, SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID, getSubscriptionLimitErrorDetails, getSubscriptionSwitchData, getSubscriptionWaitData, readSubscriptionLimitErrorMeta } from '../../../browser/subscriptionAccounts/subscriptionAccountsLimit.js';
import { checkResetWaitAccount, formatResetWaitMessage, getResetWaitEnd, waitForSubscriptionReset, type IResetWaitClock } from '../../../browser/subscriptionAccounts/subscriptionAccountsResetWait.js';
import { getNewUsageWarnings, pruneShownUsageWarnings } from '../../../browser/subscriptionAccounts/subscriptionUsageWarnings.js';
import { formatAccountHistorySummary, formatPoolHistorySummary, formatPoolVerdict, formatUsageDay } from '../../../browser/subscriptionAccounts/subscriptionUsageHistoryChart.js';
import { getBusiestUsageTimes, getPoolVerdict, summarizeUsageHistory, type ISubscriptionUsageSample } from '../../../../../../platform/agentHost/common/meta/subscriptionUsageHistory.js';

suite('SubscriptionAccountsLimit', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const now = Date.UTC(2026, 9, 8, 12);
	const hour = 60 * 60 * 1000;

	test('offers to continue on the next account', () => {
		const claude = getSubscriptionLimitErrorDetails({ provider: 'claude', accountId: 'a', accountLabel: 'Work', resetsAt: now + 3 * hour, nextAccountId: 'b', nextAccountLabel: 'Personal' }, now, 'ahp-chat://1');
		const codex = getSubscriptionLimitErrorDetails({ provider: 'codex', accountId: 'a', accountLabel: 'Work', nextAccountId: 'b', nextAccountLabel: 'Personal' }, now, 'ahp-chat://1');
		const readOnly = getSubscriptionLimitErrorDetails({ provider: 'codex', accountId: 'a', accountLabel: 'Work', nextAccountId: 'b', nextAccountLabel: 'Personal' }, now, undefined);

		assert.deepStrictEqual({
			claude: { message: claude.message, buttons: claude.confirmationButtons?.map(button => ({ label: button.label, data: button.data, resend: button.resend })) },
			claudeSwitch: getSubscriptionSwitchData(claude.confirmationButtons?.map(button => button.data)),
			codex: { message: codex.message, buttons: codex.confirmationButtons?.map(button => ({ label: button.label, commandId: button.commandId, commandArgs: button.commandArgs })) },
			readOnly: readOnly.confirmationButtons,
		}, {
			claude: {
				message: 'The Claude account Work has reached its usage limit; it resets in 3h.',
				buttons: [
					{ label: 'Continue on Personal', data: { agentHostResumeTurn: true, subscriptionSwitch: { accountId: 'b', alwaysSwitch: false } }, resend: true },
					{ label: 'Always Switch Automatically', data: { agentHostResumeTurn: true, subscriptionSwitch: { accountId: 'b', alwaysSwitch: true } }, resend: true },
					{ label: 'Continue When Usage Resets', data: { agentHostResumeTurn: true, subscriptionWait: { provider: 'claude', accountId: 'a', accountLabel: 'Work', resetsAt: now + 3 * hour } }, resend: true },
				],
			},
			claudeSwitch: { agentHostResumeTurn: true, subscriptionSwitch: { accountId: 'b', alwaysSwitch: false } },
			codex: {
				message: 'The Codex account Work has reached its usage limit.',
				buttons: [
					{ label: 'Continue on Personal', commandId: SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID, commandArgs: ['ahp-chat://1', 'b', false] },
					{ label: 'Always Switch Automatically', commandId: SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID, commandArgs: ['ahp-chat://1', 'b', true] },
				],
			},
			readOnly: undefined,
		});
	});

	test('offers to add an account when every account is used up', () => {
		const error = { errorType: 'limit', message: 'limit', _meta: { [SUBSCRIPTION_LIMIT_ERROR_META_KEY]: { provider: 'claude', accountId: 'a', accountLabel: 'Work', resetsAt: now + 2 * hour } } };
		const meta = readSubscriptionLimitErrorMeta(error);
		const details = meta && getSubscriptionLimitErrorDetails(meta, now, 'ahp-chat://1');

		assert.deepStrictEqual({
			message: details?.message,
			buttons: details?.confirmationButtons?.map(button => ({ label: button.label, commandId: button.commandId })),
			wait: getSubscriptionWaitData(details?.confirmationButtons?.map(button => button.data)),
			ignoresOtherErrors: readSubscriptionLimitErrorMeta({ errorType: 'x', message: 'x', _meta: { other: true } }),
		}, {
			message: 'All Claude accounts are used up; the first resets in 2h.',
			buttons: [{ label: 'Continue When Usage Resets', commandId: undefined }, { label: 'Add Claude Account', commandId: ADD_CLAUDE_ACCOUNT_COMMAND_ID }, { label: 'Show Usage', commandId: SHOW_SUBSCRIPTION_USAGE_COMMAND_ID }],
			wait: { agentHostResumeTurn: true, subscriptionWait: { provider: 'claude', accountId: 'a', accountLabel: 'Work', resetsAt: now + 2 * hour } },
			ignoresOtherErrors: undefined,
		});
	});

	const minute = 60 * 1000;

	function account(id: string, usedPercent: number, overrides: Partial<ISubscriptionAccount> = {}): ISubscriptionAccount {
		return { id, provider: 'claude', label: id, kind: 'login', status: 'signedIn', usage: [{ kind: 'five_hour', label: '5-hour', usedPercent, resetsAt: now + 2 * hour }], usageUpdatedAt: now, ...overrides };
	}

	test('warns once per account, window and reset period', () => {
		const accounts = [account('a', 82), account('b', 96), account('c', 40), account('d', 100, { status: 'limited' })];
		const first = getNewUsageWarnings(accounts, 80, []);
		const shown = first.map(({ warning }) => ({ key: warning.key, until: warning.window.resetsAt! }));
		assert.deepStrictEqual({
			first: first.map(({ account, warning }) => `${account.id} ${warning.level}`),
			again: getNewUsageWarnings(accounts, 80, shown).length,
			higher: getNewUsageWarnings([account('a', 95)], 80, shown).map(({ warning }) => warning.level),
			nextPeriod: getNewUsageWarnings([account('a', 82, { usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: 82, resetsAt: now + 7 * hour }] })], 80, shown).length,
			off: getNewUsageWarnings(accounts, 0, []).length,
			pruned: pruneShownUsageWarnings(shown, now + 3 * hour).length,
		}, {
			first: ['a 1', 'b 2'],
			again: 0,
			higher: [2],
			nextPeriod: 1,
			off: 0,
			pruned: 0,
		});
	});

	test('waits until the reset, reads the usage again and continues; a later limit makes it wait on', async () => {
		const resetsAt = now + 30 * minute;
		const weeklyResetsAt = now + 3 * hour;
		let clock = now;
		const fakeClock: IResetWaitClock = { now: () => clock, sleep: async milliseconds => { clock += milliseconds; } };
		const rootStateEmitter = disposables.add(new Emitter<RootState>());
		let state: RootState | undefined;
		const readings: ISubscriptionAccount[] = [
			// After the 5-hour reset the weekly limit still blocks the account.
			account('a', 30, { usageUpdatedAt: getResetWaitEnd(resetsAt), usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: 0 }, { kind: 'seven_day', label: 'Weekly', usedPercent: 100, resetsAt: weeklyResetsAt }] }),
			account('a', 0, { usageUpdatedAt: getResetWaitEnd(weeklyResetsAt) }),
		];
		const setState = (accounts: readonly ISubscriptionAccount[], request?: unknown) => {
			state = { agents: [], config: { schema: { type: 'object', properties: {} }, values: { [SUBSCRIPTION_ACCOUNTS_META_KEY]: { accounts }, [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: request } } } as RootState;
			rootStateEmitter.fire(state);
		};
		const requests: string[] = [];
		const connection: Pick<IAgentConnection, 'rootState' | 'dispatch'> = {
			rootState: { get value() { return state; }, get verifiedValue() { return state; }, onDidChange: rootStateEmitter.event, onWillApplyAction: Event.None, onDidApplyAction: Event.None },
			dispatch: (_channel: string, action: IRootConfigChangedAction) => {
				const request = action.config[SUBSCRIPTION_ACCOUNTS_REQUEST_KEY] as { type: string; provider: string };
				requests.push(`${request.type} ${request.provider} at +${(clock - now) / minute}m`);
				// The agent host takes the request, clears it and publishes a new reading.
				setState([account('a', 100, { status: 'limited', limitedUntil: resetsAt })], request);
				const reading = readings.shift()!;
				queueMicrotask(() => setState([reading]));
			},
		} as Pick<IAgentConnection, 'rootState' | 'dispatch'>;
		setState([account('a', 100, { status: 'limited', limitedUntil: resetsAt })]);
		const messages: string[] = [];
		const available = await waitForSubscriptionReset(connection, { provider: 'claude', accountId: 'a', accountLabel: 'Work', resetsAt }, message => messages.push(message.replace(/at .*\u2026$/, 'at …')), CancellationToken.None, fakeClock);

		assert.deepStrictEqual({ available, requests, messages }, {
			available: true,
			requests: ['refreshUsage claude at +31m', 'refreshUsage claude at +181m'],
			messages: [
				'Waiting for the Work account\'s 5-hour limit to reset at …',
				'Waiting for the Work account\'s Weekly limit to reset at …',
			],
		});
	});

	test('decides after a reset whether the account can take work', () => {
		assert.deepStrictEqual([
			checkResetWaitAccount(account('a', 20), now),
			checkResetWaitAccount(account('a', 100, { status: 'limited', limitedUntil: now + hour }), now),
			checkResetWaitAccount(account('a', 100, { usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: 100, resetsAt: now - minute }] }), now),
			checkResetWaitAccount(account('a', 0, { status: 'signedOut' }), now),
			checkResetWaitAccount(undefined, now),
		], [
			{ kind: 'continue' },
			// The latest blocking reset: the limit and the full 5-hour window.
			{ kind: 'wait', resetsAt: now + 2 * hour },
			{ kind: 'continue' },
			{ kind: 'unavailable' },
			{ kind: 'unavailable' },
		]);
		assert.ok(formatResetWaitMessage({ provider: 'codex', accountId: 'a', accountLabel: 'Home', resetsAt: now + hour }, undefined, now).startsWith('Waiting for the Home account\'s limit to reset at '));
	});

	test('sums up the usage history per day: how full the pool got, limit hits, time all used up and the verdict', () => {
		// Thursday 8 October 2026, 18:00 local time; the summary covers Tuesday to Thursday.
		const localNow = new Date(2026, 9, 8, 18).getTime();
		const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();
		const sample = (account: string, time: number, fiveHour: number, resetsAt: number, weekly: number): ISubscriptionUsageSample => ({ t: time, a: account, p: 'claude', w: [['five_hour', fiveHour, resetsAt], ['seven_day', weekly]], ...(fiveHour >= 100 ? { l: 1 as const } : {}) });
		const work = [
			sample('work', at(6, 10), 20, at(6, 15), 10),
			sample('work', at(6, 12), 60, at(6, 15), 12),
			sample('work', at(6, 14), 100, at(6, 15), 15),
			sample('work', at(8, 9), 50, at(8, 14), 30),
			sample('work', at(8, 10), 100, at(8, 14), 32),
		];
		const home = [
			sample('home', at(6, 9), 0, at(6, 14), 5),
			sample('home', at(6, 14, 10), 30, at(6, 19, 10), 5),
			sample('home', at(8, 10), 90, at(8, 15), 20),
			sample('home', at(8, 10, 30), 100, at(8, 15), 21),
		];
		const pool = summarizeUsageHistory(new Map([['work', work], ['home', home]]), localNow, 3);
		const account = summarizeUsageHistory(new Map([['work', work]]), localNow, 3);
		assert.deepStrictEqual({
			days: pool.days,
			verdict: getPoolVerdict(pool.days),
			busiest: getBusiestUsageTimes(pool.activity),
			accountPeaks: account.days.map(day => day.peak),
		}, {
			days: [
				{ start: at(6, 0), weekend: false, used: true, peak: 65, weekly: 10, limitHits: [{ account: 'work', t: at(6, 14) }], allUsedUpMs: 0 },
				{ start: at(7, 0), weekend: false, used: false, peak: undefined, weekly: undefined, limitHits: [], allUsedUpMs: 0 },
				{ start: at(8, 0), weekend: false, used: true, peak: 100, weekly: 27, limitHits: [{ account: 'work', t: at(8, 10) }, { account: 'home', t: at(8, 10, 30) }], allUsedUpMs: 3.5 * hour },
			],
			verdict: { verdict: 'tight', usedDays: 2, limitDays: 2, usedUpDays: 1, tightDays: 1, allUsedUpMs: 3.5 * hour },
			// Thursday, 09:00-11:00.
			busiest: { weekday: 3, hour: 9 },
			accountPeaks: [100, undefined, 100],
		});

		const labels = new Map([['work', 'Work'], ['home', 'Home']]);
		assert.deepStrictEqual({
			account: formatAccountHistorySummary(account.days),
			pool: formatPoolHistorySummary(pool, getPoolVerdict(pool.days)!),
			verdict: formatPoolVerdict(getPoolVerdict(pool.days)!).title,
			days: pool.days.map(day => formatUsageDay(day, labels)),
			accountDay: formatUsageDay(account.days[0], undefined),
		}, {
			account: 'Hit its limit 2 times in 4 weeks',
			pool: 'Last 4 weeks: an account hit its limit on 2 of 2 days with use \u00b7 all accounts were used up for 3h 30m in total \u00b7 busiest day: Thursday, busiest hours: 9:00 AM\u201311:00 AM',
			verdict: 'Close to the limit on busy days',
			days: [
				'Tue, Oct 6: the pool got 65% full \u00b7 Work hit its limit at 2:00 PM \u00b7 weekly limits 10% used',
				'Wed, Oct 7: not used',
				'Thu, Oct 8: the pool got 100% full \u00b7 Work hit its limit at 10:00 AM, Home hit its limit at 10:30 AM \u00b7 all accounts used up for 3h 30m \u00b7 weekly limits 27% used',
			],
			accountDay: 'Tue, Oct 6: 5-hour limit up to 100% used \u00b7 hit its limit at 2:00 PM \u00b7 weekly limit 15% used',
		});
	});
});
