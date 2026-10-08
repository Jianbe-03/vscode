/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { Emitter } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { getUsageWarning, readSubscriptionAccountsState, SUBSCRIPTION_ACCOUNTS_REQUEST_KEY, SUBSCRIPTION_ACCOUNTS_WARNING_THRESHOLD_KEY, type ISubscriptionAccount, type ISubscriptionAccountsRequest, type SubscriptionProvider } from '../../../common/meta/subscriptionAccounts.js';
import { countLimitHits, parseUsageHistory, pruneUsageSamples, SUBSCRIPTION_USAGE_HISTORY_FILE, SUBSCRIPTION_USAGE_HISTORY_MAX_AGE_MS, shouldRecordUsageSample, toUsageSample, type ISubscriptionUsageSample } from '../../../common/meta/subscriptionUsageHistory.js';
import { AgentConfigurationService } from '../../../node/agentConfigurationService.js';
import { AgentHostStateManager } from '../../../node/agentHostStateManager.js';
import { isUsageRefreshDue, SubscriptionAccountsService, type ISubscriptionAccountsProvider } from '../../../node/shared/subscriptionAccountsService.js';
import { SubscriptionUsageHistory } from '../../../node/shared/subscriptionUsageHistory.js';

suite('SubscriptionAccountsService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createProvider(provider: SubscriptionProvider, accounts: ISubscriptionAccount[]): ISubscriptionAccountsProvider & { readonly requests: string[]; readonly changed: Emitter<void> } {
		const changed = disposables.add(new Emitter<void>());
		const requests: string[] = [];
		return {
			provider,
			changed,
			requests,
			onDidChangeAccounts: changed.event,
			getAccounts: () => accounts,
			handleRequest: async (request: ISubscriptionAccountsRequest) => { requests.push(`${request.type}:${request.id}`); },
			refreshUsage: async () => { requests.push('refreshUsage'); },
		};
	}

	test('publishes the merged accounts and routes requests to their provider', async () => {
		const logService = new NullLogService();
		const stateManager = disposables.add(new AgentHostStateManager(logService));
		const configService = disposables.add(new AgentConfigurationService(stateManager, logService));
		const service = disposables.add(new SubscriptionAccountsService(undefined, configService, logService));
		const claude = createProvider('claude', [{ id: 'c1', provider: 'claude', label: 'Work', kind: 'token', status: 'signedIn' }]);
		const codex = createProvider('codex', [{ id: 'x1', provider: 'codex', label: 'Home', kind: 'default', status: 'signedIn' }]);
		disposables.add(service.registerProvider(claude));
		disposables.add(service.registerProvider(codex));

		configService.updateRootConfig({ [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: { id: 'r1', type: 'rename', accountId: 'x1', label: 'Other' } });
		configService.updateRootConfig({ [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: { id: 'r2', type: 'add', provider: 'claude', kind: 'login', label: 'New', accountId: 'c2' } });
		configService.updateRootConfig({ [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: { id: 'r3', type: 'refreshUsage' } });
		await Promise.resolve();

		assert.deepStrictEqual({
			accounts: readSubscriptionAccountsState(stateManager.rootState).accounts.map(account => account.id),
			claude: claude.requests,
			codex: codex.requests,
			pending: configService.getRootConfigValues()[SUBSCRIPTION_ACCOUNTS_REQUEST_KEY],
		}, {
			accounts: ['c1', 'x1'],
			claude: ['add:r2', 'refreshUsage'],
			codex: ['rename:r1', 'refreshUsage'],
			pending: undefined,
		});
	});

	const minute = 60 * 1000;
	const now = Date.UTC(2026, 9, 8, 12);

	function withUsage(id: string, usedPercent: number, overrides: Partial<ISubscriptionAccount> = {}): ISubscriptionAccount {
		return { id, provider: 'claude', label: id, kind: 'login', status: 'signedIn', usage: [{ kind: 'five_hour', label: '5-hour', usedPercent, resetsAt: now + 72 * minute }, { kind: 'seven_day', label: 'Weekly', usedPercent: 30 }], usageUpdatedAt: now, ...overrides };
	}

	test('warns from the threshold and again at 95%, once per window and period', () => {
		const levels = [50, 80, 94, 95, 100].map(used => getUsageWarning(withUsage('a', used), 80)?.level);
		const logService = new NullLogService();
		const stateManager = disposables.add(new AgentHostStateManager(logService));
		const configService = disposables.add(new AgentConfigurationService(stateManager, logService));
		const service = disposables.add(new SubscriptionAccountsService(undefined, configService, logService));
		// Notes say when the window resets, counted from the real clock.
		const live = (used: number) => withUsage('a', used, { usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: used, resetsAt: Date.now() + 72 * minute }] });
		const notes = [
			service.takeUsageNote('chat-1', live(82)),
			service.takeUsageNote('chat-1', live(84)),
			service.takeUsageNote('chat-2', live(84)),
			service.takeUsageNote('chat-1', live(96)),
		];
		configService.updateRootConfig({ [SUBSCRIPTION_ACCOUNTS_WARNING_THRESHOLD_KEY]: 0 });

		assert.deepStrictEqual({
			levels,
			notes: notes.map(note => note?.replace(/\(resets in .*\)/, '(resets in …)')),
			off: service.takeUsageNote('chat-3', withUsage('a', 99)),
		}, {
			levels: [undefined, 1, 1, 2, undefined],
			notes: [
				'The Claude account a has used 82% of its 5-hour limit (resets in …).',
				undefined,
				'The Claude account a has used 84% of its 5-hour limit (resets in …).',
				'The Claude account a has used 96% of its 5-hour limit (resets in …).',
			],
			off: undefined,
		});
	});

	test('reads the usage every ten minutes, and every two near the limit', () => {
		const calm = [withUsage('a', 40)];
		const hot = [withUsage('a', 40), withUsage('b', 85)];
		assert.deepStrictEqual([
			isUsageRefreshDue(calm, 80, now - 3 * minute, now),
			isUsageRefreshDue(calm, 80, now - 10 * minute, now),
			isUsageRefreshDue(hot, 80, now - 1 * minute, now),
			isUsageRefreshDue(hot, 80, now - 2 * minute, now),
			isUsageRefreshDue(hot, 0, now - 2 * minute, now),
			isUsageRefreshDue([withUsage('c', 90, { status: 'signedOut' })], 80, undefined, now),
		], [false, true, false, true, false, false]);
	});

	test('samples the usage history at most every ten minutes, and when an account hits its limit', () => {
		const sample = (minutes: number, used: number) => toUsageSample(withUsage('a', used, { usageUpdatedAt: now + minutes * minute, ...(used >= 100 ? { status: 'limited' as const } : {}) }), now + minutes * minute)!;
		const first = sample(0, 50);
		const samples: ISubscriptionUsageSample[] = [first, sample(10, 70), sample(12, 100), sample(30, 100), sample(40, 20), sample(50, 100)];
		const old = { ...first, t: now - SUBSCRIPTION_USAGE_HISTORY_MAX_AGE_MS - 1 };
		assert.deepStrictEqual({
			first,
			record: [
				shouldRecordUsageSample(undefined, first),
				shouldRecordUsageSample(first, sample(5, 60)),
				shouldRecordUsageSample(first, sample(10, 60)),
				shouldRecordUsageSample(first, sample(3, 100)),
				shouldRecordUsageSample(first, first),
			],
			pruned: pruneUsageSamples([old, first], now).length,
			hits: countLimitHits(samples),
			parsed: parseUsageHistory(`${JSON.stringify(first)}\n{"broken\n\n${JSON.stringify({ t: 1 })}\n`),
		}, {
			first: { t: now, a: 'a', p: 'claude', w: [['five_hour', 50, now + 72 * minute], ['seven_day', 30]] },
			record: [true, false, true, true, false],
			pruned: 1,
			hits: 2,
			parsed: [first],
		});
	});

	test('appends the usage history next to the accounts file and prunes old samples on start', async () => {
		const directory = fs.mkdtempSync(join(os.tmpdir(), 'subscription-history-'));
		const path = join(directory, SUBSCRIPTION_USAGE_HISTORY_FILE);
		const old = { t: now - SUBSCRIPTION_USAGE_HISTORY_MAX_AGE_MS - minute, a: 'a', p: 'claude', w: [['five_hour', 10]] };
		const recent = { t: now - 5 * minute, a: 'a', p: 'claude', w: [['five_hour', 40]] };
		fs.writeFileSync(path, `${JSON.stringify(old)}\n${JSON.stringify(recent)}\n`);
		const history = new SubscriptionUsageHistory(path, new NullLogService(), now);
		// Too soon after the last sample on disk for account a; b is new.
		history.record([withUsage('a', 50), withUsage('b', 60)], now);
		await history.flush();
		const lines = parseUsageHistory(fs.readFileSync(path, 'utf8')).map(sample => `${sample.a} ${sample.w[0][1]}`);
		fs.rmSync(directory, { recursive: true, force: true });
		assert.deepStrictEqual(lines, ['a 40', 'b 60']);
	});
});
