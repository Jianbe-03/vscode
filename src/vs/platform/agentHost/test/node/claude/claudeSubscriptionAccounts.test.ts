/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AccountInfo, Query, SDKControlGetUsageResponse, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { INativeEnvironmentService } from '../../../../environment/common/environment.js';
import { NullLogService } from '../../../../log/common/log.js';
import type { AgentSignal } from '../../../common/agent.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { createErrorResponsePart } from '../../../common/state/sessionState.js';
import type { IClaudeAgentSdkService } from '../../../node/claude/claudeAgentSdkService.js';
import { claudeAccountEnv, claudeProbePatch, claudeTokenFingerprint, ClaudeSubscriptionAccounts, ClaudeSubscriptionLimitTracker, claudeUsageWindows, getClaudeLimitSignal, readClaudeProbeOutcome, selectClaudeAccount, type ClaudeLimitDecision, type IClaudeAccountState } from '../../../node/claude/claudeSubscriptionAccounts.js';
import type { ISubscriptionAccountsService, IStoredSubscriptionAccount } from '../../../node/shared/subscriptionAccountsService.js';

suite('claudeSubscriptionAccounts', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

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

	/** What the CLI streams for a turn with an invalid setup-token (captured from the real CLI, trimmed). */
	function rejectedTurn(): SDKMessage[] {
		return [
			{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 519, error_status: 401, error: 'authentication_failed', uuid: '00000000-0000-0000-0000-000000000010', session_id: 's' },
			assistantError('authentication_failed'),
			{ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', duration_ms: 1, duration_api_ms: 0, num_turns: 1, stop_reason: 'stop_sequence', total_cost_usd: 0, usage: {} as never, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-0000-0000-000000000011', session_id: 's' },
		];
	}

	function assistantError(error: 'authentication_failed' | 'rate_limit'): SDKMessage {
		return { type: 'assistant', message: {} as never, parent_tool_use_id: null, error, uuid: '00000000-0000-0000-0000-000000000012', session_id: 's' };
	}

	function okResult(): SDKMessage {
		return { type: 'result', subtype: 'success', is_error: false, result: 'OK', duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: {} as never, modelUsage: {}, permission_denials: [], uuid: '00000000-0000-0000-0000-000000000013', session_id: 's' };
	}

	test('reads the outcome of a setup-token check turn', () => {
		const account: IClaudeAccountState = { id: 'work', label: 'Work', kind: 'token', status: 'signedOut', unverified: true };
		const rejected = readClaudeProbeOutcome(rejectedTurn(), new Error('Claude Code returned an error result'));
		const limited = readClaudeProbeOutcome([rateLimitEvent('rejected', 1_800_000_000), assistantError('rate_limit')]);
		const ok = readClaudeProbeOutcome([rateLimitEvent('allowed', 1_800_000_000), okResult()]);
		assert.deepStrictEqual({
			rejected: { kind: rejected.kind, patch: claudeProbePatch(account, rejected, 1_000) },
			limited: { kind: limited.kind, patch: claudeProbePatch(account, limited, 1_000) },
			ok: { kind: ok.kind, patch: claudeProbePatch(account, ok, 1_000) },
			failed: readClaudeProbeOutcome([], new Error('spawn ENOENT')),
		}, {
			rejected: {
				kind: 'rejected',
				patch: { status: 'error', unverified: true, error: 'Anthropic refused this setup-token. Create a new one with `claude setup-token` and add the account again.', usage: undefined, usageUpdatedAt: undefined, limitedUntil: undefined },
			},
			limited: {
				kind: 'limited',
				patch: { status: 'signedIn', unverified: false, error: undefined, usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: 100, resetsAt: 1_800_000_000_000 }], usageUpdatedAt: 1_000, limitedUntil: 1_800_000_000_000 },
			},
			ok: {
				kind: 'ok',
				patch: { status: 'signedIn', unverified: false, error: undefined, usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: 50, resetsAt: 1_800_000_000_000 }], usageUpdatedAt: 1_000 },
			},
			failed: { kind: 'failed', error: 'spawn ENOENT' },
		});
	});

	test('an unverified token account is only a last resort', () => {
		const accounts: IClaudeAccountState[] = [
			{ id: 'new', label: 'New', kind: 'token', status: 'signedIn', unverified: true },
			{ id: 'work', label: 'Work', kind: 'token', status: 'signedIn' },
		];
		assert.deepStrictEqual({
			skipsUnverified: selectClaudeAccount(accounts, 0)?.id,
			leavesUnverifiedCurrent: selectClaudeAccount(accounts, 0, 'new')?.id,
			none: selectClaudeAccount(accounts.slice(0, 1), 0)?.id,
		}, {
			skipsUnverified: 'work',
			leavesUnverifiedCurrent: 'work',
			none: undefined,
		});
	});

	suite('ClaudeSubscriptionAccounts', () => {

		/** A query that answers the account read, or streams `probe` for the check turn. */
		function fakeQuery(prompt: string | AsyncIterable<SDKUserMessage>, probe: readonly SDKMessage[]): Query {
			const usage: SDKControlGetUsageResponse = { subscription_type: null, rate_limits_available: false, rate_limits: null } as SDKControlGetUsageResponse;
			const info: AccountInfo = { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' };
			const messages = typeof prompt === 'string' ? probe : [];
			const query: Partial<Query> = {
				accountInfo: async () => info,
				usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => usage,
				close: () => { },
				[Symbol.asyncIterator]: async function* () {
					yield* messages;
				},
			};
			return query as Query;
		}

		function createAccounts(stored: readonly IStoredSubscriptionAccount[], probe: (token: string) => readonly SDKMessage[]): { accounts: ClaudeSubscriptionAccounts; probes: string[]; persisted: (readonly IStoredSubscriptionAccount[])[] } {
			const probes: string[] = [];
			const persisted: (readonly IStoredSubscriptionAccount[])[] = [];
			const sdk: Partial<IClaudeAgentSdkService> = {
				canLoadWithoutDownload: async () => true,
				query: async ({ prompt, options }) => {
					const token = options?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? '';
					if (typeof prompt === 'string') {
						probes.push(token);
					}
					return fakeQuery(prompt, probe(token));
				},
			};
			const accountsService: Partial<ISubscriptionAccountsService> = {
				onDidChangeStoredAccounts: Event.None,
				registerProvider: () => Disposable.None,
				getStoredAccounts: () => stored,
				setStoredAccounts: (_provider, accounts) => { persisted.push(accounts); },
				isAutoSwitchEnabled: () => false,
			};
			const environment: Partial<INativeEnvironmentService> = { userHome: URI.file('/home/u') };
			const accounts = store.add(new ClaudeSubscriptionAccounts(
				{ switchChat: async () => { }, refreshModels: () => { } },
				accountsService as ISubscriptionAccountsService,
				sdk as IClaudeAgentSdkService,
				environment as INativeEnvironmentService,
				new NullLogService(),
			));
			return { accounts, probes, persisted };
		}

		const stored: IStoredSubscriptionAccount[] = [{ id: 'bad', label: 'Bad', kind: 'token' }, { id: 'good', label: 'Good', kind: 'token' }];
		const goodTurn = [rateLimitEvent('allowed', 1_800_000_000), okResult()];

		function summary(accounts: ClaudeSubscriptionAccounts) {
			return accounts.getAccounts().map(account => ({ id: account.id, status: account.status, usage: account.usage?.map(window => window.usedPercent), error: account.error !== undefined }));
		}

		test('a new token runs the check turn: a refused token is an error, an accepted one gets its usage; the periodic refresh does not check', async () => {
			const { accounts, probes } = createAccounts(stored, token => token === 'bad-token' ? rejectedTurn() : goodTurn);
			accounts.setToken('bad', 'bad-token');
			accounts.setToken('good', 'good-token');
			await accounts.refreshUsage({ explicit: true });
			const afterCheck = summary(accounts);
			const probeCount = probes.length;
			await accounts.refreshUsage();
			assert.deepStrictEqual({
				afterCheck,
				afterPeriodic: summary(accounts),
				probes: probes.slice(0, probeCount).sort(),
				periodicProbes: probes.length - probeCount,
				chat: accounts.credentialForChat('chat')?.id,
			}, {
				afterCheck: [
					{ id: 'bad', status: 'error', usage: undefined, error: true },
					{ id: 'good', status: 'signedIn', usage: [50], error: false },
				],
				afterPeriodic: [
					{ id: 'bad', status: 'error', usage: undefined, error: true },
					{ id: 'good', status: 'signedIn', usage: [50], error: false },
				],
				probes: ['bad-token', 'good-token'],
				periodicProbes: 0,
				chat: 'good',
			});
		});

		test('five work accounts are all used, and at most two are read at the same time', async () => {
			const work: IStoredSubscriptionAccount[] = [1, 2, 3, 4, 5].map(n => ({ id: `work-${n}`, label: `Work ${n}`, kind: 'token' }));
			let running = 0;
			let mostAtOnce = 0;
			const sdk: Partial<IClaudeAgentSdkService> = {
				canLoadWithoutDownload: async () => true,
				query: async ({ prompt }) => {
					running++;
					mostAtOnce = Math.max(mostAtOnce, running);
					const query = fakeQuery(prompt, goodTurn);
					const accountInfo = query.accountInfo;
					return { ...query, accountInfo: async () => { await timeout(5); return accountInfo(); }, close: () => { running--; } } as Query;
				},
			};
			const accountsService: Partial<ISubscriptionAccountsService> = {
				onDidChangeStoredAccounts: Event.None,
				registerProvider: () => Disposable.None,
				getStoredAccounts: () => work,
				setStoredAccounts: () => { },
				isAutoSwitchEnabled: () => false,
			};
			const accounts = store.add(new ClaudeSubscriptionAccounts(
				{ switchChat: async () => { }, refreshModels: () => { } },
				accountsService as ISubscriptionAccountsService,
				sdk as IClaudeAgentSdkService,
				{ userHome: URI.file('/home/u') } as INativeEnvironmentService,
				new NullLogService(),
			));
			for (const account of work) {
				accounts.setToken(account.id, `${account.id}-token`);
			}
			await accounts.refreshUsage({ explicit: true });
			assert.deepStrictEqual({
				accounts: accounts.getAccounts().map(account => ({ id: account.id, status: account.status })),
				mostAtOnce,
			}, {
				accounts: work.map(account => ({ id: account.id, status: 'signedIn' })),
				mostAtOnce: 2,
			});
		});

		test('a refused sign-in during a chat marks the account error, offers the next account and checks the token again', async () => {
			let revoked = false;
			const { accounts, probes, persisted } = createAccounts(stored, token => token === 'revoked-token' && revoked ? rejectedTurn() : goodTurn);
			accounts.setToken('bad', 'revoked-token');
			accounts.setToken('good', 'good-token');
			await accounts.refreshUsage({ explicit: true });
			const checkedOnAdd = probes.length;
			revoked = true;
			const decision = accounts.handleLimit('chat', 'bad', getClaudeLimitSignal(assistantError('authentication_failed'))!);
			const afterRefusal = summary(accounts);
			await accounts.refreshUsage();
			assert.deepStrictEqual({
				decision,
				afterRefusal,
				afterCheck: summary(accounts),
				checkedOnAdd,
				checkedAfterRefusal: probes.slice(checkedOnAdd),
				verified: persisted.at(-1)?.map(account => [account.id, account.verifiedToken !== undefined]),
			}, {
				decision: { kind: 'error', meta: { provider: 'claude', accountId: 'bad', accountLabel: 'Bad', nextAccountId: 'good', nextAccountLabel: 'Good', reason: 'authentication' } },
				afterRefusal: [
					{ id: 'bad', status: 'error', usage: undefined, error: true },
					{ id: 'good', status: 'signedIn', usage: [50], error: false },
				],
				afterCheck: [
					{ id: 'bad', status: 'error', usage: undefined, error: true },
					{ id: 'good', status: 'signedIn', usage: [50], error: false },
				],
				checkedOnAdd: 2,
				checkedAfterRefusal: ['revoked-token'],
				verified: [['bad', false], ['good', true]],
			});
		});

		test('a token Anthropic accepted before is not checked again on the next start; a replaced one is', async () => {
			const remembered: IStoredSubscriptionAccount[] = [
				{ id: 'bad', label: 'Bad', kind: 'token', verifiedToken: claudeTokenFingerprint('old-token') },
				{ id: 'good', label: 'Good', kind: 'token', verifiedToken: claudeTokenFingerprint('good-token') },
			];
			const { accounts, probes, persisted } = createAccounts(remembered, () => goodTurn);
			accounts.setToken('good', 'good-token');
			accounts.setToken('bad', 'new-token');
			await accounts.refreshUsage({ explicit: true });
			assert.deepStrictEqual({
				accounts: summary(accounts),
				probes,
				persisted: persisted.at(-1),
			}, {
				accounts: [
					{ id: 'bad', status: 'signedIn', usage: [50], error: false },
					{ id: 'good', status: 'signedIn', usage: undefined, error: false },
				],
				probes: ['new-token'],
				// Only fingerprints are stored, never a token.
				persisted: [
					{ id: 'bad', label: 'Bad', kind: 'token', verifiedToken: claudeTokenFingerprint('new-token') },
					{ id: 'good', label: 'Good', kind: 'token', verifiedToken: claudeTokenFingerprint('good-token') },
				],
			});
		});
	});
});
