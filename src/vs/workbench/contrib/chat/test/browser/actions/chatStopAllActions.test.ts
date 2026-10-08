/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { getRunningChats, getRunningChatsOfOtherWindows, updateRunningChatsOfWindow } from '../../../browser/actions/chatStopAllActions.js';
import { ChatSessionStatus } from '../../../common/chatSessionsService.js';

suite('Stop All Chats', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists every running chat once: loaded chats first, then agent host sessions running elsewhere', () => {
		const model = (resource: string, running: boolean, needsInput = false) => ({ sessionResource: URI.parse(resource), requestInProgress: { get: () => running }, requestNeedsInput: { get: () => needsInput ? { title: 'Confirm' } : undefined } });
		const session = (resource: string, providerType: string, status: ChatSessionStatus, archived = false) => ({ resource: URI.parse(resource), providerType, status, isArchived: () => archived });
		const running = getRunningChats(
			[model('vscode-chat-session://local/a', true), model('vscode-chat-session://local/b', false), model('agent-host-claude:/c', true), model('vscode-chat-session://local/h', false, true)],
			[
				session('agent-host-claude:/c', 'agent-host-claude', ChatSessionStatus.InProgress),
				session('agent-host-codex:/d', 'agent-host-codex', ChatSessionStatus.InProgress),
				session('agent-host-copilotcli:/e', 'agent-host-copilotcli', ChatSessionStatus.NeedsInput),
				session('agent-host-claude:/f', 'agent-host-claude', ChatSessionStatus.Completed),
				session('copilot-cloud-agent:/g', 'copilot-cloud-agent', ChatSessionStatus.InProgress),
				session('vscode-chat-session://local/i', 'local', ChatSessionStatus.InProgress),
				session('agent-host-codex:/j', 'agent-host-codex', ChatSessionStatus.InProgress, true),
			],
		);
		assert.deepStrictEqual(running.map(chat => `${chat.resource.toString()} ${chat.loaded}`), [
			'vscode-chat-session://local/a true',
			'agent-host-claude:/c true',
			'vscode-chat-session://local/h true',
			'agent-host-codex:/d false',
			'agent-host-copilotcli:/e false',
		]);
	});

	test('shares the running chats of each window, leaving out this window and entries that expired', () => {
		let stored = updateRunningChatsOfWindow(undefined, 'w1', ['local/a', 'agent-host-claude:/c'], 1000);
		stored = updateRunningChatsOfWindow(stored, 'w2', ['local/b', 'agent-host-claude:/c'], 2000);
		stored = updateRunningChatsOfWindow(stored, 'w3', ['local/old'], 3000);
		stored = updateRunningChatsOfWindow(stored, 'w3', [], 4000);
		assert.deepStrictEqual({
			seenByW1: getRunningChatsOfOtherWindows(stored, 'w1', 5000),
			seenByW3: getRunningChatsOfOtherWindows(stored, 'w3', 5000),
			seenByW3AfterW1Expired: getRunningChatsOfOtherWindows(stored, 'w3', 1000 + 61_000),
			afterAllStopped: updateRunningChatsOfWindow(updateRunningChatsOfWindow(stored, 'w1', [], 5000), 'w2', [], 5000),
			fromGarbage: getRunningChatsOfOtherWindows('not json', 'w1', 0),
		}, {
			seenByW1: ['local/b', 'agent-host-claude:/c'],
			seenByW3: ['local/a', 'agent-host-claude:/c', 'local/b'],
			seenByW3AfterW1Expired: ['local/b', 'agent-host-claude:/c'],
			afterAllStopped: undefined,
			fromGarbage: [],
		});
	});
});
