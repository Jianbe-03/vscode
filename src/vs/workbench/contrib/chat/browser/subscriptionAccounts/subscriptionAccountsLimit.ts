/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the chat prompt when a Claude or Codex subscription account is used up. The agent host
// ends the turn with an error carrying `ISubscriptionLimitErrorMeta`; the chat then offers to continue
// on the next account of the pool, or to always switch without asking.

import { localize } from '../../../../../nls.js';
import { ISubscriptionLimitErrorMeta, SUBSCRIPTION_LIMIT_ERROR_META_KEY } from '../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import type { ErrorInfo } from '../../../../../platform/agentHost/common/state/protocol/common/state.js';
import { formatShortDuration, getSubscriptionProviderLabel } from '../../../../services/agentHost/browser/subscriptionAccountsService.js';
import { ChatErrorLevel, IChatResponseErrorDetails, IChatResponseErrorDetailsConfirmationButton } from '../../common/chatService/chatService.js';

export const ADD_CLAUDE_ACCOUNT_COMMAND_ID = 'workbench.action.chat.addClaudeAccount';
export const ADD_CODEX_ACCOUNT_COMMAND_ID = 'workbench.action.chat.addCodexAccount';
export const MANAGE_SUBSCRIPTION_ACCOUNTS_COMMAND_ID = 'workbench.action.chat.manageSubscriptionAccounts';
export const SHOW_SUBSCRIPTION_USAGE_COMMAND_ID = 'workbench.action.chat.showSubscriptionUsage';
/** Moves a chat to another account: `(chat: string, accountId: string, alwaysSwitch: boolean)`. */
export const SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID = 'workbench.action.chat.switchSubscriptionAccount';

/**
 * Confirmation data of the Claude "Continue on ..." buttons. It is also a resume of the failed turn
 * (`agentHostResumeTurn`), so the chat keeps the request and resumes it once the account switched.
 */
export interface ISubscriptionSwitchConfirmationData {
	readonly agentHostResumeTurn: true;
	readonly subscriptionSwitch: {
		readonly accountId: string;
		/** "Always Switch Automatically": also turn on the auto-switch setting. */
		readonly alwaysSwitch: boolean;
	};
}

export function readSubscriptionLimitErrorMeta(error: ErrorInfo | undefined): ISubscriptionLimitErrorMeta | undefined {
	const value = error?._meta?.[SUBSCRIPTION_LIMIT_ERROR_META_KEY];
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const meta = value as Partial<ISubscriptionLimitErrorMeta>;
	if ((meta.provider !== 'claude' && meta.provider !== 'codex') || typeof meta.accountId !== 'string' || typeof meta.accountLabel !== 'string') {
		return undefined;
	}
	return value as ISubscriptionLimitErrorMeta;
}

export function getSubscriptionSwitchData(confirmationData: readonly unknown[] | undefined): ISubscriptionSwitchConfirmationData | undefined {
	for (const data of confirmationData ?? []) {
		const candidate = typeof data === 'object' && data !== null ? data as Partial<ISubscriptionSwitchConfirmationData> : undefined;
		if (candidate?.agentHostResumeTurn === true && typeof candidate.subscriptionSwitch?.accountId === 'string') {
			return candidate as ISubscriptionSwitchConfirmationData;
		}
	}
	return undefined;
}

/**
 * The error shown for a used-up account: with a next account, buttons to continue there (once, or
 * from now on without asking); without one, when the first account frees up and a button to add one.
 * `chat` is the agent host chat URI of the failed turn; without it (a read-only chat) the chat cannot
 * switch, so only the limit is shown.
 *
 * Claude only moves the chat to the account on `switchChat`, so its buttons resume the failed turn
 * afterwards ({@link ISubscriptionSwitchConfirmationData}). Codex starts the continuation turn itself,
 * so its buttons only run {@link SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID}.
 */
export function getSubscriptionLimitErrorDetails(meta: ISubscriptionLimitErrorMeta, now: number, chat: string | undefined): IChatResponseErrorDetails {
	const provider = getSubscriptionProviderLabel(meta.provider);
	if (meta.nextAccountId && meta.nextAccountLabel) {
		const message = meta.reason === 'authentication'
			? localize('subscriptionLimit.refused', "The sign-in of the {0} account {1} was refused.", provider, meta.accountLabel)
			: meta.resetsAt && meta.resetsAt > now
			? localize('subscriptionLimit.usedUpResets', "The {0} account {1} has reached its usage limit; it resets in {2}.", provider, meta.accountLabel, formatShortDuration(meta.resetsAt - now))
			: localize('subscriptionLimit.usedUp', "The {0} account {1} has reached its usage limit.", provider, meta.accountLabel);
		const nextAccountId = meta.nextAccountId;
		const switchButton = (label: string, alwaysSwitch: boolean): IChatResponseErrorDetailsConfirmationButton => meta.provider === 'claude'
			? {
				data: { agentHostResumeTurn: true, subscriptionSwitch: { accountId: nextAccountId, alwaysSwitch } } satisfies ISubscriptionSwitchConfirmationData,
				label,
				resend: true,
				preserveRequestId: true,
			}
			: { data: undefined, label, commandId: SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID, commandArgs: [chat ?? '', nextAccountId, alwaysSwitch] };
		return {
			message,
			isExpectedError: true,
			level: ChatErrorLevel.Warning,
			confirmationButtons: chat ? [
				switchButton(localize('subscriptionLimit.continueOn', "Continue on {0}", meta.nextAccountLabel), false),
				switchButton(localize('subscriptionLimit.alwaysSwitch', "Always Switch Automatically"), true),
			] : undefined,
		};
	}
	const message = meta.reason === 'authentication'
		? localize('subscriptionLimit.refusedNoNext', "The sign-in of the {0} account {1} was refused, and no other account is available.", provider, meta.accountLabel)
		: meta.resetsAt && meta.resetsAt > now
		? localize('subscriptionLimit.allUsedUpResets', "All {0} accounts are used up; the first resets in {1}.", provider, formatShortDuration(meta.resetsAt - now))
		: localize('subscriptionLimit.allUsedUp', "All {0} accounts are used up.", provider);
	return {
		message,
		isExpectedError: true,
		level: ChatErrorLevel.Warning,
		confirmationButtons: [{
			data: undefined,
			label: meta.provider === 'claude' ? localize('subscriptionLimit.addClaude', "Add Claude Account") : localize('subscriptionLimit.addCodex', "Add Codex Account"),
			commandId: meta.provider === 'claude' ? ADD_CLAUDE_ACCOUNT_COMMAND_ID : ADD_CODEX_ACCOUNT_COMMAND_ID,
		}],
	};
}
