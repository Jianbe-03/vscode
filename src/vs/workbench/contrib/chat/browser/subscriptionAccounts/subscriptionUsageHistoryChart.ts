/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the usage history charts of the Subscription Usage page. Per account a line per usage
// window (used share per hour over the past weeks, with the 100% limit as a reference line), per pool
// the tightest window averaged over its accounts, each with a summary such as "Hit its limit 6 times in
// 4 weeks". Pointing at a chart shows the values of that hour below it.

import * as DOM from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { ISubscriptionUsageSample, countLimitHits, getSampleUsedPercent } from '../../../../../platform/agentHost/common/meta/subscriptionUsageHistory.js';

/** The charts cover this many weeks. */
export const USAGE_HISTORY_WEEKS = 4;
/** One point per hour. */
export const USAGE_HISTORY_BUCKET_MS = 60 * 60 * 1000;

/** One line of a chart: a name and the highest used share per bucket (undefined without a reading). */
export interface IUsageHistorySeries {
	readonly label: string;
	readonly values: readonly (number | undefined)[];
}

/** The time range of the charts, ending at the hour `now` falls in. */
export function getUsageHistoryRange(now: number): { readonly start: number; readonly buckets: number } {
	const end = Math.floor(now / USAGE_HISTORY_BUCKET_MS) * USAGE_HISTORY_BUCKET_MS + USAGE_HISTORY_BUCKET_MS;
	const buckets = USAGE_HISTORY_WEEKS * 7 * 24;
	return { start: end - buckets * USAGE_HISTORY_BUCKET_MS, buckets };
}

function bucketOf(time: number, start: number, buckets: number): number | undefined {
	const index = Math.floor((time - start) / USAGE_HISTORY_BUCKET_MS);
	return index >= 0 && index < buckets ? index : undefined;
}

/**
 * One series per usage window of an account's samples, in the order the windows first appear, with
 * the highest used share per bucket. `labels` names the windows (by kind); unknown kinds keep their kind.
 */
export function getAccountUsageSeries(samples: readonly ISubscriptionUsageSample[], start: number, buckets: number, labels: ReadonlyMap<string, string>): IUsageHistorySeries[] {
	const byKind = new Map<string, (number | undefined)[]>();
	for (const sample of samples) {
		const index = bucketOf(sample.t, start, buckets);
		if (index === undefined) {
			continue;
		}
		for (const [kind, used] of sample.w) {
			let values = byKind.get(kind);
			if (!values) {
				values = new Array<number | undefined>(buckets).fill(undefined);
				byKind.set(kind, values);
			}
			values[index] = Math.max(values[index] ?? 0, Math.min(100, used));
		}
	}
	return [...byKind].map(([kind, values]) => ({ label: labels.get(kind) ?? kind, values }));
}

/**
 * The pool line (the tightest window, averaged over the accounts with a reading in each bucket) and
 * how many buckets every account of the pool was used up at once.
 */
export function getPoolUsageHistory(samplesByAccount: ReadonlyMap<string, readonly ISubscriptionUsageSample[]>, start: number, buckets: number): { readonly values: readonly (number | undefined)[]; readonly exhaustedBuckets: number } {
	const perAccount = [...samplesByAccount.values()].map(samples => {
		const values = new Array<number | undefined>(buckets).fill(undefined);
		for (const sample of samples) {
			const index = bucketOf(sample.t, start, buckets);
			if (index !== undefined) {
				values[index] = Math.max(values[index] ?? 0, Math.min(100, getSampleUsedPercent(sample)));
			}
		}
		return values;
	});
	const values: (number | undefined)[] = [];
	let exhaustedBuckets = 0;
	for (let index = 0; index < buckets; index++) {
		const readings = perAccount.map(account => account[index]).filter((value): value is number => value !== undefined);
		values.push(readings.length ? Math.round(readings.reduce((sum, value) => sum + value, 0) / readings.length) : undefined);
		if (perAccount.length > 0 && readings.length === perAccount.length && readings.every(value => value >= 100)) {
			exhaustedBuckets++;
		}
	}
	return { values, exhaustedBuckets };
}

/** E.g. "Hit its limit 6 times in 4 weeks". */
export function formatAccountHistorySummary(samples: readonly ISubscriptionUsageSample[], start: number): string {
	const hits = countLimitHits(samples.filter(sample => sample.t >= start));
	switch (hits) {
		case 0: return localize('subscriptionHistory.neverHit', "Never hit its limit in {0} weeks", USAGE_HISTORY_WEEKS);
		case 1: return localize('subscriptionHistory.hitOnce', "Hit its limit once in {0} weeks", USAGE_HISTORY_WEEKS);
		default: return localize('subscriptionHistory.hits', "Hit its limit {0} times in {1} weeks", hits, USAGE_HISTORY_WEEKS);
	}
}

/** E.g. "Accounts hit their limit 9 times in 4 weeks; all were used up at once for 5 hours". */
export function formatPoolHistorySummary(samplesByAccount: ReadonlyMap<string, readonly ISubscriptionUsageSample[]>, start: number, exhaustedBuckets: number): string {
	const hits = [...samplesByAccount.values()].reduce((sum, samples) => sum + countLimitHits(samples.filter(sample => sample.t >= start)), 0);
	const hitsText = localize('subscriptionHistory.poolHits', "Accounts hit their limit {0} times in {1} weeks", hits, USAGE_HISTORY_WEEKS);
	if (!exhaustedBuckets) {
		return localize('subscriptionHistory.poolNeverExhausted', "{0}; never all used up at once", hitsText);
	}
	return exhaustedBuckets === 1
		? localize('subscriptionHistory.poolExhaustedHour', "{0}; all were used up at once for about an hour", hitsText)
		: localize('subscriptionHistory.poolExhaustedHours', "{0}; all were used up at once for about {1} hours", hitsText, exhaustedBuckets);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 640;
const CHART_HEIGHT = 120;
/** Room for the percent labels on the left. */
const PLOT_LEFT = 32;
const PLOT_TOP = 6;
const PLOT_BOTTOM = 18;
/** Fixed hue order: the first window (5-hour) takes the first color, and so on. */
const SERIES_CLASSES = ['series-1', 'series-2', 'series-3', 'series-4'];

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
	const element = parent.ownerDocument.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) {
		element.setAttribute(name, String(value));
	}
	parent.appendChild(element);
	return element;
}

function formatBucketTime(time: number): string {
	return new Date(time).toLocaleString(language, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * Renders a line chart of `series` (at most four lines; more fold into the first four) from `start`, one
 * point per bucket, with a legend, a 100% limit line and a readout of the hour under the pointer.
 */
export function renderUsageHistoryChart(parent: HTMLElement, series: readonly IUsageHistorySeries[], start: number, ariaLabel: string): DisposableStore {
	const disposables = new DisposableStore();
	const shown = series.slice(0, SERIES_CLASSES.length);
	const buckets = shown[0]?.values.length ?? 0;
	const container = DOM.append(parent, DOM.$('.subscription-usage-history-chart'));
	if (!buckets || shown.every(line => line.values.every(value => value === undefined))) {
		DOM.append(container, DOM.$('.subscription-usage-history-empty', undefined, localize('subscriptionHistory.empty', "No usage history yet. Readings are recorded every ten minutes while CreaEditor runs.")));
		return disposables;
	}

	if (shown.length > 1) {
		const legend = DOM.append(container, DOM.$('.subscription-usage-history-legend'));
		shown.forEach((line, index) => {
			const entry = DOM.append(legend, DOM.$(`span.subscription-usage-history-legend-entry.${SERIES_CLASSES[index]}`));
			DOM.append(entry, DOM.$('span.subscription-usage-history-swatch'));
			DOM.append(entry, DOM.$('span', undefined, line.label));
		});
	}

	const root = svg('svg', { viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`, role: 'img', 'aria-label': ariaLabel, class: 'subscription-usage-history-svg' }, container);
	const plotWidth = CHART_WIDTH - PLOT_LEFT;
	const plotHeight = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;
	const x = (index: number) => PLOT_LEFT + (buckets === 1 ? 0 : index / (buckets - 1)) * plotWidth;
	const y = (value: number) => PLOT_TOP + (1 - value / 100) * plotHeight;

	for (const value of [0, 50, 100]) {
		svg('line', { x1: PLOT_LEFT, x2: CHART_WIDTH, y1: y(value), y2: y(value), class: value === 100 ? 'limit-line' : 'grid-line' }, root);
		const label = svg('text', { x: PLOT_LEFT - 4, y: y(value) + 3, 'text-anchor': 'end', class: 'axis-label' }, root);
		label.textContent = localize('subscriptionHistory.percent', "{0}%", value);
	}
	// A label per week on the time axis.
	const bucketsPerWeek = 7 * 24;
	for (let index = 0; index < buckets; index += bucketsPerWeek) {
		const label = svg('text', { x: x(index), y: CHART_HEIGHT - 4, 'text-anchor': index === 0 ? 'start' : 'middle', class: 'axis-label' }, root);
		label.textContent = new Date(start + index * USAGE_HISTORY_BUCKET_MS).toLocaleDateString(language, { day: 'numeric', month: 'short' });
	}

	shown.forEach((line, seriesIndex) => {
		// A gap without readings (the app was closed) breaks the line.
		let path = '';
		let drawing = false;
		line.values.forEach((value, index) => {
			if (value === undefined) {
				drawing = false;
				return;
			}
			path += `${drawing ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
			drawing = true;
		});
		svg('path', { d: path, class: `series-line ${SERIES_CLASSES[seriesIndex]}`, 'vector-effect': 'non-scaling-stroke' }, root);
	});

	const guide = svg('line', { x1: 0, x2: 0, y1: PLOT_TOP, y2: PLOT_TOP + plotHeight, class: 'guide-line', visibility: 'hidden' }, root);
	const readout = DOM.append(container, DOM.$('.subscription-usage-history-readout'));
	const defaultReadout = localize('subscriptionHistory.pointHint', "Point at the chart to see the usage of an hour.");
	readout.textContent = defaultReadout;
	disposables.add(DOM.addDisposableListener(root, DOM.EventType.MOUSE_MOVE, (e: MouseEvent) => {
		const rect = root.getBoundingClientRect();
		const svgX = (e.clientX - rect.left) / rect.width * CHART_WIDTH;
		const index = Math.max(0, Math.min(buckets - 1, Math.round((svgX - PLOT_LEFT) / plotWidth * (buckets - 1))));
		guide.setAttribute('x1', String(x(index)));
		guide.setAttribute('x2', String(x(index)));
		guide.setAttribute('visibility', 'visible');
		const values = shown.map(line => line.values[index] === undefined
			? localize('subscriptionHistory.noValue', "{0}: no reading", line.label)
			: localize('subscriptionHistory.value', "{0}: {1}% used", line.label, Math.round(line.values[index]!)));
		readout.textContent = localize('subscriptionHistory.readout', "{0} · {1}", formatBucketTime(start + index * USAGE_HISTORY_BUCKET_MS), values.join(' · '));
	}));
	disposables.add(DOM.addDisposableListener(root, DOM.EventType.MOUSE_LEAVE, () => {
		guide.setAttribute('visibility', 'hidden');
		readout.textContent = defaultReadout;
	}));
	return disposables;
}
