/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { readMaxRunningChats, RunningChatsQueue } from '../../../node/chatContributions/runningChatsLimit/runningChatsLimitContribution.js';

suite('RunningChatsLimit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const turn = (turnId: string, turnChannel = `ahp-chat:/${turnId}`) => ({ turnId, turnChannel });

	test('runs up to the limit, queues the rest in order and starts them as others end', () => {
		const queue = new RunningChatsQueue<{ turnId: string; turnChannel: string }>(2);
		const admitted = ['a', 'b', 'c', 'd', 'e'].map(id => queue.admit(turn(id)));
		const readmitted = queue.admit(turn('a'));
		const afterA = queue.ended('a', 'ahp-chat:/a').map(request => request.turnId);
		// Cancelled while waiting: leaves the queue without starting anything.
		const afterCancelE = queue.ended('e', 'ahp-chat:/e').map(request => request.turnId);
		const afterB = queue.ended('b', 'ahp-chat:/b').map(request => request.turnId);
		// A turn end without an id ends every turn of its channel.
		const afterChannel = queue.ended(undefined, 'ahp-chat:/c').map(request => request.turnId);

		assert.deepStrictEqual({
			admitted,
			readmitted,
			afterA,
			afterCancelE,
			afterB,
			afterChannel,
			final: [queue.running, queue.queued.length],
		}, {
			admitted: [true, true, false, false, false],
			readmitted: true,
			afterA: ['c'],
			afterCancelE: [],
			afterB: ['d'],
			afterChannel: [],
			final: [1, 0],
		});
	});

	test('reads the limit from the environment', () => {
		assert.deepStrictEqual([readMaxRunningChats('4'), readMaxRunningChats('0'), readMaxRunningChats('x'), readMaxRunningChats(undefined), readMaxRunningChats('2.5')], [4, undefined, undefined, undefined, undefined]);
	});
});
