/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the accounts of a pooled Claude or Codex model in the model picker. A provider with more
// than one subscription account still has one entry per model; the entry opens a list with
// "Pool (Automatic)" and every account, and choosing an account pins the current chat to it. Below the
// accounts, "Show Subscription Usage" and "Add ... Account" lead to where the accounts are managed.

import { IAction, SubmenuAction, toAction } from '../../../../../../../base/common/actions.js';
import { localize } from '../../../../../../../nls.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID } from '../../../../../../../platform/agentHost/common/agentModelSource.js';
import { CLAUDE_PROVIDER_ANTHROPIC } from '../../../../../../../platform/agentHost/common/claudeProviders.js';
import { ISubscriptionAccount, SubscriptionProvider, getRemainingPercent } from '../../../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { formatAccountState, getSubscriptionProviderLabel } from '../../../../../../services/agentHost/browser/subscriptionAccountsService.js';
import { SessionType } from '../../../../common/chatSessionsService.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../common/languageModels.js';
import { ADD_CLAUDE_ACCOUNT_COMMAND_ID, ADD_CODEX_ACCOUNT_COMMAND_ID, SHOW_SUBSCRIPTION_USAGE_COMMAND_ID } from '../../../subscriptionAccounts/subscriptionAccountsLimit.js';

/**
 * An action of a submenu that only runs itself: choosing it does not also choose the entry the
 * submenu belongs to (see `selectsParent` in the action list).
 */
type ISubmenuOnlyAction = IAction & { readonly selectsParent: false };

/** The subscription a model of the local agent host runs on: Claude or Codex, or none (Copilot, a key). */
export function getModelSubscriptionProvider(model: ILanguageModelChatMetadataAndIdentifier): SubscriptionProvider | undefined {
	const sessionType = model.metadata.targetChatSessionType;
	if (sessionType === SessionType.AgentHostClaude && model.metadata.modelGroup?.id === CLAUDE_PROVIDER_ANTHROPIC) {
		return 'claude';
	}
	if (sessionType === SessionType.AgentHostCodex && model.metadata.modelGroup?.sourceId === CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID) {
		return 'codex';
	}
	return undefined;
}

/** Whether an account can take a chat now: signed in and not used up. */
export function canAccountTakeWork(account: ISubscriptionAccount): boolean {
	return account.status === 'signedIn' && getRemainingPercent(account) !== 0;
}

/**
 * The account list of a pooled model: "Pool (Automatic)" and one entry per account of `provider`
 * (with what is left; disabled when used up or signed out), checked where the chat is pinned, and
 * below them "Show Subscription Usage" and "Add ... Account", which run `onCommand` and leave the
 * model as it is. Undefined when the provider has fewer than two accounts, so a single account needs
 * no list.
 */
export function createSubscriptionAccountActions(
	accounts: readonly ISubscriptionAccount[],
	provider: SubscriptionProvider,
	pinnedAccountId: string | undefined,
	now: number,
	onPin: (accountId: string | undefined) => void,
	onCommand: (commandId: string) => void,
): IAction[] | undefined {
	const own = accounts.filter(account => account.provider === provider);
	if (own.length < 2) {
		return undefined;
	}
	const pinned = own.some(account => account.id === pinnedAccountId) ? pinnedAccountId : undefined;
	const actions: IAction[] = [
		toAction({
			id: 'subscriptionAccount.pool',
			label: localize('modelPicker.subscriptionPool', "Pool (Automatic)"),
			tooltip: localize('modelPicker.subscriptionPoolDescription', "Next free account"),
			checked: pinned === undefined,
			run: () => onPin(undefined),
		}),
		...own.map(account => toAction({
			id: `subscriptionAccount.${account.id}`,
			label: account.label,
			tooltip: formatAccountState(account, now),
			checked: account.id === pinned,
			enabled: canAccountTakeWork(account) || account.id === pinned,
			run: () => onPin(account.id),
		})),
	];
	const commandAction = (id: string, label: string, commandId: string): ISubmenuOnlyAction => ({ ...toAction({ id, label, run: () => onCommand(commandId) }), selectsParent: false });
	const manageActions = [
		commandAction('subscriptionAccounts.showUsage', localize('modelPicker.showSubscriptionUsage', "Show Subscription Usage"), SHOW_SUBSCRIPTION_USAGE_COMMAND_ID),
		provider === 'claude'
			? commandAction('subscriptionAccounts.add', localize('modelPicker.addClaudeAccount', "Add Claude Account"), ADD_CLAUDE_ACCOUNT_COMMAND_ID)
			: commandAction('subscriptionAccounts.add', localize('modelPicker.addCodexAccount', "Add Codex Account"), ADD_CODEX_ACCOUNT_COMMAND_ID),
	];
	return [
		new SubmenuAction('subscriptionAccounts', localize('modelPicker.subscriptionAccounts', "{0} Account", getSubscriptionProviderLabel(provider)), actions),
		new SubmenuAction('subscriptionAccounts.manage', '', manageActions),
	];
}

/** The picker label of a model whose chat is pinned to an account, e.g. "Claude Opus 5.5 · Work". */
export function getPinnedModelLabel(name: string, accounts: readonly ISubscriptionAccount[], provider: SubscriptionProvider | undefined, pinnedAccountId: string | undefined): string {
	const account = provider && pinnedAccountId ? accounts.find(candidate => candidate.provider === provider && candidate.id === pinnedAccountId) : undefined;
	return account ? localize('modelPicker.pinnedAccount', "{0} · {1}", name, account.label) : name;
}
