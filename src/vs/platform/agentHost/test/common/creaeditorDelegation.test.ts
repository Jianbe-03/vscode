/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DelegationAgentKind, getAgentSessionIdFromStateFile, getDelegationAgentKind, getDelegationAgentProvider, parseDelegationGatewayModel } from '../../common/creaeditorDelegation.js';

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
});
