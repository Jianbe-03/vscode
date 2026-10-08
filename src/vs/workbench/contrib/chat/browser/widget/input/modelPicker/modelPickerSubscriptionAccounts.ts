/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the accounts of a pooled Claude or Codex model in the model picker. A provider with more
// than one subscription account still has one entry per model; the entry opens a list with
// "Pool (Automatic)" and every account, and choosing an account pins the current chat to it.

import { IAction, SubmenuAction, toAction } from '../../../../../../../base/common/actions.js';
import { localize } from '../../../../../../../nls.js';
import { CHATGPT_SUBSCRIPTION_MODEL_SOURCE_ID } from '../../../../../../../platform/agentHost/common/agentModelSource.js';
import { CLAUDE_PROVIDER_ANTHROPIC } from '../../../../../../../platform/agentHost/common/claudeProviders.js';
import { ISubscriptionAccount, SubscriptionProvider, getRemainingPercent } from '../../../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { formatAccountState, getSubscriptionProviderLabel } from '../../../../../../services/agentHost/browser/subscriptionAccountsService.js';
import { SessionType } from '../../../../common/chatSessionsService.js';
import { ILanguageModelChatMetadataAndIdentifier } from '../../../../common/languageModels.js';

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
 * (with what is left; disabled when used up or signed out), checked where the chat is pinned. Undefined
 * when the provider has fewer than two accounts, so a single account needs no list.
 */
export function createSubscriptionAccountActions(
	accounts: readonly ISubscriptionAccount[],
	provider: SubscriptionProvider,
	pinnedAccountId: string | undefined,
	now: number,
	onPin: (accountId: string | undefined) => void,
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
	return [new SubmenuAction('subscriptionAccounts', localize('modelPicker.subscriptionAccounts', "{0} Account", getSubscriptionProviderLabel(provider)), actions)];
}

/** The picker label of a model whose chat is pinned to an account, e.g. "Claude Opus 5.5 · Work". */
export function getPinnedModelLabel(name: string, accounts: readonly ISubscriptionAccount[], provider: SubscriptionProvider | undefined, pinnedAccountId: string | undefined): string {
	const account = provider && pinnedAccountId ? accounts.find(candidate => candidate.provider === provider && candidate.id === pinnedAccountId) : undefined;
	return account ? localize('modelPicker.pinnedAccount', "{0} · {1}", name, account.label) : name;
}
