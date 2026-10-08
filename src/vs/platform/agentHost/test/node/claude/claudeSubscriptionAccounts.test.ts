/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { AgentSignal } from '../../../common/agent.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { createErrorResponsePart } from '../../../common/state/sessionState.js';
import { claudeAccountEnv, ClaudeSubscriptionLimitTracker, claudeUsageWindows, getClaudeLimitSignal, selectClaudeAccount, type ClaudeLimitDecision, type IClaudeAccountState } from '../../../node/claude/claudeSubscriptionAccounts.js';

suite('claudeSubscriptionAccounts', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const chat = URI.parse('ahp-chat:/session/chat');

	function rateLimitEvent(status: 'allowed' | 'rejected', resetsAt?: number): SDKMessage {
		return { type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', utilization: 0.5, ...(resetsAt !== undefined ? { resetsAt } : {}) }, uuid: '00000000-0000-0000-0000-000000000001', session_id: 's' };
	}

	function turnEnd(turnId: string): AgentSignal[] {
		return [
			{ kind: 'action', resource: chat, action: { type: ActionType.ChatError, turnId, duration: 1, part: createErrorResponsePart({ errorType: 'success', message: 'Claude AI usage limit reached' }) } },
			{ kind: 'action', resource: chat, action: { type: ActionType.ChatTurnComplete, turnId, duration: 1 } },
		];
	}

	test('selects the chat\'s account while available, else the first signed-in account that is not used up', () => {
		const now = 1_000;
		const accounts: IClaudeAccountState[] = [
			{ id: 'default', label: 'This Computer', kind: 'default', status: 'signedIn', limitedUntil: 5_000 },
			{ id: 'out', label: 'Out', kind: 'token', status: 'signedOut' },
			{ id: 'work', label: 'Work', kind: 'token', status: 'signedIn' },
			{ id: 'home', label: 'Home', kind: 'login', status: 'signedIn', limitedUntil: 500 },
		];
		assert.deepStrictEqual({
			first: selectClaudeAccount(accounts, now)?.id,
			keepsCurrent: selectClaudeAccount(accounts, now, 'home')?.id,
			skipsLimitedCurrent: selectClaudeAccount(accounts, now, 'default')?.id,
			excludes: selectClaudeAccount(accounts, now, undefined, 'work')?.id,
			afterReset: selectClaudeAccount(accounts, 6_000)?.id,
			none: selectClaudeAccount(accounts.slice(0, 2), now)?.id,
		}, {
			first: 'work',
			keepsCurrent: 'home',
			skipsLimitedCurrent: 'work',
			excludes: 'home',
			afterReset: 'default',
			none: undefined,
		});
	});

	test('builds the subprocess environment per account kind', () => {
		assert.deepStrictEqual({
			default: claudeAccountEnv('default', {}),
			token: claudeAccountEnv('token', { token: 'sk-ant-oat-test' }),
			login: claudeAccountEnv('login', { configDir: '/home/u/.creaeditor/claude-accounts/a' }),
		}, {
			default: {},
			token: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test', ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
			login: { CLAUDE_CONFIG_DIR: '/home/u/.creaeditor/claude-accounts/a', CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined },
		});
	});

	test('maps usage windows and limit signals', () => {
		assert.deepStrictEqual({
			windows: claudeUsageWindows({
				five_hour: { utilization: 42, resets_at: '2026-10-08T12:00:00Z' },
				seven_day: { utilization: 100, resets_at: null },
				seven_day_opus: null,
				seven_day_sonnet: { utilization: null, resets_at: null },
			}),
			rejected: getClaudeLimitSignal(rateLimitEvent('rejected', 1_800_000_000)),
			allowed: getClaudeLimitSignal(rateLimitEvent('allowed')),
			assistantError: getClaudeLimitSignal({ type: 'assistant', message: {} as never, parent_tool_use_id: null, error: 'rate_limit', uuid: '00000000-0000-0000-0000-000000000002', session_id: 's' }),
		}, {
			windows: [
				{ kind: 'five_hour', label: '5-hour', usedPercent: 42, resetsAt: Date.parse('2026-10-08T12:00:00Z') },
				{ kind: 'seven_day', label: 'Weekly', usedPercent: 100 },
			],
			rejected: { resetsAt: 1_800_000_000_000, rateLimitType: 'five_hour' },
			allowed: undefined,
			assistantError: {},
		});
	});

	test('a limit without auto switch ends the turn with a resumable error carrying the limit meta', () => {
		const usage: unknown[] = [];
		const meta = { provider: 'claude' as const, accountId: 'work', accountLabel: 'Work', resetsAt: 1_800_000_000_000, nextAccountId: 'home', nextAccountLabel: 'Home' };
		const tracker = new ClaudeSubscriptionLimitTracker(() => ({ kind: 'error', meta }), info => usage.push(info.status));
		tracker.observe(rateLimitEvent('rejected', 1_800_000_000), 'turn-1');
		const out = turnEnd('turn-1').flatMap(signal => tracker.filter(signal));
		assert.deepStrictEqual({
			usage,
			out: out.map(signal => signal.kind === 'action' && signal.action.type === ActionType.ChatError ? { type: 'error', resumable: signal.action.part.resumable, meta: signal.action.part.error._meta } : signal.kind === 'action' ? signal.action.type : signal.kind),
			retry: tracker.takeRetry('turn-1'),
		}, {
			usage: ['rejected'],
			out: [{ type: 'error', resumable: true, meta: { 'creaeditor.subscriptionLimit': meta } }],
			retry: undefined,
		});
	});

	test('a limit with auto switch holds the turn\'s end back for the retry; other turns pass through', () => {
		const decision: ClaudeLimitDecision = { kind: 'retry', fromAccountLabel: 'Work', toAccountLabel: 'Home' };
		const tracker = new ClaudeSubscriptionLimitTracker(() => decision, () => { });
		tracker.observe({ type: 'assistant', message: {} as never, parent_tool_use_id: null, error: 'rate_limit', uuid: '00000000-0000-0000-0000-000000000003', session_id: 's' }, 'turn-1');
		assert.deepStrictEqual({
			limited: turnEnd('turn-1').flatMap(signal => tracker.filter(signal)).length,
			other: turnEnd('turn-2').flatMap(signal => tracker.filter(signal)).length,
			retry: tracker.takeRetry('turn-1'),
			retryAgain: tracker.takeRetry('turn-1'),
		}, {
			limited: 0,
			other: 2,
			retry: decision,
			retryAgain: undefined,
		});
	});
});
