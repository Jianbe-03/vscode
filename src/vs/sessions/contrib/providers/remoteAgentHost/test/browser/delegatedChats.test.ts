/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { DelegationChatState, DelegationResultsMode, IDelegationWorktreeInfo } from '../../../../../../platform/agentHost/common/creaeditorDelegation.js';
import { describeServerWorktree, parseDelegatedChats, titleFromFirstMessage } from '../../browser/delegatedChats.js';

suite('Delegated chats', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const DAY = 24 * 60 * 60 * 1000;
	const now = Date.now();
	const base: IDelegationWorktreeInfo = { delegationId: 'd1', shortId: '3f9a2c1d', title: 'Fix the login bug', sourceName: 'MacBook', createdAt: now - 20 * DAY, worktree: '/data/worktrees/app-3f9a2c1d', branch: 'creaeditor/delegated/3f9a2c1d', bytes: 25 * 1024 * 1024, chatState: DelegationChatState.Running, workSafe: false };

	test('describes worktrees for Clean Up Server...', () => {
		const removeAfter = now + 2 * DAY;
		assert.deepStrictEqual([
			describeServerWorktree(base, now),
			describeServerWorktree({ ...base, chatState: DelegationChatState.Archived, workSafe: true, broughtBackAt: now - 3 * DAY, removeAfter, bytes: 512 * 1024 }, now),
			describeServerWorktree({ ...base, chatState: DelegationChatState.Deleted, workSafe: true, pullRequestUrl: 'https://github.com/o/r/pull/1', removeAfter: now - 1 }, now),
			describeServerWorktree({ ...base, chatState: DelegationChatState.Unknown, workSafe: true, bytes: undefined }, now).description,
		], [
			{ label: 'Fix the login bug', description: '25 MB · chat in use', detail: 'app-3f9a2c1d · from MacBook · work NOT brought back · kept until removed by hand' },
			{ label: 'Fix the login bug', description: '0.5 MB · chat archived', detail: `app-3f9a2c1d · from MacBook · work brought back 3 days ago · the server removes it on ${new Date(removeAfter).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` },
			{ label: 'Fix the login bug', description: '25 MB · no chat on the server', detail: 'app-3f9a2c1d · from MacBook · work is in its pull request · the server removes it at its next cleanup' },
			'chat state unknown',
		]);
	});

	test('a chat started on the server: its title, and its entry without a local chat', () => {
		const entry = { delegationId: 'd2', shortId: 'abcd1234', serverId: 's1', serverName: 'Office Server', title: 'Add a dark mode', folder: '/Users/me/app', baseCommit: 'a'.repeat(40), branch: 'creaeditor/delegated/abcd1234', resultsMode: DelegationResultsMode.BringBack, createdAt: now, startedOnServer: true };
		assert.deepStrictEqual({
			titles: [titleFromFirstMessage('\n  Add a dark mode  \nwith a toggle'), titleFromFirstMessage('x'.repeat(100)).length, titleFromFirstMessage('   ')],
			parsed: parseDelegatedChats(JSON.stringify([entry])),
		}, {
			titles: ['Add a dark mode', 80, ''],
			parsed: [entry],
		});
	});
});
