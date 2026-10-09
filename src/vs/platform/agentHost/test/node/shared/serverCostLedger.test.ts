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
import { findServerCostHardStop, readServerCostEntries, readServerCostLedger, SERVER_COST_LEDGER_FILE, writeServerCostBudgets } from '../../../node/shared/serverCostLedger.js';

suite('ServerCostLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;

	setup(async () => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'serverCostLedger');
		await fs.mkdir(dir, { recursive: true });
	});

	teardown(() => fs.rm(dir, { recursive: true, force: true }));

	test('reads the latest line of each id, from a time, and tolerates a half-written line', async () => {
		const file = join(dir, SERVER_COST_LEDGER_FILE);
		const line = (entry: object) => `${JSON.stringify(entry)}\n`;
		await fs.writeFile(file, line({ id: 'a', time: 100, cost: 0.1 }) + line({ id: 'b', time: 200, cost: 1 }) + line({ id: 'a', time: 100, cost: 0.2 }) + '{"id":"partial"');
		const all = readServerCostEntries(dir, 0);
		const later = readServerCostEntries(dir, 150);
		const limited = readServerCostEntries(dir, 0, 1);
		const missing = readServerCostEntries(join(dir, 'none'), 0);

		assert.deepStrictEqual({
			all: [all.entries.map(entry => [entry.id, entry.cost]), all.cursor],
			later: later.entries.map(entry => entry.id),
			limited: [limited.entries.map(entry => entry.id), limited.cursor],
			missing: [missing.entries.length, missing.cursor],
			ledger: readServerCostLedger(dir).length,
		}, {
			all: [[['a', 0.2], ['b', 1]], 200],
			later: ['b'],
			limited: [['a'], 100],
			missing: [0, 0],
			ledger: 2,
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

	test('the server refuses with the budgets the laptop pushed', async () => {
		await fs.writeFile(join(dir, SERVER_COST_LEDGER_FILE), `${JSON.stringify({ id: 'a', time: 50, cost: 4, providerGroup: 'Team' })}\n`);
		const before = findServerCostHardStop({ providerGroup: 'Team' }, dir, 50);
		writeServerCostBudgets(dir, { updatedAt: 1, budgets: [{ id: 'team', scope: 'key', value: 'Team', amount: 5, period: 'day', hardStop: true, from: 0, to: 100, spentElsewhere: 1 }] });
		assert.deepStrictEqual([before, findServerCostHardStop({ providerGroup: 'Team' }, dir, 50)?.spent, findServerCostHardStop({ providerGroup: 'Team' }, undefined, 50)], [undefined, 5, undefined]);
	});
});
