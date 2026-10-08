/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullAgentHostService } from '../../../../../platform/agentHost/browser/nullAgentHostService.js';
import type { AuthenticateParams, AuthenticateResult } from '../../../../../platform/agentHost/common/agent.js';
import { ISubscriptionAccount, SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY, SUBSCRIPTION_ACCOUNTS_META_KEY, SUBSCRIPTION_ACCOUNTS_REQUEST_KEY } from '../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import type { IAgentSubscription } from '../../../../../platform/agentHost/common/state/agentSubscription.js';
import type { RootState } from '../../../../../platform/agentHost/common/state/protocol/state.js';
import { IRootConfigChangedAction } from '../../../../../platform/agentHost/common/state/sessionActions.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { NullOpenerService } from '../../../../../platform/opener/test/common/nullOpenerService.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { formatAccountLine, formatAvailability, formatPoolsStatusText, formatResetsIn, getCliLoginCommand, getPoolSummaries, getSubscriptionAccountSecretKey, SubscriptionAccountsAutoSwitchSettingId, SubscriptionAccountsService } from '../../browser/subscriptionAccountsService.js';

suite('SubscriptionAccountsService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const hour = 60 * 60 * 1000;
	const now = Date.UTC(2026, 9, 8, 12);

	function account(id: string, provider: ISubscriptionAccount['provider'], overrides: Partial<ISubscriptionAccount> = {}): ISubscriptionAccount {
		return { id, provider, label: id, kind: 'login', status: 'signedIn', ...overrides };
	}

	function rootState(accounts: readonly ISubscriptionAccount[], config: Record<string, unknown> = {}): RootState {
		return {
			agents: [],
			config: { schema: { type: 'object', properties: {} }, values: { [SUBSCRIPTION_ACCOUNTS_META_KEY]: { accounts }, ...config } },
		} as RootState;
	}

	class TestAgentHost extends NullAgentHostService {
		readonly rootStateEmitter = disposables.add(new Emitter<RootState>());
		readonly startEmitter = disposables.add(new Emitter<void>());
		override readonly onAgentHostStart = this.startEmitter.event;
		readonly dispatched: Record<string, unknown>[] = [];
		readonly authenticated: { resource: string; token: string }[] = [];
		state: RootState | undefined;

		override get rootState(): IAgentSubscription<RootState> {
			return {
				value: this.state,
				verifiedValue: this.state,
				onDidChange: this.rootStateEmitter.event,
				onWillApplyAction: Event.None,
				onDidApplyAction: Event.None,
			};
		}

		override dispatch(_channel: string, action: IRootConfigChangedAction): void {
			this.dispatched.push(action.config);
		}

		override async authenticate(params: AuthenticateParams): Promise<AuthenticateResult> {
			this.authenticated.push({ resource: params.resource, token: params.token });
			return { authenticated: true };
		}

		setState(state: RootState): void {
			this.state = state;
			this.rootStateEmitter.fire(state);
		}
	}

	function createService(agentHost: TestAgentHost, secrets = new TestSecretStorageService(), autoSwitch = false) {
		const configuration = new TestConfigurationService({ [SubscriptionAccountsAutoSwitchSettingId]: autoSwitch });
		return disposables.add(new SubscriptionAccountsService(agentHost, secrets, configuration, NullOpenerService, new NullLogService()));
	}

	/** The requests without their random ids. */
	function requests(agentHost: TestAgentHost): unknown[] {
		return agentHost.dispatched
			.map(config => config[SUBSCRIPTION_ACCOUNTS_REQUEST_KEY] as { id: string } | undefined)
			.filter(request => !!request)
			.map(({ id, ...request }) => request);
	}

	test('writes account requests into the root config', async () => {
		const agentHost = new TestAgentHost();
		const service = createService(agentHost);
		const accountId = await service.add('codex', 'login', 'Work');
		service.rename(accountId, 'Office');
		service.move(accountId, 0);
		service.refreshUsage('codex');
		service.switchChat('ahp-chat://1', accountId);
		await service.remove(accountId);

		assert.deepStrictEqual(requests(agentHost), [
			{ type: 'add', provider: 'codex', kind: 'login', label: 'Work', accountId },
			{ type: 'rename', accountId, label: 'Office' },
			{ type: 'move', accountId, index: 0 },
			{ type: 'refreshUsage', provider: 'codex' },
			{ type: 'switchChat', chat: 'ahp-chat://1', accountId },
			{ type: 'remove', accountId },
		]);
	});

	test('keeps setup-tokens in the secret storage and sends them after add and on every start', async () => {
		const agentHost = new TestAgentHost();
		const secrets = new TestSecretStorageService();
		const service = createService(agentHost, secrets);
		const accountId = await service.add('claude', 'token', 'Work', 'sk-ant-secret');
		await timeout(0);
		const afterAdd = agentHost.authenticated.length;

		// The account showing up in the state does not send the token twice.
		agentHost.setState(rootState([account(accountId, 'claude', { kind: 'token' })]));
		await timeout(0);
		const afterState = agentHost.authenticated.length;

		// A restarted agent host forgot the token: it is sent again once the new state arrives.
		agentHost.startEmitter.fire();
		await timeout(0);
		agentHost.rootStateEmitter.fire(agentHost.state!);
		await timeout(0);

		assert.deepStrictEqual({
			stored: await secrets.get(getSubscriptionAccountSecretKey(accountId)),
			afterAdd,
			afterState,
			authenticated: agentHost.authenticated,
		}, {
			stored: 'sk-ant-secret',
			afterAdd: 1,
			afterState: 1,
			authenticated: [
				{ resource: `creaeditor-subscription-account:${accountId}`, token: 'sk-ant-secret' },
				{ resource: `creaeditor-subscription-account:${accountId}`, token: 'sk-ant-secret' },
			],
		});
	});

	test('clears the setup-token when a token account is removed', async () => {
		const agentHost = new TestAgentHost();
		const secrets = new TestSecretStorageService();
		const service = createService(agentHost, secrets);
		const accountId = await service.add('claude', 'token', 'Work', 'sk-ant-secret');
		agentHost.setState(rootState([account(accountId, 'claude', { kind: 'token' })]));
		await timeout(0);
		await service.remove(accountId);

		assert.deepStrictEqual({
			stored: await secrets.get(getSubscriptionAccountSecretKey(accountId)),
			lastToken: agentHost.authenticated.at(-1)?.token,
		}, { stored: undefined, lastToken: '' });
	});

	test('mirrors the auto-switch setting into the root config once per start', () => {
		const agentHost = new TestAgentHost();
		agentHost.state = rootState([]);
		createService(agentHost, undefined, true);
		// Another window turning it off is left alone until this agent host restarts.
		agentHost.setState(rootState([], { [SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY]: false }));
		agentHost.startEmitter.fire();

		assert.deepStrictEqual(agentHost.dispatched, [
			{ [SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY]: true },
			{ [SUBSCRIPTION_ACCOUNTS_AUTO_SWITCH_KEY]: true },
		]);
	});

	test('reads the accounts from the root state', () => {
		const agentHost = new TestAgentHost();
		const service = createService(agentHost);
		agentHost.setState(rootState([account('claude-default', 'claude', { kind: 'default', label: 'This Computer' })]));
		assert.deepStrictEqual(service.accounts.get().map(candidate => candidate.label), ['This Computer']);
	});

	test('summarizes the pools for display', () => {
		const accounts = [
			account('a', 'claude', { usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: 40, resetsAt: now + 3 * hour }, { kind: 'seven_day', label: 'Weekly', usedPercent: 10 }] }),
			account('b', 'claude', { status: 'limited', limitedUntil: now + 2 * hour }),
			account('c', 'claude', { status: 'signedOut' }),
			account('d', 'codex', { usage: [{ kind: '300m', label: '5-hour', usedPercent: 20 }] }),
		];
		const pools = getPoolSummaries(accounts, now);

		assert.deepStrictEqual({
			pools,
			status: formatPoolsStatusText(pools),
			availability: pools.map(formatAvailability),
			lines: accounts.map(candidate => formatAccountLine(candidate, now)),
			resets: [formatResetsIn(now + 45 * 60 * 1000, now), formatResetsIn(now + 26 * hour, now), formatResetsIn(now - 1, now)],
		}, {
			pools: [
				{ provider: 'claude', remainingPercent: 30, available: 1, total: 2, earliestResetAt: now + 2 * hour },
				{ provider: 'codex', remainingPercent: 80, available: 1, total: 1, earliestResetAt: undefined },
			],
			status: 'Claude 30% · Codex 80%',
			availability: ['1 of 2 accounts available', '1 of 1 account available'],
			lines: [
				'a: 60% left · resets in 3h',
				'b: 0% left · resets in 2h',
				'c: signed out',
				'd: 80% left',
			],
			resets: ['resets in 45m', 'resets in 1d 2h', 'resets now'],
		});
	});

	test('finds the CLI login command in an agent host error', () => {
		assert.deepStrictEqual([
			getCliLoginCommand('Run `CLAUDE_CONFIG_DIR="/tmp/a" claude auth login` in a terminal, then refresh the account.'),
			getCliLoginCommand('Run `codex login` in a terminal.'),
			getCliLoginCommand('Something else went wrong'),
		], [
			'CLAUDE_CONFIG_DIR="/tmp/a" claude auth login',
			'codex login',
			undefined,
		]);
	});
});
