/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the usage history of the pooled Claude and Codex subscription accounts. The agent host
// appends one compact sample per account at most every ten minutes (and whenever an account hits or
// leaves its limit) to {@link SUBSCRIPTION_USAGE_HISTORY_FILE} next to `agent-subscription-accounts.json`
// and keeps eight weeks of it. The usage page reads the file to chart the used share per window.

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

/** The highest used percent of a sample's windows. */
export function getSampleUsedPercent(sample: ISubscriptionUsageSample): number {
	return sample.l ? 100 : Math.max(0, ...sample.w.map(window => window[1]));
}

/**
 * How often the account of `samples` (sorted by time) hit its limit: every sample that is used up
 * while the one before it was not counts once.
 */
export function countLimitHits(samples: readonly ISubscriptionUsageSample[]): number {
	let hits = 0;
	let wasLimited = false;
	for (const sample of samples) {
		const limited = getSampleUsedPercent(sample) >= 100;
		if (limited && !wasLimited) {
			hits++;
		}
		wasLimited = limited;
	}
	return hits;
}
