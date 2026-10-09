/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { IAction, SubmenuAction } from '../../../../../../../../base/common/actions.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../../base/test/common/utils.js';
import { ISubscriptionAccount } from '../../../../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { createSubscriptionAccountActions, getModelSubscriptionProvider, getPinnedModelLabel } from '../../../../../browser/widget/input/modelPicker/modelPickerSubscriptionAccounts.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../../common/languageModels.js';

suite('Model picker subscription accounts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const now = Date.UTC(2026, 9, 8, 12);

	function model(targetChatSessionType: string, modelGroup: { id: string; sourceId?: string } | undefined): ILanguageModelChatMetadataAndIdentifier {
		return { identifier: `${targetChatSessionType}:m`, metadata: { name: 'Claude Opus 5.5', targetChatSessionType, modelGroup } } as unknown as ILanguageModelChatMetadataAndIdentifier;
	}

	function account(id: string, overrides: Partial<ISubscriptionAccount> = {}): ISubscriptionAccount {
		return { id, provider: 'claude', label: id, kind: 'login', status: 'signedIn', usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: 40 }], ...overrides };
	}

	test('lists the pool and every account of a pooled model, pins the chat to the chosen one and links to the usage page', () => {
		const pins: (string | undefined)[] = [];
		const commands: string[] = [];
		const accounts = [account('Work'), account('Home', { status: 'limited', usage: [{ kind: 'five_hour', label: '5-hour', usedPercent: 100 }] }), account('Old', { status: 'signedOut', usage: undefined }), account('Codex', { provider: 'codex' })];
		const [group, manage] = createSubscriptionAccountActions(accounts, 'claude', 'Work', now, accountId => pins.push(accountId), commandId => commands.push(commandId)) as SubmenuAction[];
		for (const action of [...group.actions, ...manage.actions]) {
			void action.run();
		}

		assert.deepStrictEqual({
			providers: [
				getModelSubscriptionProvider(model('agent-host-claude', { id: 'anthropic' })),
				getModelSubscriptionProvider(model('agent-host-claude', { id: 'copilot' })),
				getModelSubscriptionProvider(model('agent-host-codex', { id: 'openai', sourceId: 'chatgptSubscription' })),
				getModelSubscriptionProvider(model('agent-host-codex', { id: 'copilot' })),
			],
			title: group.label,
			actions: group.actions.map(action => `${action.label} | ${action.tooltip} | ${action.checked ? 'checked' : ''} | ${action.enabled ? 'enabled' : 'disabled'}`),
			pins,
			manage: manage.actions.map(action => `${action.label} | ${(action as IAction & { selectsParent?: boolean }).selectsParent}`),
			commands,
			oneAccount: createSubscriptionAccountActions([account('Work'), account('Codex', { provider: 'codex' })], 'claude', undefined, now, () => { }, () => { }),
			labels: [
				getPinnedModelLabel('Claude Opus 5.5', accounts, 'claude', 'Work'),
				getPinnedModelLabel('Claude Opus 5.5', accounts, 'claude', undefined),
				getPinnedModelLabel('Claude Opus 5.5', accounts, 'claude', 'Removed'),
			],
		}, {
			providers: ['claude', undefined, 'codex', undefined],
			title: 'Claude Account',
			actions: [
				'Pool (Automatic) | Next free account |  | enabled',
				'Work | 60% left | checked | enabled',
				'Home | 0% left |  | disabled',
				'Old | signed out |  | disabled',
			],
			pins: [undefined, 'Work', 'Home', 'Old'],
			manage: ['Show Subscription Usage | false', 'Add Claude Account | false'],
			commands: ['workbench.action.chat.showSubscriptionUsage', 'workbench.action.chat.addClaudeAccount'],
			oneAccount: undefined,
			labels: ['Claude Opus 5.5 · Work', 'Claude Opus 5.5', 'Claude Opus 5.5'],
		});
	});
});
