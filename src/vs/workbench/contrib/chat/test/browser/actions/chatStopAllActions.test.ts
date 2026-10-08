/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { getRunningChats } from '../../../browser/actions/chatStopAllActions.js';
import { ChatSessionStatus } from '../../../common/chatSessionsService.js';

suite('Stop All Chats', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lists every running chat once: loaded chats first, then agent host sessions running elsewhere', () => {
		const model = (resource: string, running: boolean) => ({ sessionResource: URI.parse(resource), requestInProgress: { get: () => running } });
		const session = (resource: string, providerType: string, status: ChatSessionStatus) => ({ resource: URI.parse(resource), providerType, status });
		const running = getRunningChats(
			[model('vscode-chat-session://local/a', true), model('vscode-chat-session://local/b', false), model('agent-host-claude:/c', true)],
			[
				session('agent-host-claude:/c', 'agent-host-claude', ChatSessionStatus.InProgress),
				session('agent-host-codex:/d', 'agent-host-codex', ChatSessionStatus.InProgress),
				session('agent-host-copilotcli:/e', 'agent-host-copilotcli', ChatSessionStatus.NeedsInput),
				session('agent-host-claude:/f', 'agent-host-claude', ChatSessionStatus.Completed),
				session('copilot-cloud-agent:/g', 'copilot-cloud-agent', ChatSessionStatus.InProgress),
			],
		);
		assert.deepStrictEqual(running.map(chat => `${chat.resource.toString()} ${chat.loaded}`), [
			'vscode-chat-session://local/a true',
			'agent-host-claude:/c true',
			'agent-host-codex:/d false',
			'agent-host-copilotcli:/e false',
		]);
	});
});
