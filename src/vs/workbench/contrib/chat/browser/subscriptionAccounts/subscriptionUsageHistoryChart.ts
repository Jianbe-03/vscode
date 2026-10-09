/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the usage history of the Subscription Usage page, one bar per day for the past weeks.
// Per pool a verdict ("Enough accounts"), a one-line summary, a bar per day for how full the pool got
// (colored when an account hit its limit or all were used up, with a tick for the weekly limits) and a
// weekday-by-hour strip of when it is used; per account a compact row of daily bars. Pointing at a day,
// or moving through the days with the arrow keys, shows that day's details.

import * as DOM from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { ISubscriptionPoolVerdict, ISubscriptionUsageDay, ISubscriptionUsageHistorySummary, SUBSCRIPTION_POOL_TIGHT_PERCENT, getBusiestUsageTimes } from '../../../../../platform/agentHost/common/meta/subscriptionUsageHistory.js';
import { formatShortDuration } from '../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';

const $ = DOM.$;

/** The charts cover this many weeks. */
export const USAGE_HISTORY_WEEKS = 4;
export const USAGE_HISTORY_DAYS = USAGE_HISTORY_WEEKS * 7;

/** Up to this many limit hits a day are listed by account and time; more are counted. */
const LISTED_LIMIT_HITS = 3;

function formatDay(time: number): string {
	return new Date(time).toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(time: number): string {
	return new Date(time).toLocaleTimeString(language, { hour: 'numeric', minute: '2-digit' });
}

/** The time of day `hour` (0-24), such as "14:00". */
function formatHour(hour: number): string {
	return formatTime(new Date(2024, 0, 1, hour).getTime());
}

/** The name of a weekday, 0 being Monday. */
function formatWeekday(weekday: number, style: 'long' | 'short'): string {
	// 1 January 2024 was a Monday.
	return new Date(2024, 0, 1 + weekday).toLocaleDateString(language, { weekday: style });
}

/** E.g. "Hit its limit 2 times in 4 weeks". */
export function formatAccountHistorySummary(days: readonly ISubscriptionUsageDay[]): string {
	const hits = days.reduce((sum, day) => sum + day.limitHits.length, 0);
	switch (hits) {
		case 0: return localize('subscriptionHistory.neverHit', "Never hit its limit in {0} weeks", USAGE_HISTORY_WEEKS);
		case 1: return localize('subscriptionHistory.hitOnce', "Hit its limit once in {0} weeks", USAGE_HISTORY_WEEKS);
		default: return localize('subscriptionHistory.hits', "Hit its limit {0} times in {1} weeks", hits, USAGE_HISTORY_WEEKS);
	}
}

/**
 * E.g. "Last 4 weeks: an account hit its limit on 3 of 18 days with use · all accounts were used up
 * for 40m in total · busiest day: Tuesday, busiest hours: 14:00–16:00".
 */
export function formatPoolHistorySummary(summary: ISubscriptionUsageHistorySummary, verdict: ISubscriptionPoolVerdict): string {
	const parts = [
		verdict.limitDays
			? localize('subscriptionHistory.poolLimitDays', "an account hit its limit on {0} of {1} days with use", verdict.limitDays, verdict.usedDays)
			: localize('subscriptionHistory.poolNoLimitDays', "no account hit its limit on the {0} days with use", verdict.usedDays),
		verdict.allUsedUpMs
			? localize('subscriptionHistory.poolUsedUp', "all accounts were used up for {0} in total", formatShortDuration(verdict.allUsedUpMs))
			: localize('subscriptionHistory.poolNeverUsedUp', "never all used up at once"),
	];
	const busiest = getBusiestUsageTimes(summary.activity);
	if (busiest) {
		parts.push(localize('subscriptionHistory.poolBusiest', "busiest day: {0}, busiest hours: {1}–{2}", formatWeekday(busiest.weekday, 'long'), formatHour(busiest.hour), formatHour(busiest.hour + 2)));
	}
	return localize('subscriptionHistory.poolSummary', "Last {0} weeks: {1}", USAGE_HISTORY_WEEKS, parts.join(' · '));
}

/** The verdict as a short title, a sentence with the reason, and the rule behind it. */
export function formatPoolVerdict(verdict: ISubscriptionPoolVerdict): { readonly title: string; readonly detail: string; readonly rule: string } {
	const rule = localize('subscriptionHistory.verdictRule', "Judged on the last {0} weeks. Not enough: all accounts were used up at once on two days or more. Close to the limit: that happened on one day, or the pool got {1}% full on two days or more. Enough: otherwise. How full the pool is means the share of all accounts' 5-hour limits in use at the same moment.", USAGE_HISTORY_WEEKS, SUBSCRIPTION_POOL_TIGHT_PERCENT);
	switch (verdict.verdict) {
		case 'notEnough':
			return { title: localize('subscriptionHistory.verdictNotEnough', "Not enough accounts"), detail: localize('subscriptionHistory.verdictNotEnoughDetail', "All accounts were used up at once on {0} days.", verdict.usedUpDays), rule };
		case 'tight':
			return {
				title: localize('subscriptionHistory.verdictTight', "Close to the limit on busy days"),
				detail: verdict.usedUpDays
					? localize('subscriptionHistory.verdictTightUsedUp', "All accounts were used up at once on one day.")
					: localize('subscriptionHistory.verdictTightFull', "The pool got {0}% full or more on {1} days.", SUBSCRIPTION_POOL_TIGHT_PERCENT, verdict.tightDays),
				rule,
			};
		case 'enough':
			return {
				title: localize('subscriptionHistory.verdictEnough', "Enough accounts"),
				detail: verdict.tightDays
					? localize('subscriptionHistory.verdictEnoughOneDay', "The pool got {0}% full on only one day.", SUBSCRIPTION_POOL_TIGHT_PERCENT)
					: localize('subscriptionHistory.verdictEnoughDetail', "The pool stayed below {0}% full on every day.", SUBSCRIPTION_POOL_TIGHT_PERCENT),
				rule,
			};
	}
}

function formatLimitHits(day: ISubscriptionUsageDay, accountLabels: ReadonlyMap<string, string> | undefined): string | undefined {
	if (!day.limitHits.length) {
		return undefined;
	}
	if (!accountLabels) {
		return localize('subscriptionHistory.dayAccountHits', "hit its limit at {0}", day.limitHits.map(hit => formatTime(hit.t)).join(', '));
	}
	if (day.limitHits.length > LISTED_LIMIT_HITS) {
		return localize('subscriptionHistory.dayPoolHitCount', "accounts hit their limit {0} times", day.limitHits.length);
	}
	return day.limitHits.map(hit => localize('subscriptionHistory.dayPoolHit', "{0} hit its limit at {1}", accountLabels.get(hit.account) ?? hit.account, formatTime(hit.t))).join(', ');
}

/**
 * The details of a day, e.g. "Tue, 6 Oct: the pool got 85% full · Work hit its limit at 14:20 · all
 * accounts used up for 40m · weekly limits 45% used". `accountLabels` names the accounts of a pool;
 * without it the day is of a single account.
 */
export function formatUsageDay(day: ISubscriptionUsageDay, accountLabels: ReadonlyMap<string, string> | undefined): string {
	if (!day.used || day.peak === undefined) {
		return localize('subscriptionHistory.dayUnused', "{0}: not used", formatDay(day.start));
	}
	const parts = [accountLabels
		? localize('subscriptionHistory.dayPoolPeak', "the pool got {0}% full", day.peak)
		: localize('subscriptionHistory.dayAccountPeak', "5-hour limit up to {0}% used", day.peak)];
	const hits = formatLimitHits(day, accountLabels);
	if (hits) {
		parts.push(hits);
	}
	if (accountLabels && day.allUsedUpMs) {
		parts.push(localize('subscriptionHistory.dayUsedUp', "all accounts used up for {0}", formatShortDuration(day.allUsedUpMs)));
	}
	if (day.weekly !== undefined) {
		parts.push(accountLabels
			? localize('subscriptionHistory.dayPoolWeekly', "weekly limits {0}% used", day.weekly)
			: localize('subscriptionHistory.dayAccountWeekly', "weekly limit {0}% used", day.weekly));
	}
	return localize('subscriptionHistory.day', "{0}: {1}", formatDay(day.start), parts.join(' · '));
}

export interface IUsageDayChartOptions {
	/** The pool chart: taller, with axis labels and a legend, and a used-up pool in its own color. */
	readonly pool: boolean;
	readonly ariaLabel: string;
	/** Shows the details of the day under the pointer or keyboard focus, and `defaultReadout` otherwise. */
	readonly readout: HTMLElement;
	readonly defaultReadout: string;
	readonly describe: (day: ISubscriptionUsageDay) => string;
}

/**
 * Renders one bar per day: its height is the day's peak, a lighter and narrower bar is a weekend, a
 * warning color marks a limit hit (and, on the pool, a stronger one all accounts used up at once), and
 * a thin tick shows the weekly limit. The chart takes keyboard focus; the arrow keys move through the days.
 */
export function renderUsageDayChart(parent: HTMLElement, days: readonly ISubscriptionUsageDay[], options: IUsageDayChartOptions): DisposableStore {
	const disposables = new DisposableStore();
	const { readout, defaultReadout } = options;
	readout.textContent = defaultReadout;
	const chart = DOM.append(parent, $(`.subscription-usage-days.${options.pool ? 'pool' : 'compact'}`));
	if (!days.some(day => day.used)) {
		DOM.append(chart, $('.subscription-usage-days-empty', undefined, localize('subscriptionHistory.empty', "No usage recorded yet. Readings are taken every ten minutes while CreaEditor runs.")));
		return disposables;
	}

	if (options.pool) {
		const axis = DOM.append(chart, $('.subscription-usage-days-axis'));
		axis.setAttribute('aria-hidden', 'true');
		for (const value of [100, 50, 0]) {
			DOM.append(axis, $('span', undefined, localize('subscriptionHistory.percent', "{0}%", value)));
		}
	}
	const plot = DOM.append(chart, $('.subscription-usage-days-plot'));
	plot.tabIndex = 0;
	plot.setAttribute('role', 'group');
	plot.setAttribute('aria-label', options.ariaLabel);
	DOM.append(plot, $('.subscription-usage-days-rule.limit'));
	if (options.pool) {
		DOM.append(plot, $('.subscription-usage-days-rule.half'));
	}
	const columns = days.map(day => {
		const column = DOM.append(plot, $('.subscription-usage-days-day'));
		column.classList.toggle('weekend', day.weekend);
		if (day.peak === undefined) {
			DOM.append(column, $('.subscription-usage-days-none'));
		} else {
			const level = options.pool && day.allUsedUpMs ? 'used-up' : day.limitHits.length ? 'limit' : 'normal';
			const bar = DOM.append(column, $(`.subscription-usage-days-bar.${level}`));
			bar.style.height = `${Math.max(3, day.peak)}%`;
		}
		if (day.weekly !== undefined) {
			const tick = DOM.append(column, $('.subscription-usage-days-weekly'));
			tick.style.bottom = `${day.weekly}%`;
		}
		return column;
	});

	if (options.pool) {
		DOM.append(chart, $('span'));
		const labels = DOM.append(chart, $('.subscription-usage-days-labels'));
		labels.setAttribute('aria-hidden', 'true');
		days.forEach(day => {
			// A date at the start of every week.
			const text = new Date(day.start).getDay() === 1 ? new Date(day.start).toLocaleDateString(language, { day: 'numeric', month: 'short' }) : '';
			DOM.append(labels, $('span', undefined, text));
		});
	}
	// The readout goes right below the chart, unless it already has a place (such as a summary line).
	if (!readout.parentElement) {
		parent.appendChild(readout);
	}
	if (options.pool) {
		renderLegend(parent);
	}

	let selected: number | undefined;
	let focused = false;
	const select = (index: number | undefined) => {
		selected = index;
		columns.forEach((column, columnIndex) => column.classList.toggle('selected', columnIndex === index));
		readout.textContent = index === undefined ? defaultReadout : options.describe(days[index]);
	};
	const lastUsed = () => days.reduce((last, day, index) => day.used ? index : last, days.length - 1);
	disposables.add(DOM.addDisposableListener(plot, DOM.EventType.MOUSE_MOVE, (e: MouseEvent) => {
		const rect = plot.getBoundingClientRect();
		select(Math.max(0, Math.min(days.length - 1, Math.floor((e.clientX - rect.left) / rect.width * days.length))));
	}));
	disposables.add(DOM.addDisposableListener(plot, DOM.EventType.MOUSE_LEAVE, () => {
		if (!focused) {
			select(undefined);
		}
	}));
	disposables.add(DOM.addDisposableListener(plot, DOM.EventType.FOCUS, () => {
		focused = true;
		select(selected ?? lastUsed());
	}));
	disposables.add(DOM.addDisposableListener(plot, DOM.EventType.BLUR, () => {
		focused = false;
		select(undefined);
	}));
	disposables.add(DOM.addDisposableListener(plot, DOM.EventType.KEY_DOWN, (e: KeyboardEvent) => {
		const current = selected ?? lastUsed();
		const next = e.key === 'ArrowLeft' ? current - 1 : e.key === 'ArrowRight' ? current + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? days.length - 1 : undefined;
		if (next !== undefined) {
			e.preventDefault();
			select(Math.max(0, Math.min(days.length - 1, next)));
		}
	}));
	return disposables;
}

function renderLegend(parent: HTMLElement): void {
	const legend = DOM.append(parent, $('.subscription-usage-days-legend'));
	const entries: [string, string][] = [
		['normal', localize('subscriptionHistory.legendPeak', "How full the pool got (5-hour limits)")],
		['limit', localize('subscriptionHistory.legendLimit', "An account hit its limit")],
		['used-up', localize('subscriptionHistory.legendUsedUp', "All accounts used up")],
		['weekly', localize('subscriptionHistory.legendWeekly', "Weekly limits used")],
		['weekend', localize('subscriptionHistory.legendWeekend', "Weekend")],
	];
	for (const [kind, label] of entries) {
		const entry = DOM.append(legend, $('span.subscription-usage-days-legend-entry'));
		DOM.append(entry, $(`span.subscription-usage-days-swatch.${kind}`));
		DOM.append(entry, $('span', undefined, label));
	}
}

/**
 * Renders when the pool is used: a row per weekday and a cell per hour, darker where more of the
 * 5-hour limits was used. Renders nothing without usage.
 */
export function renderUsageActivity(parent: HTMLElement, activity: readonly (readonly number[])[]): void {
	const max = Math.max(0, ...activity.flat());
	if (!max) {
		return;
	}
	const section = DOM.append(parent, $('.subscription-usage-activity'));
	DOM.append(section, $('.subscription-usage-activity-title', undefined, localize('subscriptionHistory.activityTitle', "When the pool is used, by weekday and hour")));
	const grid = DOM.append(section, $('.subscription-usage-activity-grid'));
	grid.setAttribute('role', 'img');
	const busiest = getBusiestUsageTimes(activity);
	grid.setAttribute('aria-label', busiest
		? localize('subscriptionHistory.activityAria', "Usage by weekday and hour; most on {0}, between {1} and {2}", formatWeekday(busiest.weekday, 'long'), formatHour(busiest.hour), formatHour(busiest.hour + 2))
		: localize('subscriptionHistory.activityAriaEmpty', "Usage by weekday and hour"));
	DOM.append(grid, $('span'));
	for (let hour = 0; hour < 24; hour += 6) {
		DOM.append(grid, $('span.subscription-usage-activity-hour', undefined, formatHour(hour)));
	}
	activity.forEach((hours, weekday) => {
		DOM.append(grid, $('span.subscription-usage-activity-weekday', undefined, formatWeekday(weekday, 'short')));
		for (const value of hours) {
			const cell = DOM.append(grid, $('span.subscription-usage-activity-cell'));
			if (value > 0) {
				cell.classList.add('used');
				cell.style.opacity = String(0.15 + 0.85 * value / max);
			}
		}
	});
}
