/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { SUBSCRIPTION_LIMIT_ERROR_META_KEY } from '../../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { ADD_CLAUDE_ACCOUNT_COMMAND_ID, SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID, getSubscriptionLimitErrorDetails, getSubscriptionSwitchData, readSubscriptionLimitErrorMeta } from '../../../browser/subscriptionAccounts/subscriptionAccountsLimit.js';

suite('SubscriptionAccountsLimit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const now = Date.UTC(2026, 9, 8, 12);
	const hour = 60 * 60 * 1000;

	test('offers to continue on the next account', () => {
		const claude = getSubscriptionLimitErrorDetails({ provider: 'claude', accountId: 'a', accountLabel: 'Work', resetsAt: now + 3 * hour, nextAccountId: 'b', nextAccountLabel: 'Personal' }, now, 'ahp-chat://1');
		const codex = getSubscriptionLimitErrorDetails({ provider: 'codex', accountId: 'a', accountLabel: 'Work', nextAccountId: 'b', nextAccountLabel: 'Personal' }, now, 'ahp-chat://1');
		const readOnly = getSubscriptionLimitErrorDetails({ provider: 'codex', accountId: 'a', accountLabel: 'Work', nextAccountId: 'b', nextAccountLabel: 'Personal' }, now, undefined);

		assert.deepStrictEqual({
			claude: { message: claude.message, buttons: claude.confirmationButtons?.map(button => ({ label: button.label, data: button.data, resend: button.resend })) },
			claudeSwitch: getSubscriptionSwitchData(claude.confirmationButtons?.map(button => button.data)),
			codex: { message: codex.message, buttons: codex.confirmationButtons?.map(button => ({ label: button.label, commandId: button.commandId, commandArgs: button.commandArgs })) },
			readOnly: readOnly.confirmationButtons,
		}, {
			claude: {
				message: 'The Claude account Work has reached its usage limit; it resets in 3h.',
				buttons: [
					{ label: 'Continue on Personal', data: { agentHostResumeTurn: true, subscriptionSwitch: { accountId: 'b', alwaysSwitch: false } }, resend: true },
					{ label: 'Always Switch Automatically', data: { agentHostResumeTurn: true, subscriptionSwitch: { accountId: 'b', alwaysSwitch: true } }, resend: true },
				],
			},
			claudeSwitch: { agentHostResumeTurn: true, subscriptionSwitch: { accountId: 'b', alwaysSwitch: false } },
			codex: {
				message: 'The Codex account Work has reached its usage limit.',
				buttons: [
					{ label: 'Continue on Personal', commandId: SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID, commandArgs: ['ahp-chat://1', 'b', false] },
					{ label: 'Always Switch Automatically', commandId: SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID, commandArgs: ['ahp-chat://1', 'b', true] },
				],
			},
			readOnly: undefined,
		});
	});

	test('offers to add an account when every account is used up', () => {
		const error = { errorType: 'limit', message: 'limit', _meta: { [SUBSCRIPTION_LIMIT_ERROR_META_KEY]: { provider: 'claude', accountId: 'a', accountLabel: 'Work', resetsAt: now + 2 * hour } } };
		const meta = readSubscriptionLimitErrorMeta(error);
		const details = meta && getSubscriptionLimitErrorDetails(meta, now, 'ahp-chat://1');

		assert.deepStrictEqual({
			message: details?.message,
			buttons: details?.confirmationButtons?.map(button => ({ label: button.label, commandId: button.commandId })),
			ignoresOtherErrors: readSubscriptionLimitErrorMeta({ errorType: 'x', message: 'x', _meta: { other: true } }),
		}, {
			message: 'All Claude accounts are used up; the first resets in 2h.',
			buttons: [{ label: 'Add Claude Account', commandId: ADD_CLAUDE_ACCOUNT_COMMAND_ID }],
			ignoresOtherErrors: undefined,
		});
	});
});
