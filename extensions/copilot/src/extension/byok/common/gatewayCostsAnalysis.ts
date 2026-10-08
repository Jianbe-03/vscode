/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the analysis behind the Advanced view of the AI Costs page: filtering, time buckets,
// aggregation, percentiles, the month projection and the pivot table. Pure, so it can be unit tested.

import { formatIssue, getIssueUrl } from '../../../platform/endpoint/common/gatewayTracking';
import { IGatewayCostEntry } from '../../../platform/endpoint/common/gatewayTrackingService';

/** A property the requests can be grouped by. */
export type CostDimension = 'key' | 'model' | 'gateway' | 'repo' | 'branch' | 'issue' | 'chat' | 'costSource' | 'kind';

/** The dimensions that have a multi-select filter; `kind` has its own toggle. */
export type CostFilterDimension = Exclude<CostDimension, 'kind'>;

export const COST_FILTER_DIMENSIONS: readonly CostFilterDimension[] = ['key', 'model', 'gateway', 'repo', 'branch', 'issue', 'chat', 'costSource'];

export type CostRangePreset = 'today' | '7' | '30' | '90' | 'thisMonth' | 'lastMonth' | 'all' | 'custom';

export type CostTimeBucket = 'day' | 'week' | 'month';

export type CostRequestColumn = 'time' | 'key' | 'model' | 'gateway' | 'chat' | 'issue' | 'repo' | 'promptTokens' | 'completionTokens' | 'cachedTokens' | 'cost' | 'costSource' | 'requestId';

/** Value of the group that collects everything outside the top groups. */
export const OTHER_VALUE = '\u0000other';

/** The filters of the Advanced view. All of them combine. */
export interface ICostFilters {
	readonly range: CostRangePreset;
	/** First day of a custom range, `YYYY-MM-DD` in local time. */
	readonly from?: string;
	/** Last day (inclusive) of a custom range, `YYYY-MM-DD` in local time. */
	readonly to?: string;
	/** Selected values per dimension; an empty or missing list means no filter. */
	readonly values?: Partial<Record<CostFilterDimension, readonly string[]>>;
	readonly kind?: 'both' | 'main' | 'subagent';
	/** Only requests for which no cost is known (yet). */
	readonly withoutCost?: boolean;
	readonly minCost?: number;
	readonly maxCost?: number;
	/** Free text matched against chat title, issue, repository, branch, model and request id. */
	readonly text?: string;
}

/** How the Advanced view wants the filtered requests aggregated. */
export interface ICostQueryOptions {
	readonly bucket: CostTimeBucket | 'auto';
	readonly stackBy: CostDimension;
	readonly breakdownBy: CostDimension;
	readonly pivotRows: CostDimension;
	readonly pivotColumns: CostDimension | 'none';
	readonly sortColumn: CostRequestColumn;
	readonly sortDescending: boolean;
	/** Zero based page of the requests table. */
	readonly page: number;
	readonly pageSize: number;
	/** Also compare the range with the period before it, see {@link computeCostComparison}. */
	readonly compare?: boolean;
}

/** A recorded request plus the values derived from it. */
export interface ICostRow extends IGatewayCostEntry {
	readonly issueLabel?: string;
	readonly issueUrl?: string;
	readonly subagent: boolean;
	/** Title of the chat that started the request (the root chat for subagents). */
	readonly rootTitle?: string;
}

interface IPreparedRow {
	readonly row: ICostRow;
	readonly search: string;
}

/** Requests prepared once per change of the ledger, so queries only filter and aggregate. */
export interface ICostDataset {
	readonly rows: readonly IPreparedRow[];
	/** Values to choose from per filter, most used first. */
	readonly options: Record<CostFilterDimension, readonly ICostOption[]>;
}

/** A value of a dimension; `label` is set when it differs from `value`. */
export interface ICostGroupKey {
	readonly value: string;
	readonly label?: string;
}

export interface ICostAggregate {
	readonly cost: number;
	readonly requests: number;
	/** Requests with a known cost. */
	readonly costed: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
}

export interface ICostGroup extends ICostGroupKey, ICostAggregate {
	/** Share of the total cost, 0 to 1. */
	readonly share: number;
}

export interface ICostProjection {
	readonly monthCost: number;
	readonly projected: number;
	readonly daysElapsed: number;
	readonly daysInMonth: number;
}

export interface ICostKpis {
	readonly cost: number;
	readonly requests: number;
	readonly withoutCost: number;
	readonly averageCost?: number;
	readonly medianCost?: number;
	readonly p95Cost?: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
	/** Cached share of the prompt tokens, 0 to 1. */
	readonly cacheShare?: number;
	readonly costPerMillionTokens?: number;
	readonly activeDays: number;
	readonly averagePerActiveDay?: number;
	/** Only when the range covers the current month up to today. */
	readonly projection?: ICostProjection;
	/** Share of the cost that subagents made, 0 to 1. */
	readonly subagentShare?: number;
}

export interface ICostBucket extends ICostAggregate {
	/** Epoch milliseconds of the start of the bucket (local time). */
	readonly start: number;
	/** Exclusive end. */
	readonly end: number;
	/** Cost per series, in the order of {@link ICostTimeline.series}. */
	readonly values: readonly number[];
}

export interface ICostTimeline {
	readonly bucket: CostTimeBucket;
	readonly series: readonly ICostGroupKey[];
	readonly buckets: readonly ICostBucket[];
}

export interface ICostPivot {
	readonly rows: readonly ICostGroupKey[];
	readonly columns: readonly ICostGroupKey[];
	/** `cells[row][column]`; empty when there are no columns. */
	readonly cells: readonly (readonly ICostAggregate[])[];
	readonly rowTotals: readonly ICostAggregate[];
	readonly columnTotals: readonly ICostAggregate[];
	readonly total: ICostAggregate;
}

export interface ICostOption extends ICostGroupKey {
	readonly count: number;
}

export interface ICostQueryResult {
	/** Number of recorded requests. */
	readonly total: number;
	/** Number of requests matching the filters. */
	readonly matching: number;
	readonly kpis: ICostKpis;
	readonly timeline: ICostTimeline;
	readonly breakdown: readonly ICostGroup[];
	readonly pivot: ICostPivot;
	readonly requests: { readonly rows: readonly ICostRow[]; readonly page: number; readonly pageCount: number };
	/** Values to choose from per filter, over all recorded requests, most used first. */
	readonly options: Record<CostFilterDimension, readonly ICostOption[]>;
	/** Only when asked for and the range has a start. */
	readonly comparison?: ICostComparison;
}

/** A value of a dimension in the current and in the previous period. */
export interface ICostComparisonRow extends ICostGroupKey {
	readonly current: ICostAggregate;
	readonly previous: ICostAggregate;
}

/** The range of the filters against the period of the same length just before it. */
export interface ICostComparison {
	/** Epoch milliseconds, `to` exclusive. */
	readonly current: { readonly from: number; readonly to: number };
	readonly previous: { readonly from: number; readonly to: number };
	/** The KPI cards of the previous period, with the same filters. */
	readonly previousKpis: ICostKpis;
	readonly total: { readonly current: ICostAggregate; readonly previous: ICostAggregate };
	readonly byKey: readonly ICostComparisonRow[];
	readonly byModel: readonly ICostComparisonRow[];
}

/** The change from a previous to a current value; `percent` is undefined when the previous value is 0. */
export interface ICostChange {
	readonly absolute: number;
	readonly percent?: number;
}

const DAY = 24 * 60 * 60 * 1000;
const SERIES_LIMIT = 6;
const BREAKDOWN_LIMIT = 25;
const PIVOT_ROW_LIMIT = 100;
const PIVOT_COLUMN_LIMIT = 10;
const MAX_BUCKETS = 400;
const GATEWAY_NAMES: Record<string, string> = { openrouter: 'OpenRouter', litellm: 'LiteLLM' };

/** Prepares the recorded requests for {@link runCostQuery} and {@link filterCostRows}. */
export function prepareCostDataset(entries: readonly IGatewayCostEntry[]): ICostDataset {
	const rootTitles = new Map<string, string>();
	for (const entry of entries) {
		if (entry.chatTitle && (entry.chatId === entry.rootChatId || !rootTitles.has(entry.rootChatId))) {
			rootTitles.set(entry.rootChatId, entry.chatTitle);
		}
	}
	const rows = entries.map(entry => {
		const row: ICostRow = {
			...entry,
			issueLabel: formatIssue(entry.issue, entry.repo),
			issueUrl: getIssueUrl(entry.issue),
			subagent: entry.chatId !== entry.rootChatId,
			rootTitle: rootTitles.get(entry.rootChatId),
		};
		const search = [row.rootTitle, row.chatTitle, row.issueLabel, row.repo, row.branch, row.model, row.gatewayRequestId, row.id].filter(Boolean).join('\n').toLowerCase();
		return { row, search };
	});
	return {
		rows,
		options: {
			key: computeOptions(rows, 'key'),
			model: computeOptions(rows, 'model'),
			gateway: computeOptions(rows, 'gateway'),
			repo: computeOptions(rows, 'repo'),
			branch: computeOptions(rows, 'branch'),
			issue: computeOptions(rows, 'issue'),
			chat: computeOptions(rows, 'chat'),
			costSource: computeOptions(rows, 'costSource'),
		},
	};
}

function startOfDay(time: number): Date {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date;
}

function addDays(date: Date, days: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + days);
	return result;
}

function startOfMonth(time: number, monthOffset = 0): Date {
	const date = new Date(time);
	return new Date(date.getFullYear(), date.getMonth() + monthOffset, 1);
}

function parseLocalDate(value: string | undefined): Date | undefined {
	const match = value ? /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/.exec(value) : undefined;
	if (!match?.groups) {
		return undefined;
	}
	return new Date(Number(match.groups.year), Number(match.groups.month) - 1, Number(match.groups.day));
}

/**
 * Returns the time range of the filters as epoch milliseconds, `to` exclusive. A missing bound is open.
 * Day based presets include today, so "7 days" is today and the 6 days before.
 */
export function resolveCostRange(filters: Pick<ICostFilters, 'range' | 'from' | 'to'>, now: number): { readonly from?: number; readonly to?: number } {
	const today = startOfDay(now);
	const tomorrow = addDays(today, 1).getTime();
	switch (filters.range) {
		case 'today':
			return { from: today.getTime(), to: tomorrow };
		case '7':
		case '30':
		case '90':
			return { from: addDays(today, 1 - Number(filters.range)).getTime(), to: tomorrow };
		case 'thisMonth':
			return { from: startOfMonth(now).getTime(), to: startOfMonth(now, 1).getTime() };
		case 'lastMonth':
			return { from: startOfMonth(now, -1).getTime(), to: startOfMonth(now).getTime() };
		case 'custom': {
			const from = parseLocalDate(filters.from);
			const to = parseLocalDate(filters.to);
			return { from: from?.getTime(), to: to ? addDays(to, 1).getTime() : undefined };
		}
		default:
			return {};
	}
}

/** Returns the value (and label) of a request for a dimension; `''` when the request has none. */
export function getDimensionKey(row: ICostRow, dimension: CostDimension): ICostGroupKey {
	switch (dimension) {
		case 'key': return { value: row.providerGroup ?? '' };
		case 'model': return { value: row.model };
		case 'gateway': return { value: `${row.gateway}:${row.gatewayHost}`, label: `${GATEWAY_NAMES[row.gateway] ?? row.gateway} · ${row.gatewayHost}` };
		case 'repo': return { value: row.repo ?? '' };
		case 'branch': return { value: row.branch ?? '' };
		case 'issue': return { value: row.issueLabel ?? '' };
		case 'chat': return { value: row.rootChatId, label: row.rootTitle };
		case 'costSource': return { value: row.costSource ?? '' };
		case 'kind': return { value: row.subagent ? 'subagent' : 'main' };
	}
}

function matches(prepared: IPreparedRow, filters: ICostFilters, range: { from?: number; to?: number }, selections: readonly [CostFilterDimension, ReadonlySet<string>][], text: string): boolean {
	const row = prepared.row;
	if ((range.from !== undefined && row.time < range.from) || (range.to !== undefined && row.time >= range.to)) {
		return false;
	}
	if ((filters.kind === 'main' && row.subagent) || (filters.kind === 'subagent' && !row.subagent)) {
		return false;
	}
	if (filters.withoutCost && row.cost !== undefined) {
		return false;
	}
	if (filters.minCost !== undefined && (row.cost === undefined || row.cost < filters.minCost)) {
		return false;
	}
	if (filters.maxCost !== undefined && (row.cost === undefined || row.cost > filters.maxCost)) {
		return false;
	}
	if (text && !prepared.search.includes(text)) {
		return false;
	}
	return selections.every(([dimension, values]) => values.has(getDimensionKey(row, dimension).value));
}

function filterPrepared(dataset: ICostDataset, filters: ICostFilters, range: { from?: number; to?: number }): IPreparedRow[] {
	const selections: [CostFilterDimension, ReadonlySet<string>][] = [];
	for (const dimension of COST_FILTER_DIMENSIONS) {
		const values = filters.values?.[dimension];
		if (values?.length) {
			selections.push([dimension, new Set(values)]);
		}
	}
	const text = (filters.text ?? '').trim().toLowerCase();
	return dataset.rows.filter(prepared => matches(prepared, filters, range, selections, text));
}

/** Returns the requests matching the filters, oldest first. */
export function filterCostRows(dataset: ICostDataset, filters: ICostFilters, now: number): ICostRow[] {
	return filterPrepared(dataset, filters, resolveCostRange(filters, now)).map(prepared => prepared.row);
}

/** Nearest-rank percentile of sorted values; `undefined` for no values. */
export function percentile(sorted: readonly number[], fraction: number): number | undefined {
	if (!sorted.length) {
		return undefined;
	}
	const rank = Math.ceil(fraction * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Median of sorted values: the middle value, or the mean of the two middle values. */
function median(sorted: readonly number[]): number | undefined {
	if (!sorted.length) {
		return undefined;
	}
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

class Aggregate implements ICostAggregate {
	cost = 0;
	requests = 0;
	costed = 0;
	promptTokens = 0;
	completionTokens = 0;
	cachedTokens = 0;

	add(row: IGatewayCostEntry): void {
		this.requests++;
		if (row.cost !== undefined) {
			this.cost += row.cost;
			this.costed++;
		}
		this.promptTokens += row.promptTokens ?? 0;
		this.completionTokens += row.completionTokens ?? 0;
		this.cachedTokens += row.cachedTokens ?? 0;
	}

	merge(other: ICostAggregate): void {
		this.cost += other.cost;
		this.requests += other.requests;
		this.costed += other.costed;
		this.promptTokens += other.promptTokens;
		this.completionTokens += other.completionTokens;
		this.cachedTokens += other.cachedTokens;
	}

	toJSON(): ICostAggregate {
		return { cost: this.cost, requests: this.requests, costed: this.costed, promptTokens: this.promptTokens, completionTokens: this.completionTokens, cachedTokens: this.cachedTokens };
	}
}

/** Computes the KPI cards of the Advanced view. */
export function computeCostKpis(rows: readonly ICostRow[], range: { from?: number; to?: number }, now: number): ICostKpis {
	const total = new Aggregate();
	const costs: number[] = [];
	const days = new Set<number>();
	let subagentCost = 0;
	let costedTokens = 0;
	for (const row of rows) {
		total.add(row);
		days.add(startOfDay(row.time).getTime());
		if (row.cost !== undefined) {
			costs.push(row.cost);
			costedTokens += (row.promptTokens ?? 0) + (row.completionTokens ?? 0);
			if (row.subagent) {
				subagentCost += row.cost;
			}
		}
	}
	costs.sort((a, b) => a - b);
	return {
		cost: total.cost,
		requests: total.requests,
		withoutCost: total.requests - total.costed,
		averageCost: total.costed ? total.cost / total.costed : undefined,
		medianCost: median(costs),
		p95Cost: percentile(costs, 0.95),
		promptTokens: total.promptTokens,
		completionTokens: total.completionTokens,
		cachedTokens: total.cachedTokens,
		cacheShare: total.promptTokens ? total.cachedTokens / total.promptTokens : undefined,
		costPerMillionTokens: costedTokens ? total.cost / costedTokens * 1e6 : undefined,
		activeDays: days.size,
		averagePerActiveDay: days.size && total.costed ? total.cost / days.size : undefined,
		projection: computeProjection(rows, range, now),
		subagentShare: total.cost > 0 ? subagentCost / total.cost : undefined,
	};
}

/**
 * Projects the cost of the current month: the cost so far this month divided by the days elapsed
 * (today included), times the days in the month. Only when the range covers the month up to now.
 */
function computeProjection(rows: readonly ICostRow[], range: { from?: number; to?: number }, now: number): ICostProjection | undefined {
	const monthStart = startOfMonth(now).getTime();
	if ((range.from !== undefined && range.from > monthStart) || (range.to !== undefined && range.to <= now)) {
		return undefined;
	}
	let monthCost = 0;
	for (const row of rows) {
		if (row.time >= monthStart && row.time <= now && row.cost !== undefined) {
			monthCost += row.cost;
		}
	}
	const daysElapsed = new Date(now).getDate();
	const daysInMonth = new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 0).getDate();
	return { monthCost, projected: monthCost / daysElapsed * daysInMonth, daysElapsed, daysInMonth };
}

function bucketStart(time: number, bucket: CostTimeBucket): Date {
	if (bucket === 'month') {
		return startOfMonth(time);
	}
	const day = startOfDay(time);
	// Weeks start on Monday.
	return bucket === 'week' ? addDays(day, -((day.getDay() + 6) % 7)) : day;
}

function nextBucket(start: Date, bucket: CostTimeBucket): Date {
	return bucket === 'month' ? new Date(start.getFullYear(), start.getMonth() + 1, 1) : addDays(start, bucket === 'week' ? 7 : 1);
}

/** Picks day, week or month buckets for a span, so the chart has between a handful and a few hundred bars. */
export function chooseCostBucket(from: number, to: number, requested: CostTimeBucket | 'auto'): CostTimeBucket {
	const days = (to - from) / DAY;
	let bucket: CostTimeBucket = requested !== 'auto' ? requested : days <= 35 ? 'day' : days <= 182 ? 'week' : 'month';
	if (bucket === 'day' && days > MAX_BUCKETS) {
		bucket = 'week';
	}
	if (bucket === 'week' && days / 7 > MAX_BUCKETS) {
		bucket = 'month';
	}
	return bucket;
}

/** Groups requests by a dimension, most expensive (then most used) first. */
function groupBy(rows: readonly ICostRow[], dimension: CostDimension): { key: ICostGroupKey; aggregate: Aggregate }[] {
	const groups = new Map<string, { key: ICostGroupKey; aggregate: Aggregate }>();
	for (const row of rows) {
		const key = getDimensionKey(row, dimension);
		let group = groups.get(key.value);
		if (!group) {
			group = { key, aggregate: new Aggregate() };
			groups.set(key.value, group);
		} else if (!group.key.label && key.label) {
			group.key = key;
		}
		group.aggregate.add(row);
	}
	return [...groups.values()].sort((a, b) => b.aggregate.cost - a.aggregate.cost || b.aggregate.requests - a.aggregate.requests || a.key.value.localeCompare(b.key.value));
}

/** Returns the keys of the top `limit` groups; with more groups the last one becomes {@link OTHER_VALUE}. */
function topKeys(rows: readonly ICostRow[], dimension: CostDimension, limit: number): ICostGroupKey[] {
	const groups = groupBy(rows, dimension);
	const keys = groups.slice(0, limit).map(group => group.key);
	return groups.length > limit ? [...keys, { value: OTHER_VALUE }] : keys;
}

/** Cost over time, in buckets, stacked by a dimension (top {@link SERIES_LIMIT} plus "other"). */
export function computeCostTimeline(rows: readonly ICostRow[], range: { from?: number; to?: number }, requested: CostTimeBucket | 'auto', stackBy: CostDimension, now: number): ICostTimeline {
	const from = range.from ?? rows.reduce((earliest, row) => Math.min(earliest, row.time), startOfDay(now).getTime());
	const to = range.to ?? addDays(startOfDay(now), 1).getTime();
	const bucket = chooseCostBucket(from, to, requested);
	const series = topKeys(rows, stackBy, SERIES_LIMIT);
	const seriesIndex = new Map(series.map((key, index) => [key.value, index]));
	const otherIndex = seriesIndex.get(OTHER_VALUE);

	const buckets: { start: number; end: number; values: number[]; aggregate: Aggregate }[] = [];
	for (let start = bucketStart(from, bucket); start.getTime() < to && buckets.length < MAX_BUCKETS * 2; start = nextBucket(start, bucket)) {
		buckets.push({ start: start.getTime(), end: nextBucket(start, bucket).getTime(), values: series.map(() => 0), aggregate: new Aggregate() });
	}
	for (const row of rows) {
		const index = findBucket(buckets, row.time);
		if (index < 0) {
			continue;
		}
		const target = buckets[index];
		target.aggregate.add(row);
		const seriesAt = seriesIndex.get(getDimensionKey(row, stackBy).value) ?? otherIndex;
		if (seriesAt !== undefined && row.cost !== undefined) {
			target.values[seriesAt] += row.cost;
		}
	}
	return { bucket, series, buckets: buckets.map(item => ({ start: item.start, end: item.end, values: item.values, ...item.aggregate.toJSON() })) };
}

function findBucket(buckets: readonly { start: number; end: number }[], time: number): number {
	let low = 0;
	let high = buckets.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		if (time < buckets[middle].start) {
			high = middle - 1;
		} else if (time >= buckets[middle].end) {
			low = middle + 1;
		} else {
			return middle;
		}
	}
	return -1;
}

/** Cost, share and requests per value of a dimension (top {@link BREAKDOWN_LIMIT} plus "other"). */
export function computeCostBreakdown(rows: readonly ICostRow[], dimension: CostDimension): ICostGroup[] {
	const groups = groupBy(rows, dimension);
	const totalCost = groups.reduce((sum, group) => sum + group.aggregate.cost, 0);
	const result: ICostGroup[] = groups.slice(0, BREAKDOWN_LIMIT).map(group => ({ ...group.key, ...group.aggregate.toJSON(), share: totalCost ? group.aggregate.cost / totalCost : 0 }));
	if (groups.length > BREAKDOWN_LIMIT) {
		const other = new Aggregate();
		for (const group of groups.slice(BREAKDOWN_LIMIT)) {
			other.merge(group.aggregate);
		}
		result.push({ value: OTHER_VALUE, ...other.toJSON(), share: totalCost ? other.cost / totalCost : 0 });
	}
	return result;
}

/** A pivot table of dimension `rowsBy` against `columnsBy`, with row, column and grand totals. */
export function computeCostPivot(rows: readonly ICostRow[], rowsBy: CostDimension, columnsBy: CostDimension | 'none'): ICostPivot {
	const rowKeys = topKeys(rows, rowsBy, PIVOT_ROW_LIMIT);
	const columnKeys = columnsBy === 'none' ? [] : topKeys(rows, columnsBy, PIVOT_COLUMN_LIMIT);
	const rowIndex = new Map(rowKeys.map((key, index) => [key.value, index]));
	const columnIndex = new Map(columnKeys.map((key, index) => [key.value, index]));
	const cells = rowKeys.map(() => columnKeys.map(() => new Aggregate()));
	const rowTotals = rowKeys.map(() => new Aggregate());
	const columnTotals = columnKeys.map(() => new Aggregate());
	const total = new Aggregate();
	for (const row of rows) {
		const r = rowIndex.get(getDimensionKey(row, rowsBy).value) ?? rowIndex.get(OTHER_VALUE);
		total.add(row);
		if (r === undefined) {
			continue;
		}
		rowTotals[r].add(row);
		if (columnsBy !== 'none') {
			const c = columnIndex.get(getDimensionKey(row, columnsBy).value) ?? columnIndex.get(OTHER_VALUE);
			if (c !== undefined) {
				cells[r][c].add(row);
				columnTotals[c].add(row);
			}
		}
	}
	return {
		rows: rowKeys,
		columns: columnKeys,
		cells: cells.map(cellRow => cellRow.map(cell => cell.toJSON())),
		rowTotals: rowTotals.map(cell => cell.toJSON()),
		columnTotals: columnTotals.map(cell => cell.toJSON()),
		total: total.toJSON(),
	};
}

function sortValue(row: ICostRow, column: CostRequestColumn): string | number | undefined {
	switch (column) {
		case 'time': return row.time;
		case 'key': return row.providerGroup;
		case 'model': return row.model;
		case 'gateway': return getDimensionKey(row, 'gateway').label;
		case 'chat': return row.rootTitle;
		case 'issue': return row.issueLabel;
		case 'repo': return [row.repo, row.branch].filter(Boolean).join(' ') || undefined;
		case 'promptTokens': return row.promptTokens;
		case 'completionTokens': return row.completionTokens;
		case 'cachedTokens': return row.cachedTokens;
		case 'cost': return row.cost;
		case 'costSource': return row.costSource;
		case 'requestId': return row.gatewayRequestId;
	}
}

/** Sorts requests by a column; requests without a value always come last. */
export function sortCostRows(rows: readonly ICostRow[], column: CostRequestColumn, descending: boolean): ICostRow[] {
	const direction = descending ? -1 : 1;
	return [...rows].sort((a, b) => {
		const x = sortValue(a, column);
		const y = sortValue(b, column);
		if (x === undefined || y === undefined) {
			return x === y ? b.time - a.time : x === undefined ? 1 : -1;
		}
		const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
		return order * direction || b.time - a.time;
	});
}

function computeOptions(rows: readonly IPreparedRow[], dimension: CostFilterDimension): ICostOption[] {
	const counts = new Map<string, { key: ICostGroupKey; count: number }>();
	for (const { row } of rows) {
		const key = getDimensionKey(row, dimension);
		const item = counts.get(key.value);
		if (!item) {
			counts.set(key.value, { key, count: 1 });
		} else {
			item.count++;
			if (!item.key.label && key.label) {
				item.key = key;
			}
		}
	}
	return [...counts.values()].sort((a, b) => b.count - a.count).map(item => ({ ...item.key, count: item.count }));
}

/** Runs the whole Advanced view query: filters, then aggregates for the cards, charts and tables. */
export function runCostQuery(dataset: ICostDataset, filters: ICostFilters, options: ICostQueryOptions, now: number): ICostQueryResult {
	const rows = filterCostRows(dataset, filters, now);
	const range = resolveCostRange(filters, now);
	const pageSize = Math.max(1, options.pageSize);
	const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
	const page = Math.min(Math.max(0, options.page), pageCount - 1);
	const sorted = sortCostRows(rows, options.sortColumn, options.sortDescending);
	return {
		total: dataset.rows.length,
		matching: rows.length,
		kpis: computeCostKpis(rows, range, now),
		timeline: computeCostTimeline(rows, range, options.bucket, options.stackBy, now),
		breakdown: computeCostBreakdown(rows, options.breakdownBy),
		pivot: computeCostPivot(rows, options.pivotRows, options.pivotColumns),
		requests: { rows: sorted.slice(page * pageSize, (page + 1) * pageSize), page, pageCount },
		options: dataset.options,
		comparison: options.compare ? computeCostComparison(dataset, filters, now) : undefined,
	};
}

/**
 * Returns the period just before the range of the filters, of the same length: the previous month
 * for "this month" and "last month", otherwise as many whole days before. `undefined` without a start.
 */
export function resolvePreviousCostRange(filters: Pick<ICostFilters, 'range' | 'from' | 'to'>, now: number): { readonly current: { readonly from: number; readonly to: number }; readonly previous: { readonly from: number; readonly to: number } } | undefined {
	const range = resolveCostRange(filters, now);
	if (range.from === undefined) {
		return undefined;
	}
	const current = { from: range.from, to: range.to ?? addDays(startOfDay(now), 1).getTime() };
	if (filters.range === 'thisMonth' || filters.range === 'lastMonth') {
		const monthStart = new Date(current.from);
		return { current, previous: { from: new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1).getTime(), to: current.from } };
	}
	// Whole local days, so a change to or from daylight saving time keeps the days aligned.
	const days = Math.max(1, Math.round((current.to - current.from) / DAY));
	return { current, previous: { from: addDays(new Date(current.from), -days).getTime(), to: current.from } };
}

/** The change from `previous` to `current`. */
export function computeCostChange(current: number, previous: number): ICostChange {
	return { absolute: current - previous, percent: previous ? (current - previous) / Math.abs(previous) : undefined };
}

function compareBy(current: readonly ICostRow[], previous: readonly ICostRow[], dimension: CostDimension): ICostComparisonRow[] {
	const groups = new Map<string, { key: ICostGroupKey; current: Aggregate; previous: Aggregate }>();
	const add = (rows: readonly ICostRow[], period: 'current' | 'previous') => {
		for (const row of rows) {
			const key = getDimensionKey(row, dimension);
			let group = groups.get(key.value);
			if (!group) {
				group = { key, current: new Aggregate(), previous: new Aggregate() };
				groups.set(key.value, group);
			} else if (!group.key.label && key.label) {
				group.key = key;
			}
			group[period].add(row);
		}
	};
	add(current, 'current');
	add(previous, 'previous');
	const sorted = [...groups.values()].sort((a, b) => b.current.cost - a.current.cost || b.previous.cost - a.previous.cost || b.current.requests - a.current.requests || a.key.value.localeCompare(b.key.value));
	const result: ICostComparisonRow[] = sorted.slice(0, BREAKDOWN_LIMIT).map(group => ({ ...group.key, current: group.current.toJSON(), previous: group.previous.toJSON() }));
	if (sorted.length > BREAKDOWN_LIMIT) {
		const other = { current: new Aggregate(), previous: new Aggregate() };
		for (const group of sorted.slice(BREAKDOWN_LIMIT)) {
			other.current.merge(group.current);
			other.previous.merge(group.previous);
		}
		result.push({ value: OTHER_VALUE, current: other.current.toJSON(), previous: other.previous.toJSON() });
	}
	return result;
}

/**
 * Compares the range of the filters with the period before it (see {@link resolvePreviousCostRange}),
 * with all other filters the same: totals, KPI cards, and cost, requests and tokens per key and per model.
 */
export function computeCostComparison(dataset: ICostDataset, filters: ICostFilters, now: number): ICostComparison | undefined {
	const periods = resolvePreviousCostRange(filters, now);
	if (!periods) {
		return undefined;
	}
	const current = filterPrepared(dataset, filters, periods.current).map(prepared => prepared.row);
	const previous = filterPrepared(dataset, filters, periods.previous).map(prepared => prepared.row);
	const total = (rows: readonly ICostRow[]) => {
		const aggregate = new Aggregate();
		for (const row of rows) {
			aggregate.add(row);
		}
		return aggregate.toJSON();
	};
	return {
		current: periods.current,
		previous: periods.previous,
		previousKpis: computeCostKpis(previous, periods.previous, now),
		total: { current: total(current), previous: total(previous) },
		byKey: compareBy(current, previous, 'key'),
		byModel: compareBy(current, previous, 'model'),
	};
}

/** Cost, requests and tokens per chat, keyed by the main chat id, so subagents count for their main chat. */
export function computeChatCosts(entries: readonly IGatewayCostEntry[]): Map<string, ICostAggregate> {
	const chats = new Map<string, Aggregate>();
	for (const entry of entries) {
		let aggregate = chats.get(entry.rootChatId);
		if (!aggregate) {
			aggregate = new Aggregate();
			chats.set(entry.rootChatId, aggregate);
		}
		aggregate.add(entry);
	}
	return new Map([...chats].map(([chatId, aggregate]) => [chatId, aggregate.toJSON()]));
}

/** The chats whose totals differ between two results of {@link computeChatCosts}, including added and removed chats. */
export function getChangedChats(previous: ReadonlyMap<string, ICostAggregate>, next: ReadonlyMap<string, ICostAggregate>): string[] {
	const changed: string[] = [];
	for (const [chatId, aggregate] of next) {
		const before = previous.get(chatId);
		if (!before || before.cost !== aggregate.cost || before.requests !== aggregate.requests || before.costed !== aggregate.costed
			|| before.promptTokens !== aggregate.promptTokens || before.completionTokens !== aggregate.completionTokens || before.cachedTokens !== aggregate.cachedTokens) {
			changed.push(chatId);
		}
	}
	for (const chatId of previous.keys()) {
		if (!next.has(chatId)) {
			changed.push(chatId);
		}
	}
	return changed;
}

/** What a budget limits: the requests of a key (provider group), an issue or a repository. */
export type CostBudgetScope = 'key' | 'issue' | 'repo';

export type CostBudgetPeriod = 'day' | 'week' | 'month';

/** The warning thresholds of a budget without its own, in percent of the amount. */
export const DEFAULT_BUDGET_WARN_AT: readonly number[] = [80, 100];

/** A user-defined budget, e.g. "warn at $50 per month on the Personal key". */
export interface ICostBudget {
	readonly id: string;
	readonly scope: CostBudgetScope;
	/** Key (provider group) name, issue label as the ledger shows it (`owner/repo#42`, `PROJ-7`) or `owner/repo`. */
	readonly value: string;
	/** USD per period. */
	readonly amount: number;
	readonly period: CostBudgetPeriod;
	/** Percentages of the amount that raise an alert, ascending. */
	readonly warnAt: readonly number[];
	/** Refuse the requests of the scope once the amount is spent. */
	readonly hardStop: boolean;
}

/** The spend of a budget in its current period. */
export interface ICostBudgetStatus {
	readonly budget: ICostBudget;
	readonly spent: number;
	/** Spent share of the amount, 0 and up (above 1 when overspent). */
	readonly share: number;
	/** Epoch milliseconds of the period, `to` exclusive. */
	readonly from: number;
	readonly to: number;
	/** The thresholds of {@link ICostBudget.warnAt} that are reached. */
	readonly reached: readonly number[];
	/** Whether the whole amount is spent. */
	readonly exhausted: boolean;
}

/** An alert to raise for a budget: one per threshold per period, identified by {@link key}. */
export interface ICostBudgetAlert {
	readonly key: string;
	readonly status: ICostBudgetStatus;
	readonly threshold: number;
}

/** What a request is for, as the ledger would record it. */
export interface ICostBudgetRequest {
	readonly providerGroup?: string;
	/** Issue label as {@link formatIssue} makes it. */
	readonly issue?: string;
	readonly repo?: string;
}

const BUDGET_SCOPES: readonly CostBudgetScope[] = ['key', 'issue', 'repo'];
const BUDGET_PERIODS: readonly CostBudgetPeriod[] = ['day', 'week', 'month'];

/**
 * Reads the budgets from the `creaeditor.aiCosts.budgets` setting. Entries that are not valid budgets
 * are left out; a budget without an id gets one from its scope, value and period.
 */
export function parseCostBudgets(value: unknown): ICostBudget[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: ICostBudget[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const raw = item as Record<string, unknown>;
		const scope = BUDGET_SCOPES.find(scope => scope === raw.scope);
		const period = BUDGET_PERIODS.find(period => period === raw.period) ?? 'month';
		const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) && raw.amount > 0 ? raw.amount : undefined;
		const budgetValue = typeof raw.value === 'string' ? raw.value.trim() : '';
		if (!scope || amount === undefined || !budgetValue) {
			continue;
		}
		const warnAt = Array.isArray(raw.warnAt)
			? [...new Set(raw.warnAt.filter((percent): percent is number => typeof percent === 'number' && Number.isFinite(percent) && percent > 0))].sort((a, b) => a - b)
			: [...DEFAULT_BUDGET_WARN_AT];
		let id = typeof raw.id === 'string' && raw.id ? raw.id : `${scope}:${budgetValue}:${period}`;
		while (ids.has(id)) {
			id += '+';
		}
		ids.add(id);
		result.push({ id, scope, value: budgetValue, amount, period, warnAt, hardStop: raw.hardStop === true });
	}
	return result;
}

/** The current day, week (from Monday) or month of a budget in local time, `to` exclusive. */
export function getBudgetPeriodRange(period: CostBudgetPeriod, now: number): { readonly from: number; readonly to: number } {
	const start = bucketStart(now, period);
	return { from: start.getTime(), to: nextBucket(start, period).getTime() };
}

function budgetMatchesEntry(budget: ICostBudget, entry: IGatewayCostEntry): boolean {
	return budgetMatchesRequest(budget, { providerGroup: entry.providerGroup, issue: formatIssue(entry.issue, entry.repo), repo: entry.repo });
}

/** Whether a request falls in the scope of a budget. */
export function budgetMatchesRequest(budget: ICostBudget, request: ICostBudgetRequest): boolean {
	switch (budget.scope) {
		case 'key': return request.providerGroup === budget.value;
		case 'issue': return request.issue === budget.value;
		case 'repo': return request.repo === budget.value;
	}
}

/** The spend of every budget in its current period, from the ledger. */
export function computeBudgetStatuses(budgets: readonly ICostBudget[], entries: readonly IGatewayCostEntry[], now: number): ICostBudgetStatus[] {
	return budgets.map(budget => {
		const { from, to } = getBudgetPeriodRange(budget.period, now);
		let spent = 0;
		for (const entry of entries) {
			if (entry.time >= from && entry.time < to && entry.cost !== undefined && budgetMatchesEntry(budget, entry)) {
				spent += entry.cost;
			}
		}
		const share = spent / budget.amount;
		return { budget, spent, share, from, to, reached: budget.warnAt.filter(percent => share * 100 >= percent), exhausted: spent >= budget.amount };
	});
}

/**
 * The alerts that were not raised yet. Only the highest reached threshold of a budget is raised, so a
 * budget that jumps from 70% to 105% says "used up" once instead of also "80% used".
 * @param raised keys of the alerts raised before, see {@link ICostBudgetAlert.key}
 */
export function getNewBudgetAlerts(statuses: readonly ICostBudgetStatus[], raised: ReadonlySet<string>): ICostBudgetAlert[] {
	const alerts: ICostBudgetAlert[] = [];
	for (const status of statuses) {
		const keys = status.reached.map(threshold => ({ threshold, key: getBudgetAlertKey(status, threshold) }));
		const highest = keys.at(-1);
		if (highest && !raised.has(highest.key)) {
			alerts.push({ key: highest.key, status, threshold: highest.threshold });
		}
	}
	return alerts;
}

/** The key of the alert of a threshold of a budget in the current period. Lower thresholds of the period count as raised too. */
export function getBudgetAlertKeys(status: ICostBudgetStatus): string[] {
	return status.reached.map(threshold => getBudgetAlertKey(status, threshold));
}

function getBudgetAlertKey(status: ICostBudgetStatus, threshold: number): string {
	const { budget } = status;
	return `${budget.id}|${budget.amount}|${status.from}|${threshold}`;
}

/**
 * The used up budget with a hard stop that refuses a request, if any; the one used up the furthest
 * when several are. Only budgets with a hard stop are looked at, so this is cheap without them.
 */
export function findHardStopBudget(budgets: readonly ICostBudget[], entries: readonly IGatewayCostEntry[], request: ICostBudgetRequest, now: number): ICostBudgetStatus | undefined {
	const relevant = budgets.filter(budget => budget.hardStop && budgetMatchesRequest(budget, request));
	if (!relevant.length) {
		return undefined;
	}
	return computeBudgetStatuses(relevant, entries, now)
		.filter(status => status.exhausted)
		.sort((a, b) => b.share - a.share)[0];
}
