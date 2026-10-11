/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { CREAEDITOR_NOTIFICATION_EVENTS, CreaEditorNotificationEvent, createNtfyRequest, createNtfyTopicUrl, ICreaEditorNotificationsConfig, isNtfyTopicUrl, parseNotificationTarget, readCreaEditorNotificationsConfig } from '../../../common/creaeditorNotifications.js';
import { SessionStatus } from '../../../common/state/sessionState.js';
import { ChatNotifier, NotificationFetch } from '../../../node/shared/chatNotifications.js';

const TARGET = { url: 'http://127.0.0.1:9/creaeditor-test', token: 'fake-token' };

suite('ChatNotifications', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface ISent { readonly url: string; readonly authorization: string | undefined; readonly body: { topic: string; title: string; message: string; priority: number; tags: string[]; click?: string } }

	function createNotifier(overrides: Partial<ICreaEditorNotificationsConfig> = {}, machineName?: string, automaticRuns: ReadonlySet<string> = new Set()) {
		let now = 1_000_000;
		const timers: { callback: () => void; at: number; disposed: boolean }[] = [];
		const sent: ISent[] = [];
		let config: ICreaEditorNotificationsConfig = {
			enabled: true,
			events: new Set<CreaEditorNotificationEvent>(CREAEDITOR_NOTIFICATION_EVENTS),
			onlyWhenAway: true,
			awayMinutes: 5,
			target: TARGET,
			lastActive: undefined,
			webUrl: 'http://100.64.0.2:31600',
			...overrides,
		};
		// Never the network: a fake fetch records the request.
		const fetch: NotificationFetch = async (url, init) => {
			sent.push({ url, authorization: init.headers['Authorization'], body: JSON.parse(init.body) });
			return { status: 200 };
		};
		const notifier = store.add(new ChatNotifier({
			getConfig: () => config,
			getTitle: session => session === 'copilot:/a' ? 'Fix the login page' : undefined,
			fetch,
			machineName,
			isAutomaticRun: session => automaticRuns.has(session),
			logService: new NullLogService(),
			now: () => now,
			settleMs: 4000,
			setTimer: (callback, ms) => {
				const timer = { callback, at: now + ms, disposed: false };
				timers.push(timer);
				return { dispose: () => timer.disposed = true };
			},
		}));
		const advance = async (ms: number) => {
			now += ms;
			for (const timer of timers.filter(candidate => !candidate.disposed && candidate.at <= now)) {
				timer.disposed = true;
				timer.callback();
			}
			await Promise.resolve();
			await Promise.resolve();
		};
		return { notifier, sent, advance, setConfig: (patch: Partial<ICreaEditorNotificationsConfig>) => config = { ...config, ...patch }, now: () => now };
	}

	test('notifies a finished chat, a failed chat and a chat that waits for approval, once each', async () => {
		const { notifier, sent, advance } = createNotifier({}, 'build-box');
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle);
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.InputNeeded);
		await advance(5000);
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle);
		// Reading the chat changes only the read flag: no second notification.
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle | SessionStatus.IsRead);
		await advance(5000);
		notifier.onStatusChanged('copilot:/b', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/b', SessionStatus.Error);
		await advance(5000);

		assert.deepStrictEqual(sent.map(item => [item.body.title, item.body.message, item.body.priority, item.body.topic, item.body.click]), [
			['Fix the login page', 'Waits for your approval or answer on build-box.', 4, 'creaeditor-test', 'http://100.64.0.2:31600'],
			['Fix the login page', 'Finished on build-box.', 3, 'creaeditor-test', 'http://100.64.0.2:31600'],
			['Chat', 'Stopped with an error on build-box.', 3, 'creaeditor-test', 'http://100.64.0.2:31600'],
		]);
		assert.deepStrictEqual([sent[0].url, sent[0].authorization], ['http://127.0.0.1:9/', 'Bearer fake-token']);
	});

	test('CreaEditor: an automatic compaction before the prompt cache expires does not notify', async () => {
		const automaticRuns = new Set<string>(['copilot:/a']);
		const { notifier, sent, advance } = createNotifier({ onlyWhenAway: false }, undefined, automaticRuns);
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle);
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle);
		await advance(5000);
		// The user's next turn notifies again.
		automaticRuns.clear();
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle);
		await advance(5000);
		assert.deepStrictEqual(sent.map(item => item.body.message), ['Finished.']);
	});

	test('debounces: an approval answered at once and a status that does not hold are not notified', async () => {
		const { notifier, sent, advance } = createNotifier();
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.InputNeeded);
		await advance(1000);
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		await advance(5000);
		// A subagent's own status never notifies.
		notifier.onStatusChanged('copilot:/a/subagent/tool-1', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a/subagent/tool-1', SessionStatus.Idle);
		await advance(5000);
		assert.deepStrictEqual(sent.length, 0);
	});

	test('with Only When I\'m Away, stays quiet while a desktop window was active recently', async () => {
		const { notifier, sent, advance, setConfig, now } = createNotifier();
		setConfig({ lastActive: now() - 60_000 });
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle);
		await advance(5000);
		setConfig({ lastActive: now() - 6 * 60_000 });
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle);
		await advance(5000);
		setConfig({ lastActive: now(), onlyWhenAway: false, events: new Set<CreaEditorNotificationEvent>(['failed']) });
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.Idle);
		await advance(5000);
		setConfig({ enabled: false });
		notifier.onStatusChanged('copilot:/a', SessionStatus.InProgress);
		notifier.onStatusChanged('copilot:/a', SessionStatus.Error);
		await advance(5000);
		assert.deepStrictEqual(sent.map(item => item.body.message), ['Finished.']);
	});

	test('reads settings and topics, and builds the ntfy request', () => {
		const config = readCreaEditorNotificationsConfig({
			'creaeditor.notifications.enabled': true,
			'creaeditor.notifications.events': ['needsInput', 'bogus'],
			'creaeditor.notifications.target': { url: 'https://ntfy.example.com/base/creaeditor-1/' },
			'creaeditor.notifications.awayMinutes': -1,
		});
		const request = createNtfyRequest({ url: 'https://ntfy.example.com/base/creaeditor-1' }, { title: 'Ünïcode title', message: 'Finished.', priority: 3, tags: ['x'] });
		const topic = createNtfyTopicUrl('https://ntfy.sh/', bytes => bytes.fill(171));
		assert.deepStrictEqual({
			enabled: config.enabled,
			events: [...config.events],
			onlyWhenAway: config.onlyWhenAway,
			awayMinutes: config.awayMinutes,
			target: config.target,
			request: [request.url, request.headers['Authorization'], JSON.parse(request.body).topic, JSON.parse(request.body).title],
			topic,
			valid: [isNtfyTopicUrl(topic), isNtfyTopicUrl('ftp://ntfy.sh/a'), isNtfyTopicUrl('https://user:pw@ntfy.sh/a'), isNtfyTopicUrl('https://ntfy.sh/')],
			badTarget: parseNotificationTarget({ url: 'https://ntfy.sh/a', token: 5 }),
		}, {
			enabled: true,
			events: ['needsInput'],
			onlyWhenAway: true,
			awayMinutes: 5,
			target: { url: 'https://ntfy.example.com/base/creaeditor-1' },
			request: ['https://ntfy.example.com/base', undefined, 'creaeditor-1', 'Ünïcode title'],
			topic: `https://ntfy.sh/creaeditor-${'ab'.repeat(16)}`,
			valid: [true, false, false, false],
			badTarget: undefined,
		});
	});
});
