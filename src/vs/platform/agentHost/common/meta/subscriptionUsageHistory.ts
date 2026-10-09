/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the usage history of the pooled Claude and Codex subscription accounts. The agent host
// appends one compact sample per account at most every ten minutes (and whenever an account hits or
// leaves its limit) to {@link SUBSCRIPTION_USAGE_HISTORY_FILE} next to `agent-subscription-accounts.json`
// and keeps eight weeks of it. The usage page reads the file and sums it up per day with
// {@link summarizeUsageHistory}: how full each pool got, when accounts hit their limit and how long all
// of them were used up at once.

import type { ISubscriptionAccount, SubscriptionProvider } from './subscriptionAccounts.js';

/** One JSON sample per line, in the agent host's `globalStorage` folder. */
export const SUBSCRIPTION_USAGE_HISTORY_FILE = 'agent-subscription-usage-history.jsonl';

/** At most one sample per account in this time, unless the account hits or leaves its limit. */
export const SUBSCRIPTION_USAGE_SAMPLE_INTERVAL_MS = 10 * 60 * 1000;

/** How long samples are kept. */
export const SUBSCRIPTION_USAGE_HISTORY_MAX_AGE_MS = 8 * 7 * 24 * 60 * 60 * 1000;

/** One usage window of a sample: its kind, used percent and, when known, its reset (epoch ms). */
export type SubscriptionUsageSampleWindow = readonly [kind: string, usedPercent: number, resetsAt?: number];

/** A usage reading of one account at one moment. Short keys keep the file small. */
export interface ISubscriptionUsageSample {
	/** Epoch milliseconds of the reading. */
	readonly t: number;
	/** Account id. */
	readonly a: string;
	readonly p: SubscriptionProvider;
	readonly w: readonly SubscriptionUsageSampleWindow[];
	/** Set when the account was used up at that moment. */
	readonly l?: 1;
}

/** The sample of an account's current reading, or undefined without one. */
export function toUsageSample(account: ISubscriptionAccount, now: number): ISubscriptionUsageSample | undefined {
	if (!account.usage?.length || account.usageUpdatedAt === undefined) {
		return undefined;
	}
	const limited = account.status === 'limited' || account.usage.some(window => window.usedPercent >= 100);
	return {
		t: Math.min(account.usageUpdatedAt, now),
		a: account.id,
		p: account.provider,
		w: account.usage.map(window => window.resetsAt !== undefined
			? [window.kind, Math.round(window.usedPercent * 10) / 10, window.resetsAt] as const
			: [window.kind, Math.round(window.usedPercent * 10) / 10] as const),
		...(limited ? { l: 1 as const } : {}),
	};
}

/**
 * Whether `next` is worth appending after `last`, the previous sample of the same account: a newer
 * reading at least {@link SUBSCRIPTION_USAGE_SAMPLE_INTERVAL_MS} later, or one where the account hit or
 * left its limit.
 */
export function shouldRecordUsageSample(last: ISubscriptionUsageSample | undefined, next: ISubscriptionUsageSample): boolean {
	if (!last) {
		return true;
	}
	if (next.t <= last.t) {
		return false;
	}
	return !!next.l !== !!last.l || next.t - last.t >= SUBSCRIPTION_USAGE_SAMPLE_INTERVAL_MS;
}

/** The samples younger than {@link SUBSCRIPTION_USAGE_HISTORY_MAX_AGE_MS}. */
export function pruneUsageSamples(samples: readonly ISubscriptionUsageSample[], now: number): ISubscriptionUsageSample[] {
	const cutoff = now - SUBSCRIPTION_USAGE_HISTORY_MAX_AGE_MS;
	return samples.filter(sample => sample.t >= cutoff);
}

export function serializeUsageSample(sample: ISubscriptionUsageSample): string {
	return JSON.stringify(sample);
}

/** Reads the history file, skipping lines that are not samples (such as a line cut off by a crash). */
export function parseUsageHistory(text: string): ISubscriptionUsageSample[] {
	const samples: ISubscriptionUsageSample[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const value: unknown = JSON.parse(line);
			if (isUsageSample(value)) {
				samples.push(value);
			}
		} catch {
			// A partial line.
		}
	}
	return samples;
}

function isUsageSample(value: unknown): value is ISubscriptionUsageSample {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const sample = value as Partial<ISubscriptionUsageSample>;
	return typeof sample.t === 'number' && typeof sample.a === 'string' && (sample.p === 'claude' || sample.p === 'codex')
		&& Array.isArray(sample.w) && sample.w.every(window => Array.isArray(window) && typeof window[0] === 'string' && typeof window[1] === 'number');
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Windows that run at most this long are the short ("5-hour") ones; longer ones are weekly. */
const SHORT_WINDOW_MAX_MS = DAY;

/**
 * How long a usage window runs, from its kind: `five_hour` and `seven_day…` (Claude) or `<minutes>m`
 * (Codex, such as `300m`). Unknown kinds count as five hours.
 */
export function getUsageWindowSpan(kind: string): number {
	const minutes = /^(?<minutes>\d+)m$/.exec(kind)?.groups?.minutes;
	if (minutes) {
		return Number(minutes) * MINUTE;
	}
	return kind.startsWith('seven_day') ? 7 * DAY : 5 * HOUR;
}

/** What a sample says about its account at a later moment. */
interface IUsageState {
	/** Used share (0-100) of the tightest short window. */
	readonly short: number;
	/** Used share (0-100) of the tightest weekly window, if the account has one. */
	readonly weekly: number | undefined;
	/** Whether the account is used up. */
	readonly limited: boolean;
}

/**
 * The state of a sample's account at `time` (at or after the sample): every window keeps its reading
 * until it resets (or, without a known reset, until its span has passed since the sample).
 */
function getUsageStateAt(sample: ISubscriptionUsageSample, time: number): IUsageState {
	let short = 0;
	let weekly: number | undefined;
	let limited = false;
	for (const [kind, used, resetsAt] of sample.w) {
		const span = getUsageWindowSpan(kind);
		const value = time < (resetsAt ?? sample.t + span) ? Math.min(100, Math.max(0, used)) : 0;
		if (span <= SHORT_WINDOW_MAX_MS) {
			short = Math.max(short, value);
		} else {
			weekly = Math.max(weekly ?? 0, value);
		}
		limited ||= value >= 100;
	}
	// A limit without a used-up window (such as a rate-limit error): assume it lasts a five-hour window.
	if (sample.l && !sample.w.some(window => window[1] >= 100) && time < sample.t + 5 * HOUR) {
		limited = true;
	}
	return { short, weekly, limited };
}

/**
 * How often the account of `samples` (sorted by time) hit its limit: every used-up sample counts once
 * unless the account was still used up from the sample before it.
 */
export function countLimitHits(samples: readonly ISubscriptionUsageSample[]): number {
	return getLimitHitTimes(samples).length;
}

function getLimitHitTimes(samples: readonly ISubscriptionUsageSample[]): number[] {
	const hits: number[] = [];
	let previous: ISubscriptionUsageSample | undefined;
	for (const sample of samples) {
		if (getUsageStateAt(sample, sample.t).limited && !(previous && getUsageStateAt(previous, sample.t).limited)) {
			hits.push(sample.t);
		}
		previous = sample;
	}
	return hits;
}

/** The moment an account hit its limit. */
export interface ISubscriptionUsageLimitHit {
	readonly account: string;
	/** Epoch milliseconds. */
	readonly t: number;
}

/** The usage of a pool (or a single account) on one local calendar day. */
export interface ISubscriptionUsageDay {
	/** Local midnight that starts the day (epoch ms). */
	readonly start: number;
	/** Saturday or Sunday. */
	readonly weekend: boolean;
	/** Whether the accounts were used that day: their short windows went up, or one hit its limit. */
	readonly used: boolean;
	/**
	 * How full the pool got that day: the highest share (0-100) of the short (5-hour) limits in use at one
	 * moment, averaged over the accounts (a used-up account counts as 100). Undefined on days without use.
	 */
	readonly peak: number | undefined;
	/** The highest share (0-100) of the weekly limits in use, averaged over the accounts. Undefined on days without use. */
	readonly weekly: number | undefined;
	/** Every time an account hit its limit that day. */
	readonly limitHits: readonly ISubscriptionUsageLimitHit[];
	/** How long every account of the pool was used up at once that day. */
	readonly allUsedUpMs: number;
}

/** The usage of a pool over the past days, and when in the week it is used. */
export interface ISubscriptionUsageHistorySummary {
	/** One entry per local day, oldest first; the last one is today. */
	readonly days: readonly ISubscriptionUsageDay[];
	/** Short-window usage added (in percent points) per local weekday (0 is Monday) and hour (0-23). */
	readonly activity: readonly (readonly number[])[];
}

/** Monday is 0, Sunday 6. */
function getWeekdayIndex(date: Date): number {
	return (date.getDay() + 6) % 7;
}

/**
 * Sums up the usage of the accounts of a pool (their samples sorted by time) over the `dayCount` local
 * days that end with the day of `now`. The pool's state is followed in steps of
 * {@link SUBSCRIPTION_USAGE_SAMPLE_INTERVAL_MS} and at every sample; an account belongs to the pool from
 * its first sample on.
 */
export function summarizeUsageHistory(samplesByAccount: ReadonlyMap<string, readonly ISubscriptionUsageSample[]>, now: number, dayCount: number): ISubscriptionUsageHistorySummary {
	const today = new Date(now);
	const boundaries: number[] = [];
	for (let index = 0; index <= dayCount; index++) {
		boundaries.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - dayCount + 1 + index).getTime());
	}
	const rangeStart = boundaries[0];
	const rangeEnd = Math.min(now, boundaries[dayCount]);
	const dayOf = (time: number) => {
		let index = 0;
		while (index < dayCount - 1 && time >= boundaries[index + 1]) {
			index++;
		}
		return index;
	};

	const used = new Array<boolean>(dayCount).fill(false);
	const limitHits: ISubscriptionUsageLimitHit[][] = boundaries.slice(0, dayCount).map(() => []);
	const activity = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
	const accounts = [...samplesByAccount].map(([account, samples]) => ({ account, samples }));
	const times = new Set<number>();
	for (let time = rangeStart; time < rangeEnd; time += SUBSCRIPTION_USAGE_SAMPLE_INTERVAL_MS) {
		times.add(time);
	}
	for (const { account, samples } of accounts) {
		for (const time of getLimitHitTimes(samples)) {
			if (time >= rangeStart && time < rangeEnd) {
				const day = dayOf(time);
				limitHits[day].push({ account, t: time });
				used[day] = true;
			}
		}
		samples.forEach((sample, index) => {
			if (sample.t < rangeStart || sample.t >= rangeEnd) {
				return;
			}
			times.add(sample.t);
			const previous = samples[index - 1];
			if (!previous) {
				return;
			}
			// The share the short window went up by since the sample before; after a reset it starts from zero.
			const current = getUsageStateAt(sample, sample.t).short;
			const before = getUsageStateAt(previous, sample.t).short;
			const added = current >= before ? current - before : current;
			if (added > 0) {
				const date = new Date(sample.t);
				activity[getWeekdayIndex(date)][date.getHours()] += added;
				used[dayOf(sample.t)] = true;
			}
		});
	}

	const peak = new Array<number | undefined>(dayCount).fill(undefined);
	const weekly = new Array<number | undefined>(dayCount).fill(undefined);
	const allUsedUpMs = new Array<number>(dayCount).fill(0);
	const positions = accounts.map(() => -1);
	const sortedTimes = [...times].sort((a, b) => a - b);
	sortedTimes.forEach((time, timeIndex) => {
		const states: IUsageState[] = [];
		accounts.forEach(({ samples }, accountIndex) => {
			while (positions[accountIndex] + 1 < samples.length && samples[positions[accountIndex] + 1].t <= time) {
				positions[accountIndex]++;
			}
			if (positions[accountIndex] >= 0) {
				states.push(getUsageStateAt(samples[positions[accountIndex]], time));
			}
		});
		if (!states.length) {
			return;
		}
		const day = dayOf(time);
		const fullness = states.reduce((sum, state) => sum + (state.limited ? 100 : state.short), 0) / states.length;
		peak[day] = Math.max(peak[day] ?? 0, fullness);
		const weeklyStates = states.filter(state => state.weekly !== undefined);
		if (weeklyStates.length) {
			weekly[day] = Math.max(weekly[day] ?? 0, weeklyStates.reduce((sum, state) => sum + state.weekly!, 0) / weeklyStates.length);
		}
		if (states.every(state => state.limited)) {
			allUsedUpMs[day] += (sortedTimes[timeIndex + 1] ?? rangeEnd) - time;
		}
	});

	const days = boundaries.slice(0, dayCount).map((start, index): ISubscriptionUsageDay => {
		const weekday = getWeekdayIndex(new Date(start));
		return {
			start,
			weekend: weekday >= 5,
			used: used[index],
			peak: used[index] && peak[index] !== undefined ? Math.round(peak[index]) : undefined,
			weekly: used[index] && weekly[index] !== undefined ? Math.round(weekly[index]) : undefined,
			limitHits: limitHits[index],
			allUsedUpMs: allUsedUpMs[index],
		};
	});
	return { days, activity };
}

/** From this pool fullness (percent) on, a day counts as close to the limit. */
export const SUBSCRIPTION_POOL_TIGHT_PERCENT = 75;

/**
 * Whether a pool has enough accounts, judged from its days:
 * - `notEnough`: every account was used up at once on two days or more;
 * - `tight`: that happened on one day, or the pool got {@link SUBSCRIPTION_POOL_TIGHT_PERCENT}% full on two days or more;
 * - `enough`: otherwise.
 */
export type SubscriptionPoolVerdict = 'enough' | 'tight' | 'notEnough';

export interface ISubscriptionPoolVerdict {
	readonly verdict: SubscriptionPoolVerdict;
	/** Days with use. */
	readonly usedDays: number;
	/** Days on which an account hit its limit. */
	readonly limitDays: number;
	/** Days on which every account was used up at once. */
	readonly usedUpDays: number;
	/** Days on which the pool got at least {@link SUBSCRIPTION_POOL_TIGHT_PERCENT}% full. */
	readonly tightDays: number;
	/** How long every account was used up at once, in total. */
	readonly allUsedUpMs: number;
}

/** The verdict on a pool's days (see {@link SubscriptionPoolVerdict}), or undefined when it was not used. */
export function getPoolVerdict(days: readonly ISubscriptionUsageDay[]): ISubscriptionPoolVerdict | undefined {
	const usedDays = days.filter(day => day.used).length;
	if (!usedDays) {
		return undefined;
	}
	const usedUpDays = days.filter(day => day.allUsedUpMs > 0).length;
	const tightDays = days.filter(day => (day.peak ?? 0) >= SUBSCRIPTION_POOL_TIGHT_PERCENT || day.allUsedUpMs > 0).length;
	return {
		verdict: usedUpDays >= 2 ? 'notEnough' : usedUpDays === 1 || tightDays >= 2 ? 'tight' : 'enough',
		usedDays,
		limitDays: days.filter(day => day.limitHits.length > 0).length,
		usedUpDays,
		tightDays,
		allUsedUpMs: days.reduce((sum, day) => sum + day.allUsedUpMs, 0),
	};
}

/**
 * When a pool is used most, from {@link ISubscriptionUsageHistorySummary.activity}: the weekday (0 is
 * Monday) with the most usage, and the first hour of the two-hour span with the most usage over all
 * days. Undefined without usage.
 */
export function getBusiestUsageTimes(activity: readonly (readonly number[])[]): { readonly weekday: number; readonly hour: number } | undefined {
	const byWeekday = activity.map(hours => hours.reduce((sum, value) => sum + value, 0));
	if (!byWeekday.some(value => value > 0)) {
		return undefined;
	}
	const byHour = Array.from({ length: 24 }, (_, hour) => activity.reduce((sum, hours) => sum + hours[hour], 0));
	let hour = 0;
	for (let candidate = 1; candidate < 23; candidate++) {
		if (byHour[candidate] + byHour[candidate + 1] > byHour[hour] + byHour[hour + 1]) {
			hour = candidate;
		}
	}
	return { weekday: byWeekday.indexOf(Math.max(...byWeekday)), hour };
}
