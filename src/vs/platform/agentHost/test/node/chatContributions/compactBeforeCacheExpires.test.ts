/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { AUTO_COMPACT_MESSAGE_META_KEY, ICompactBeforeCacheExpiresConfig, PROMPT_CACHE_USAGE_META_KEY, readCompactBeforeCacheExpiresConfig } from '../../../common/creaeditorCacheCompaction.js';
import { MessageKind, type Message, type UsageInfo } from '../../../common/state/sessionState.js';
import { IdleCompactionScheduler } from '../../../node/chatContributions/compactBeforeCacheExpires/compactBeforeCacheExpiresContribution.js';

suite('CompactBeforeCacheExpires', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const message = (text: string, meta?: Record<string, unknown>): Message => ({ text, origin: { kind: MessageKind.User }, ...(meta ? { _meta: meta } : {}) });
	const usage = (contextTokens: number, ttlSeconds: 300 | 3600 = 300): UsageInfo => ({ inputTokens: 1, _meta: { [PROMPT_CACHE_USAGE_META_KEY]: { contextTokens, ttlSeconds } } });

	function createScheduler() {
		let now = 0;
		const timers: { callback: () => void; at: number; disposed: boolean }[] = [];
		const compacted: string[] = [];
		const busy = new Set<string>();
		let config: ICompactBeforeCacheExpiresConfig = { enabled: true, minTokens: 60_000 };
		const scheduler = store.add(new IdleCompactionScheduler({
			getConfig: () => config,
			canCompact: channel => !busy.has(channel),
			compact: channel => compacted.push(`${channel}@${now / 1000}s`),
			logService: new NullLogService(),
			setTimer: (callback, ms) => {
				const timer = { callback, at: now + ms, disposed: false };
				timers.push(timer);
				return { dispose: () => timer.disposed = true };
			},
		}));
		const advance = (ms: number) => {
			now += ms;
			for (const timer of timers.filter(candidate => !candidate.disposed && candidate.at <= now)) {
				timer.disposed = true;
				timer.callback();
			}
		};
		return { scheduler, compacted, busy, advance, setConfig: (patch: Partial<ICompactBeforeCacheExpiresConfig>) => config = { ...config, ...patch } };
	}

	test('compacts an idle chat shortly before its prompt cache expires, once, and only when it qualifies', () => {
		const { scheduler, compacted, busy, advance, setConfig } = createScheduler();
		const ended = (channel: string, text: string, turnUsage: UsageInfo | undefined, meta?: Record<string, unknown>) => scheduler.onTurnSucceeded('session', channel, 'turn', message(text, meta), turnUsage);

		// 5 minute cache: compacted after 4:15; 1 hour cache: after 57 minutes.
		ended('a', 'fix it', usage(80_000));
		ended('b', 'fix it', usage(80_000, 3600));
		// Too small, no usage (not Claude), a /compact the user sent, and the automatic compaction itself.
		ended('small', 'fix it', usage(59_999));
		ended('noUsage', 'fix it', undefined);
		ended('manual', '/compact keep the plan', usage(80_000));
		ended('automatic', '/compact', usage(80_000), { [AUTO_COMPACT_MESSAGE_META_KEY]: true });
		// A new turn cancels; a busy chat (queued message, approval, locked...) is skipped when the time comes.
		ended('newTurn', 'fix it', usage(80_000));
		scheduler.cancel('newTurn');
		ended('busy', 'fix it', usage(80_000));
		busy.add('busy');
		const scheduled = scheduler.scheduledChannels;
		advance(255_000);
		advance(3_420_000 - 255_000);

		// Turned off: pending compactions do not run.
		ended('off', 'fix it', usage(80_000));
		setConfig({ enabled: false });
		advance(300_000);
		setConfig({ enabled: true });
		// A removed session cancels its chats.
		ended('removed', 'fix it', usage(80_000));
		scheduler.cancelSession('session');

		assert.deepStrictEqual({
			scheduled,
			compacted,
			pending: scheduler.scheduledChannels,
			defaults: readCompactBeforeCacheExpiresConfig(undefined),
			fromSettings: readCompactBeforeCacheExpiresConfig({ 'creaeditor.claude.compactBeforeCacheExpires': false, 'creaeditor.claude.compactBeforeCacheExpiresMinTokens': 100_000 }),
		}, {
			scheduled: ['a', 'b', 'busy'],
			compacted: ['a@255s', 'b@3420s'],
			pending: [],
			defaults: { enabled: true, minTokens: 60_000 },
			fromSettings: { enabled: false, minTokens: 100_000 },
		});
	});
});
