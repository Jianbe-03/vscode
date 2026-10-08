/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { MarkdownString } from '../../../../../../base/common/htmlContent.js';
import { buildSubagentChatUri } from '../../../../../../platform/agentHost/common/state/sessionState.js';
import { AHP_SESSION_NOT_FOUND, ProtocolError } from '../../../../../../platform/agentHost/common/state/sessionProtocol.js';
import { sessionLoadFailureHistory, unwrapSessionLoadErrorMessage } from '../../../browser/agentSessions/agentHost/agentHostSessionHandler.js';

suite('unwrapSessionLoadErrorMessage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips the restore wrapper and preserves the underlying cause', () => {
		const actual = {
			// The typical wrapped error: the session URI has a colon-slash, so the
			// wrapper prefix is stripped up to the real (colon-space) separator.
			wrapped: unwrapSessionLoadErrorMessage(new Error(`Failed to restore session copilotcli:/abc-123: This session couldn't be loaded because its worktree is missing and could not be recreated: git worktree exited with code 128: use 'add -f'`)),
			// No wrapper: message passes through unchanged.
			unwrapped: unwrapSessionLoadErrorMessage(new Error('Some other failure')),
			string: unwrapSessionLoadErrorMessage('plain string error'),
			nonError: unwrapSessionLoadErrorMessage(undefined),
		};
		assert.deepStrictEqual(actual, {
			wrapped: `This session couldn't be loaded because its worktree is missing and could not be recreated: git worktree exited with code 128: use 'add -f'`,
			unwrapped: 'Some other failure',
			string: 'plain string error',
			nonError: undefined,
		});
	});
});

suite('sessionLoadFailureHistory', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('shows a calm notice for a restored subagent chat the host no longer has, and the error otherwise', () => {
		const subagentChat = buildSubagentChatUri('copilotcli:/abc-123', 'call_1');
		const notFound = new ProtocolError(AHP_SESSION_NOT_FOUND, `Resource not found: ${subagentChat}`);
		const actual = {
			subagentChat: sessionLoadFailureHistory(notFound, subagentChat, 'subagent/call_1', 'agent'),
			subagentFragmentOnly: sessionLoadFailureHistory(notFound, undefined, 'subagent/call_1', 'agent')[0],
			subagentOtherError: sessionLoadFailureHistory(new Error('Connection closed'), subagentChat, 'subagent/call_1', 'agent')[1],
			mainChat: sessionLoadFailureHistory(notFound, undefined, '', 'agent')[0],
		};
		assert.deepStrictEqual(actual, {
			subagentChat: [
				{ type: 'request', prompt: '', participant: 'agent', isSystemInitiated: true, systemInitiatedLabel: 'Subagent chat unavailable' },
				{ type: 'response', participant: 'agent', parts: [{ kind: 'markdownContent', content: new MarkdownString('This subagent chat is no longer available.') }] },
			],
			subagentFragmentOnly: { type: 'request', prompt: '', participant: 'agent', isSystemInitiated: true, systemInitiatedLabel: 'Subagent chat unavailable' },
			subagentOtherError: { type: 'response', parts: [], participant: 'agent', errorDetails: { message: 'Connection closed' } },
			mainChat: { type: 'request', prompt: '', participant: 'agent', isSystemInitiated: true, systemInitiatedLabel: `Couldn't open session` },
		});
	});
});
