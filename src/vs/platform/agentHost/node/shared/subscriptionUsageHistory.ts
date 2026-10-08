/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: appends the usage readings of the subscription accounts to the history file (see
// `subscriptionUsageHistory.ts` in common) and prunes samples older than eight weeks, on start and
// once a day.

import * as fs from 'fs';
import { dirname } from '../../../../base/common/path.js';
import { ILogService } from '../../../log/common/log.js';
import type { ISubscriptionAccount } from '../../common/meta/subscriptionAccounts.js';
import { ISubscriptionUsageSample, SUBSCRIPTION_USAGE_HISTORY_MAX_AGE_MS, parseUsageHistory, pruneUsageSamples, serializeUsageSample, shouldRecordUsageSample, toUsageSample } from '../../common/meta/subscriptionUsageHistory.js';

/** How often the file is rewritten without the samples that are too old. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class SubscriptionUsageHistory {
	/** The last sample written per account. */
	private readonly _last = new Map<string, ISubscriptionUsageSample>();
	private _write: Promise<void>;
	private _lastPrune = 0;

	constructor(
		private readonly _path: string,
		private readonly _logService: ILogService,
		now = Date.now(),
	) {
		this._write = this._prune(now);
	}

	/**
	 * Appends a sample for every account whose reading changed enough since its last sample. Runs after
	 * the pending writes, so the samples already on disk are known first.
	 */
	record(accounts: readonly ISubscriptionAccount[], now: number): void {
		this._queue(async () => {
			const lines: string[] = [];
			for (const account of accounts) {
				const sample = toUsageSample(account, now);
				if (!sample || !shouldRecordUsageSample(this._last.get(account.id), sample)) {
					continue;
				}
				this._last.set(account.id, sample);
				lines.push(serializeUsageSample(sample));
			}
			if (lines.length) {
				await fs.promises.mkdir(dirname(this._path), { recursive: true });
				await fs.promises.appendFile(this._path, `${lines.join('\n')}\n`, 'utf8');
			}
			if (now - this._lastPrune >= PRUNE_INTERVAL_MS) {
				await this._prune(now);
			}
		});
	}

	/** Resolves once everything recorded so far is on disk. */
	flush(): Promise<void> {
		return this._write;
	}

	private _queue(task: () => Promise<void>): void {
		this._write = this._write.then(task).catch(error => this._logService.warn(`[SubscriptionUsageHistory] Failed to write ${this._path}`, error));
	}

	/** Drops samples older than eight weeks and remembers the last sample per account. */
	private async _prune(now: number): Promise<void> {
		this._lastPrune = now;
		let text: string;
		try {
			text = await fs.promises.readFile(this._path, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this._logService.warn(`[SubscriptionUsageHistory] Failed to read ${this._path}`, error);
			}
			return;
		}
		const samples = parseUsageHistory(text);
		for (const sample of samples) {
			const last = this._last.get(sample.a);
			if (!last || sample.t >= last.t) {
				this._last.set(sample.a, sample);
			}
		}
		const kept = pruneUsageSamples(samples, now);
		if (kept.length === samples.length && samples.length === text.split('\n').filter(line => line.trim()).length) {
			return;
		}
		try {
			const content = kept.map(serializeUsageSample).join('\n');
			// Written next to the file and renamed, so a crash never leaves half a history.
			const temporary = `${this._path}.tmp`;
			await fs.promises.writeFile(temporary, content ? `${content}\n` : '', 'utf8');
			await fs.promises.rename(temporary, this._path);
			this._logService.trace(`[SubscriptionUsageHistory] Pruned ${samples.length - kept.length} samples older than ${SUBSCRIPTION_USAGE_HISTORY_MAX_AGE_MS / 86_400_000} days`);
		} catch (error) {
			this._logService.warn(`[SubscriptionUsageHistory] Failed to prune ${this._path}`, error);
		}
	}
}
