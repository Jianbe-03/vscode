/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { IGatewayCostEntry } from '../../../../platform/endpoint/common/gatewayTrackingService';
import { chooseCostBucket, computeBudgetStatuses, computeChatCosts, computeCostBreakdown, computeCostChange, computeCostComparison, computeCostKpis, computeCostPivot, computeCostTimeline, filterCostRows, findHardStopBudget, getBudgetAlertKeys, getBudgetPeriodRange, getChangedChats, getNewBudgetAlerts, ICostQueryOptions, OTHER_VALUE, parseCostBudgets, percentile, prepareCostDataset, resolveCostRange, resolvePreviousCostRange, runCostQuery, sortCostRows } from '../gatewayCostsAnalysis';

/** Wednesday 15 October 2025, 12:00 local time. */
const NOW = new Date(2025, 9, 15, 12).getTime();

function at(month: number, day: number, hour = 10): number {
	return new Date(2025, month - 1, day, hour).getTime();
}

let nextId = 0;
function entry(time: number, fields: Partial<IGatewayCostEntry> = {}): IGatewayCostEntry {
	const id = `e${nextId++}`;
	return { id, time, chatId: 'chat1', rootChatId: 'chat1', gateway: 'openrouter', gatewayHost: 'openrouter.ai', model: 'model-a', ...fields };
}

const ENTRIES: IGatewayCostEntry[] = [
	entry(at(9, 1), { cost: 1, model: 'model-b', providerGroup: 'Team', promptTokens: 1000, completionTokens: 100, chatTitle: 'Old chat', chatId: 'old', rootChatId: 'old' }),
	entry(at(10, 13), { cost: 0.5, providerGroup: 'Team', promptTokens: 2000, completionTokens: 200, cachedTokens: 1000, chatTitle: 'Fix login', repo: 'acme/web', branch: '42-login', issue: { number: 42, repo: 'acme/web' } }),
	entry(at(10, 14), { cost: 0.25, providerGroup: 'Team', promptTokens: 1000, completionTokens: 100, chatId: 'sub1', chatTitle: 'Explore', repo: 'acme/web', gatewayRequestId: 'gen-123' }),
	entry(at(10, 15), { providerGroup: 'Private', gateway: 'litellm', gatewayHost: 'proxy:4000', model: 'model-c', promptTokens: 500 }),
	entry(at(10, 15, 9), { cost: 2, providerGroup: 'Private', gateway: 'litellm', gatewayHost: 'proxy:4000', model: 'model-c', promptTokens: 4000, completionTokens: 1000, costSource: 'header' }),
];

const OPTIONS: ICostQueryOptions = { bucket: 'auto', stackBy: 'key', breakdownBy: 'model', pivotRows: 'key', pivotColumns: 'kind', sortColumn: 'time', sortDescending: true, page: 0, pageSize: 2 };

describe('resolveCostRange', () => {
	it('resolves presets and custom ranges in local days', () => {
		const range = (filters: Parameters<typeof resolveCostRange>[0]) => {
			const { from, to } = resolveCostRange(filters, NOW);
			return [from && new Date(from).toDateString(), to && new Date(to).toDateString()];
		};
		expect({
			today: range({ range: 'today' }),
			week: range({ range: '7' }),
			thisMonth: range({ range: 'thisMonth' }),
			lastMonth: range({ range: 'lastMonth' }),
			custom: range({ range: 'custom', from: '2025-10-01', to: '2025-10-03' }),
			openEnd: range({ range: 'custom', from: '2025-10-01' }),
			all: range({ range: 'all' }),
		}).toEqual({
			today: ['Wed Oct 15 2025', 'Thu Oct 16 2025'],
			week: ['Thu Oct 09 2025', 'Thu Oct 16 2025'],
			thisMonth: ['Wed Oct 01 2025', 'Sat Nov 01 2025'],
			lastMonth: ['Mon Sep 01 2025', 'Wed Oct 01 2025'],
			custom: ['Wed Oct 01 2025', 'Sat Oct 04 2025'],
			openEnd: ['Wed Oct 01 2025', undefined],
			all: [undefined, undefined],
		});
	});
});

describe('filterCostRows', () => {
	const dataset = prepareCostDataset(ENTRIES);
	const ids = (filters: Parameters<typeof filterCostRows>[1]) => filterCostRows(dataset, filters, NOW).map(row => row.id);

	it('combines all filters', () => {
		const [old, login, sub, noCost, header] = ENTRIES.map(e => e.id);
		expect({
			range: ids({ range: '7' }),
			key: ids({ range: 'all', values: { key: ['Private'] } }),
			keyAndModel: ids({ range: 'all', values: { key: ['Team'], model: ['model-a'] } }),
			twoKeys: ids({ range: 'all', values: { key: ['Team', 'Private'] } }),
			twoModelsAndKey: ids({ range: 'all', values: { model: ['model-b', 'model-c'], key: ['Private'] } }),
			gateway: ids({ range: 'all', values: { gateway: ['litellm:proxy:4000'] } }),
			issue: ids({ range: 'all', values: { issue: ['acme/web#42'] } }),
			noRepo: ids({ range: 'all', values: { repo: [''] } }),
			chatIncludesSubagents: ids({ range: 'all', values: { chat: ['chat1'] } }),
			subagents: ids({ range: 'all', kind: 'subagent' }),
			main: ids({ range: '7', kind: 'main' }),
			withoutCost: ids({ range: 'all', withoutCost: true }),
			minMax: ids({ range: 'all', minCost: 0.3, maxCost: 1 }),
			text: ids({ range: 'all', text: ' GEN-123 ' }),
			textByRootTitle: ids({ range: 'all', text: 'fix login' }),
		}).toEqual({
			range: [login, sub, noCost, header],
			key: [noCost, header],
			keyAndModel: [login, sub],
			twoKeys: [old, login, sub, noCost, header],
			twoModelsAndKey: [noCost, header],
			gateway: [noCost, header],
			issue: [login],
			noRepo: [old, noCost, header],
			chatIncludesSubagents: [login, sub, noCost, header],
			subagents: [sub],
			main: [login, noCost, header],
			withoutCost: [noCost],
			minMax: [old, login],
			text: [sub],
			textByRootTitle: [login, sub, noCost, header],
		});
	});
});

describe('percentile', () => {
	it('uses the nearest rank', () => {
		const values = Array.from({ length: 20 }, (_, index) => index + 1);
		expect([percentile(values, 0.95), percentile(values, 0.5), percentile([3], 0.95), percentile([], 0.5)]).toEqual([19, 10, 3, undefined]);
	});
});

describe('computeCostKpis', () => {
	const dataset = prepareCostDataset(ENTRIES);

	it('summarizes the filtered requests and projects the month', () => {
		const rows = filterCostRows(dataset, { range: 'thisMonth' }, NOW);
		expect(computeCostKpis(rows, resolveCostRange({ range: 'thisMonth' }, NOW), NOW)).toEqual({
			cost: 2.75,
			requests: 4,
			withoutCost: 1,
			averageCost: 2.75 / 3,
			medianCost: 0.5,
			p95Cost: 2,
			promptTokens: 7500,
			completionTokens: 1300,
			cachedTokens: 1000,
			cacheShare: 1000 / 7500,
			costPerMillionTokens: 2.75 / 8300 * 1e6,
			activeDays: 3,
			averagePerActiveDay: 2.75 / 3,
			projection: { monthCost: 2.75, projected: 2.75 / 15 * 31, daysElapsed: 15, daysInMonth: 31 },
			subagentShare: 0.25 / 2.75,
		});
	});

	it('only projects when the range covers the month so far', () => {
		const projection = (filters: Parameters<typeof resolveCostRange>[0]) => computeCostKpis(filterCostRows(dataset, filters, NOW), resolveCostRange(filters, NOW), NOW).projection?.projected;
		expect([projection({ range: '7' }), projection({ range: 'lastMonth' }), projection({ range: 'all' })]).toEqual([undefined, undefined, 2.75 / 15 * 31]);
	});
});

describe('computeCostTimeline', () => {
	it('picks the bucket size from the span unless overridden', () => {
		const day = 24 * 60 * 60 * 1000;
		expect([chooseCostBucket(0, 30 * day, 'auto'), chooseCostBucket(0, 90 * day, 'auto'), chooseCostBucket(0, 365 * day, 'auto'), chooseCostBucket(0, 30 * day, 'month'), chooseCostBucket(0, 1000 * day, 'day')]).toEqual(['day', 'week', 'month', 'month', 'week']);
	});

	it('stacks cost per bucket and folds small series into other', () => {
		const rows = prepareCostDataset([
			...Array.from({ length: 7 }, (_, index) => entry(at(10, 13), { cost: 7 - index, model: `m${index}` })),
			entry(at(10, 6), { cost: 1, model: 'm0' }),
		]).rows.map(prepared => prepared.row);
		const timeline = computeCostTimeline(rows, resolveCostRange({ range: 'thisMonth' }, NOW), 'week', 'model', NOW);
		expect({
			bucket: timeline.bucket,
			series: timeline.series.map(key => key.value),
			buckets: timeline.buckets.map(bucket => [new Date(bucket.start).toDateString(), bucket.values, bucket.requests]),
		}).toEqual({
			bucket: 'week',
			series: ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', OTHER_VALUE],
			buckets: [
				['Mon Sep 29 2025', [0, 0, 0, 0, 0, 0, 0], 0],
				['Mon Oct 06 2025', [1, 0, 0, 0, 0, 0, 0], 1],
				['Mon Oct 13 2025', [7, 6, 5, 4, 3, 2, 1], 7],
				['Mon Oct 20 2025', [0, 0, 0, 0, 0, 0, 0], 0],
				['Mon Oct 27 2025', [0, 0, 0, 0, 0, 0, 0], 0],
			],
		});
	});
});

describe('breakdown and pivot', () => {
	const rows = filterCostRows(prepareCostDataset(ENTRIES), { range: 'all' }, NOW);

	it('breaks the cost down with shares', () => {
		expect(computeCostBreakdown(rows, 'gateway').map(group => [group.label, group.cost, group.share, group.requests])).toEqual([
			['LiteLLM · proxy:4000', 2, 2 / 3.75, 2],
			['OpenRouter · openrouter.ai', 1.75, 1.75 / 3.75, 3],
		]);
	});

	it('pivots with row and column totals', () => {
		const pivot = computeCostPivot(rows, 'key', 'kind');
		expect({
			rows: pivot.rows.map(key => key.value),
			columns: pivot.columns.map(key => key.value),
			cells: pivot.cells.map(cells => cells.map(cell => cell.cost)),
			rowTotals: pivot.rowTotals.map(cell => cell.cost),
			columnTotals: pivot.columnTotals.map(cell => cell.requests),
			total: pivot.total.cost,
		}).toEqual({
			rows: ['Private', 'Team'],
			columns: ['main', 'subagent'],
			cells: [[2, 0], [1.5, 0.25]],
			rowTotals: [2, 1.75],
			columnTotals: [4, 1],
			total: 3.75,
		});
	});
});

describe('runCostQuery', () => {
	it('sorts and pages the requests and counts the matches', () => {
		const result = runCostQuery(prepareCostDataset(ENTRIES), { range: 'all' }, { ...OPTIONS, sortColumn: 'cost', sortDescending: true, page: 2 }, NOW);
		expect({
			total: result.total,
			matching: result.matching,
			page: result.requests.page,
			pageCount: result.requests.pageCount,
			rows: result.requests.rows.map(row => row.cost),
			keyOptions: result.options.key.map(option => [option.value, option.count]),
		}).toEqual({ total: 5, matching: 5, page: 2, pageCount: 3, rows: [undefined], keyOptions: [['Team', 3], ['Private', 2]] });
	});

	it('keeps requests without a value last in both directions', () => {
		const rows = filterCostRows(prepareCostDataset(ENTRIES), { range: 'all' }, NOW);
		expect([sortCostRows(rows, 'cost', false).map(row => row.cost), sortCostRows(rows, 'cost', true).map(row => row.cost)]).toEqual([
			[0.25, 0.5, 1, 2, undefined],
			[2, 1, 0.5, 0.25, undefined],
		]);
	});
});

describe('comparison with the previous period', () => {
	it('picks the period of the same length before the range', () => {
		const periods = (filters: Parameters<typeof resolvePreviousCostRange>[0]) => {
			const result = resolvePreviousCostRange(filters, NOW);
			return result && [result.current.from, result.current.to, result.previous.from, result.previous.to].map(time => new Date(time).toDateString());
		};
		expect({
			today: periods({ range: 'today' }),
			week: periods({ range: '7' }),
			thisMonth: periods({ range: 'thisMonth' }),
			lastMonth: periods({ range: 'lastMonth' }),
			custom: periods({ range: 'custom', from: '2025-10-01', to: '2025-10-03' }),
			all: periods({ range: 'all' }),
		}).toEqual({
			today: ['Wed Oct 15 2025', 'Thu Oct 16 2025', 'Tue Oct 14 2025', 'Wed Oct 15 2025'],
			week: ['Thu Oct 09 2025', 'Thu Oct 16 2025', 'Thu Oct 02 2025', 'Thu Oct 09 2025'],
			thisMonth: ['Wed Oct 01 2025', 'Sat Nov 01 2025', 'Mon Sep 01 2025', 'Wed Oct 01 2025'],
			lastMonth: ['Mon Sep 01 2025', 'Wed Oct 01 2025', 'Fri Aug 01 2025', 'Mon Sep 01 2025'],
			custom: ['Wed Oct 01 2025', 'Sat Oct 04 2025', 'Sun Sep 28 2025', 'Wed Oct 01 2025'],
			all: undefined,
		});
	});

	it('computes the change, without a percentage from zero', () => {
		expect([computeCostChange(3, 2), computeCostChange(1, 2), computeCostChange(1, 0), computeCostChange(0, 0)]).toEqual([
			{ absolute: 1, percent: 0.5 },
			{ absolute: -1, percent: -0.5 },
			{ absolute: 1, percent: undefined },
			{ absolute: 0, percent: undefined },
		]);
	});

	it('compares this month with last month per key and model, with the other filters applied', () => {
		const dataset = prepareCostDataset([...ENTRIES, entry(at(9, 20), { cost: 3, providerGroup: 'Private', model: 'model-c', promptTokens: 10 })]);
		const comparison = computeCostComparison(dataset, { range: 'thisMonth', kind: 'main' }, NOW)!;
		const pair = (row: { value: string; current: { cost: number; requests: number }; previous: { cost: number; requests: number } }) => [row.value, row.current.cost, row.previous.cost, row.current.requests, row.previous.requests];
		expect({
			total: [comparison.total.current.cost, comparison.total.previous.cost],
			previousRequests: comparison.previousKpis.requests,
			previousProjection: comparison.previousKpis.projection,
			byKey: comparison.byKey.map(pair),
			byModel: comparison.byModel.map(pair),
			viaQuery: runCostQuery(dataset, { range: 'thisMonth', kind: 'main' }, { ...OPTIONS, compare: true }, NOW).comparison?.total.previous.cost,
			notAsked: runCostQuery(dataset, { range: 'thisMonth' }, OPTIONS, NOW).comparison,
		}).toEqual({
			total: [2.5, 4],
			previousRequests: 2,
			previousProjection: undefined,
			byKey: [['Private', 2, 3, 2, 1], ['Team', 0.5, 1, 1, 1]],
			byModel: [['model-c', 2, 3, 2, 1], ['model-a', 0.5, 0, 1, 0], ['model-b', 0, 1, 0, 1]],
			viaQuery: 4,
			notAsked: undefined,
		});
	});
});

describe('cost per chat', () => {
	it('counts subagents for their main chat and finds the chats that changed', () => {
		const before = computeChatCosts(ENTRIES);
		const after = computeChatCosts([...ENTRIES.slice(1), entry(at(10, 15), { cost: 1, chatId: 'sub2', rootChatId: 'chat1' }), entry(at(10, 15), { chatId: 'new', rootChatId: 'new' })]);
		expect({
			chats: [...before].map(([chatId, aggregate]) => [chatId, aggregate.cost, aggregate.requests, aggregate.promptTokens]),
			changed: getChangedChats(before, after).sort(),
			unchanged: getChangedChats(before, computeChatCosts(ENTRIES)),
		}).toEqual({
			chats: [['old', 1, 1, 1000], ['chat1', 2.75, 4, 7500]],
			changed: ['chat1', 'new', 'old'],
			unchanged: [],
		});
	});
});

describe('budgets', () => {
	const budgets = parseCostBudgets([
		{ scope: 'key', value: 'Team', amount: 1, period: 'month', hardStop: true },
		{ scope: 'repo', value: 'acme/web', amount: 0.5, period: 'week', warnAt: [100, 50, 50] },
		{ scope: 'issue', value: 'acme/web#42', amount: 10, period: 'day' },
		{ scope: 'key', value: 'Private', amount: 5 },
		{ scope: 'model', value: 'x', amount: 1 },
		{ scope: 'key', value: '', amount: 1 },
		{ scope: 'key', value: 'Team', amount: -1 },
		'nonsense',
	]);

	it('reads valid budgets from the setting', () => {
		expect(budgets.map(b => [b.id, b.scope, b.value, b.amount, b.period, b.warnAt, b.hardStop])).toEqual([
			['key:Team:month', 'key', 'Team', 1, 'month', [80, 100], true],
			['repo:acme/web:week', 'repo', 'acme/web', 0.5, 'week', [50, 100], false],
			['issue:acme/web#42:day', 'issue', 'acme/web#42', 10, 'day', [80, 100], false],
			['key:Private:month', 'key', 'Private', 5, 'month', [80, 100], false],
		]);
		expect(parseCostBudgets(undefined)).toEqual([]);
	});

	it('resolves the current period in local time', () => {
		const range = (period: Parameters<typeof getBudgetPeriodRange>[0]) => {
			const { from, to } = getBudgetPeriodRange(period, NOW);
			return [new Date(from).toDateString(), new Date(to).toDateString()];
		};
		expect([range('day'), range('week'), range('month')]).toEqual([
			['Wed Oct 15 2025', 'Thu Oct 16 2025'],
			['Mon Oct 13 2025', 'Mon Oct 20 2025'],
			['Wed Oct 01 2025', 'Sat Nov 01 2025'],
		]);
	});

	it('computes the spend of every budget in its period', () => {
		const statuses = computeBudgetStatuses(budgets, ENTRIES, NOW);
		expect(statuses.map(s => [s.budget.id, s.spent, s.reached, s.exhausted])).toEqual([
			// The September request is outside this month.
			['key:Team:month', 0.75, [], false],
			['repo:acme/web:week', 0.75, [50, 100], true],
			['issue:acme/web#42:day', 0, [], false],
			['key:Private:month', 2, [], false],
		]);
	});

	it('raises the highest reached threshold once per period', () => {
		const statuses = computeBudgetStatuses(budgets, ENTRIES, NOW);
		const first = getNewBudgetAlerts(statuses, new Set());
		expect(first.map(a => [a.status.budget.id, a.threshold])).toEqual([['repo:acme/web:week', 100]]);
		const raised = new Set(statuses.flatMap(getBudgetAlertKeys));
		expect(getNewBudgetAlerts(statuses, raised)).toEqual([]);
		// A raised amount starts over.
		const raisedBudget = parseCostBudgets([{ scope: 'repo', value: 'acme/web', amount: 0.9, period: 'week' }]);
		expect(getNewBudgetAlerts(computeBudgetStatuses(raisedBudget, ENTRIES, NOW), raised).map(a => a.threshold)).toEqual([80]);
		const nextWeek = NOW + 7 * 24 * 60 * 60 * 1000;
		expect(getNewBudgetAlerts(computeBudgetStatuses(budgets, [...ENTRIES, entry(nextWeek, { cost: 0.3, repo: 'acme/web' })], nextWeek), raised).map(a => [a.status.budget.id, a.threshold])).toEqual([['repo:acme/web:week', 50]]);
	});

	it('refuses requests in the scope of a used up budget with a hard stop', () => {
		const hardStop = parseCostBudgets([
			{ scope: 'key', value: 'Team', amount: 0.75, hardStop: true },
			{ scope: 'repo', value: 'acme/web', amount: 0.1, period: 'day', hardStop: true },
			{ scope: 'key', value: 'Private', amount: 1 },
		]);
		const decide = (request: Parameters<typeof findHardStopBudget>[2]) => findHardStopBudget(hardStop, ENTRIES, request, NOW)?.budget.id;
		expect({
			teamKey: decide({ providerGroup: 'Team' }),
			// Private is used up but only warns.
			privateKey: decide({ providerGroup: 'Private' }),
			// Nothing was spent in acme/web today.
			repoToday: decide({ providerGroup: 'Other', repo: 'acme/web' }),
			otherKey: decide({ providerGroup: 'Other' }),
		}).toEqual({ teamKey: 'key:Team:month', privateKey: undefined, repoToday: undefined, otherKey: undefined });
		const later = at(10, 15, 11);
		expect(findHardStopBudget(hardStop, [...ENTRIES, entry(later, { cost: 0.2, repo: 'acme/web', providerGroup: 'Other' })], { providerGroup: 'Other', repo: 'acme/web' }, NOW)?.budget.id).toBe('repo:acme/web:day');
	});
});
