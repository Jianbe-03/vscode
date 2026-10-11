/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DelegationAgentKind, getAgentSessionIdFromStateFile, getBroughtBackBranchName, getBroughtBackBranchPrefix, getDelegationAgentKind, getDelegationAgentProvider, getDelegationRemoteModelId, parseDelegationGatewayModel, slugifyDelegationName } from '../../common/creaeditorDelegation.js';

suite('CreaEditor Delegation - agents and keys', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds the agent and its own session id of a chat', () => {
		assert.deepStrictEqual({
			kinds: [getDelegationAgentKind('claude', 'x'), getDelegationAgentKind('x', 'agent-host-codex'), getDelegationAgentKind('copilotcli', 'agent-host-copilotcli'), getDelegationAgentKind('local', 'vscode-chat')],
			ids: [
				getAgentSessionIdFromStateFile(DelegationAgentKind.Claude, '/u/.claude/projects/-u-repo/abc-1.jsonl'),
				getAgentSessionIdFromStateFile(DelegationAgentKind.CopilotCli, '/u/.copilot/session-state/037ef3d3-f9d0/events.jsonl'),
				getAgentSessionIdFromStateFile(DelegationAgentKind.CopilotCli, '/u/.copilot/other/x/events.jsonl'),
				getAgentSessionIdFromStateFile(DelegationAgentKind.Codex, '/u/.codex/sessions/2026/10/09/rollout-2026-10-09T10-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl'),
				getAgentSessionIdFromStateFile(DelegationAgentKind.Codex, '/u/.codex/sessions/x.jsonl'),
			],
			providers: [DelegationAgentKind.Claude, DelegationAgentKind.Codex, DelegationAgentKind.CopilotCli, DelegationAgentKind.Transcript].map(getDelegationAgentProvider),
		}, {
			kinds: [DelegationAgentKind.Claude, DelegationAgentKind.Codex, DelegationAgentKind.CopilotCli, DelegationAgentKind.Transcript],
			ids: ['abc-1', '037ef3d3-f9d0', undefined, '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', undefined],
			providers: ['claude', 'codex', 'copilotcli', undefined],
		});
	});

	test('finds the gateway key a chat\'s model runs on', () => {
		const groups = [{ vendor: 'openrouter', name: 'Work' }, { vendor: 'openrouter', name: 'Work/Team' }, { vendor: 'litellm', name: 'Home' }, { vendor: 'anthropic', name: 'Mine' }];
		assert.deepStrictEqual([
			parseDelegationGatewayModel('agent-host-copilotcli:openrouter/Work/anthropic/claude-sonnet-4', groups),
			parseDelegationGatewayModel('openrouter/Work/Team/x/y', groups),
			parseDelegationGatewayModel('litellm/Home/gpt-5', groups),
			parseDelegationGatewayModel('agent-host-copilotcli:anthropic/Mine/claude', groups),
			parseDelegationGatewayModel('agent-host-copilotcli:gpt-5', groups),
			parseDelegationGatewayModel(undefined, groups),
		], [
			{ vendor: 'openrouter', group: 'Work', model: 'anthropic/claude-sonnet-4' },
			{ vendor: 'openrouter', group: 'Work/Team', model: 'x/y' },
			{ vendor: 'litellm', group: 'Home', model: 'gpt-5' },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('maps a chat\'s model to the same model on a server', () => {
		const remote = 'remote-server__1-copilotcli';
		assert.deepStrictEqual([
			getDelegationRemoteModelId('agent-host-copilotcli:litellm/Home key/mock-mini', remote),
			getDelegationRemoteModelId('litellm/Home key/mock-mini', remote),
			getDelegationRemoteModelId('agent-host-claude:claude-sonnet-4', remote),
			getDelegationRemoteModelId('openrouter/Work/vendor/model:free', remote),
			getDelegationRemoteModelId('agent-host-copilotcli:', remote),
			getDelegationRemoteModelId(undefined, remote),
		], [
			'remote-server__1-copilotcli:litellm/Home key/mock-mini',
			'remote-server__1-copilotcli:litellm/Home key/mock-mini',
			'remote-server__1-copilotcli:claude-sonnet-4',
			'remote-server__1-copilotcli:openrouter/Work/vendor/model:free',
			undefined,
			undefined,
		]);
	});

	test('builds refs and folder names from names with spaces', () => {
		assert.deepStrictEqual({
			branch: getBroughtBackBranchName('Office Server', 'ab12cd34'),
			prefix: getBroughtBackBranchPrefix('Office Server'),
			odd: getBroughtBackBranchPrefix('  ..My  Mac (2)!.. '),
			empty: getBroughtBackBranchPrefix('***'),
			slugs: ['ws2', 'My Repo.git', '../..', 'a'.repeat(80)].map(slugifyDelegationName),
		}, {
			branch: 'creaeditor/from-office-server/ab12cd34',
			prefix: 'creaeditor/from-office-server/',
			odd: 'creaeditor/from-my-mac-2/',
			empty: 'creaeditor/from-server/',
			slugs: ['ws2', 'my-repo.git', undefined, 'a'.repeat(60)],
		});
	});
});
