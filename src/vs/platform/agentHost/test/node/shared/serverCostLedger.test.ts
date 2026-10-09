/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createServerCostBudgets, findServerHardStop, getBudgetPeriodRange, IGatewayCostEntryLike, mergeCostEntries, parseCostBudgets } from '../../../common/creaeditorCosts.js';
import { readServerCostEntries, SERVER_COST_LEDGER_FILE, ServerCostLedger, writeServerCostBudgets } from '../../../node/shared/serverCostLedger.js';

suite('ServerCostLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;

	setup(async () => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'serverCostLedger');
		await fs.mkdir(dir, { recursive: true });
	});

	teardown(() => fs.rm(dir, { recursive: true, force: true }));

	test('appends records and updates; reads whole lines from a cursor and starts over after a rewrite', async () => {
		let now = 100;
		const ledger = new ServerCostLedger(dir, () => now++);
		const first = ledger.record({ model: 'm', cost: 0.1, providerGroup: 'Team' });
		ledger.update(first, { cost: 0.2 });
		const all = readServerCostEntries(dir, 0);
		// A half-written line is left for the next read.
		await fs.appendFile(join(dir, SERVER_COST_LEDGER_FILE), '{"id":"partial"');
		const tail = readServerCostEntries(dir, all.cursor);
		const reopened = new ServerCostLedger(dir);
		await fs.writeFile(join(dir, SERVER_COST_LEDGER_FILE), `${JSON.stringify({ id: 'x', time: 1, cost: 1 })}\n`);
		const afterRewrite = readServerCostEntries(dir, all.cursor);

		assert.deepStrictEqual({
			all: all.entries.map(entry => [entry.id === first, entry.cost, entry.time]),
			tail: [tail.entries.length, tail.cursor === all.cursor],
			reopened: reopened.entries.map(entry => entry.cost),
			afterRewrite: [afterRewrite.reset, afterRewrite.entries.map(entry => entry.id)],
		}, {
			all: [[true, 0.1, 100], [true, 0.2, 100]],
			tail: [0, true],
			reopened: [0.2],
			afterRewrite: [true, ['x']],
		});
	});

	test('merges pulled entries by id (latest wins), oldest first', () => {
		const kept: IGatewayCostEntryLike[] = [{ id: 'a', time: 2, cost: 1 }, { id: 'b', time: 1, cost: 1 }];
		const pulled: IGatewayCostEntryLike[] = [{ id: 'a', time: 2, cost: 3 }, { id: 'c', time: 3 }];
		assert.deepStrictEqual(mergeCostEntries(kept, pulled).map(entry => [entry.id, entry.cost]), [['b', 1], ['a', 3], ['c', undefined]]);
		assert.deepStrictEqual(mergeCostEntries(kept, pulled, 2).map(entry => entry.id), ['a', 'c']);
	});

	test('a hard stop counts the spend elsewhere in the pushed period, and only its own after it', () => {
		const now = new Date(2026, 9, 9, 12).getTime();
		const budgets = parseCostBudgets([
			{ scope: 'key', value: 'Team', amount: 10, period: 'day', hardStop: true },
			{ scope: 'repo', value: 'acme/web', amount: 5, period: 'month', hardStop: false },
			{ scope: 'issue', value: 'acme/web#7', amount: 1, period: 'week', hardStop: true },
		]);
		const day = getBudgetPeriodRange('day', now);
		const laptop: IGatewayCostEntryLike[] = [
			{ id: '1', time: day.from + 1, cost: 6, providerGroup: 'Team' },
			{ id: '2', time: day.from - 1, cost: 100, providerGroup: 'Team' },
			{ id: '3', time: now, cost: 0.5, repo: 'acme/web', issue: { number: 7 } },
		];
		const pushed = createServerCostBudgets(budgets, laptop, now);
		const server: IGatewayCostEntryLike[] = [{ id: 's', time: now, cost: 3, providerGroup: 'Team' }];

		assert.deepStrictEqual({
			pushed: pushed.budgets.map(budget => [budget.id, budget.spentElsewhere]),
			underBudget: findServerHardStop(pushed, server, { providerGroup: 'Team' }, now),
			usedUp: findServerHardStop(pushed, [...server, { id: 't', time: now, cost: 1, providerGroup: 'Team' }], { providerGroup: 'Team' }, now)?.spent,
			issue: findServerHardStop(pushed, [{ id: 'u', time: now, cost: 0.5, repo: 'acme/web', issue: { number: 7, repo: 'acme/web' } }], { issue: 'acme/web#7' }, now)?.budget.id,
			// The next day: the pushed period is over, so only this server's spend of that day counts.
			nextDay: findServerHardStop(pushed, [...server, { id: 't', time: now, cost: 1, providerGroup: 'Team' }], { providerGroup: 'Team' }, day.to + 1000),
		}, {
			pushed: [['key:Team:day', 6], ['issue:acme/web#7:week', 0.5]],
			underBudget: undefined,
			usedUp: 10,
			issue: 'issue:acme/web#7:week',
			nextDay: undefined,
		});
	});

	test('the ledger refuses with the budgets the laptop pushed', () => {
		const ledger = new ServerCostLedger(dir, () => 50);
		ledger.record({ cost: 4, providerGroup: 'Team' });
		const before = ledger.findHardStop({ providerGroup: 'Team' });
		writeServerCostBudgets(dir, { updatedAt: 1, budgets: [{ id: 'team', scope: 'key', value: 'Team', amount: 5, period: 'day', hardStop: true, from: 0, to: 100, spentElsewhere: 1 }] });
		assert.deepStrictEqual([before, ledger.findHardStop({ providerGroup: 'Team' })?.spent], [undefined, 5]);
	});
});
