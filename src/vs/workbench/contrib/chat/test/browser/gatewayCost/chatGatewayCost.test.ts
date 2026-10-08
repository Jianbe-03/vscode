/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../../base/common/async.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { runWithFakedTimers } from '../../../../../../base/test/common/timeTravelScheduler.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { ChatGatewayCostService, getChatCostId, IChatGatewayCost } from '../../../browser/gatewayCost/chatGatewayCost.js';
import { LocalChatSessionUri } from '../../../common/model/chatUri.js';

suite('ChatGatewayCostService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function cost(value: number): IChatGatewayCost {
		return { cost: value, requests: 1, costed: 1, promptTokens: 10, completionTokens: 2, cachedTokens: 0 };
	}

	test('maps session resources to the ids of the cost ledger', () => {
		assert.deepStrictEqual([
			getChatCostId(LocalChatSessionUri.forSession('abc')),
			getChatCostId(URI.parse('copilotcli:/session-1')),
		], ['abc', 'copilotcli:/session-1']);
	});

	test('reads the cost of the chats it shows, in one request, and again when they changed', () => runWithFakedTimers({}, async () => {
		const calls: string[][] = [];
		const costs: Record<string, IChatGatewayCost> = { a: cost(0.5) };
		const commandService = new class extends mock<ICommandService>() {
			override async executeCommand<R>(_id: string, chatIds: string[]): Promise<R> {
				calls.push(chatIds);
				return Object.fromEntries(chatIds.filter(chatId => costs[chatId]).map(chatId => [chatId, costs[chatId]])) as R;
			}
		};
		const service = store.add(new ChatGatewayCostService(commandService));
		const a = service.getCost(LocalChatSessionUri.forSession('a'));
		const b = service.getCost(LocalChatSessionUri.forSession('b'));
		await timeout(200);
		const first = [a.get()?.cost, b.get()?.cost];

		costs.a = cost(0.75);
		costs.b = cost(0.1);
		service.invalidate(['a', 'unknown']);
		await timeout(200);
		const second = [a.get()?.cost, b.get()?.cost];

		service.invalidate(undefined);
		await timeout(200);

		assert.deepStrictEqual({ calls, first, second, third: [a.get()?.cost, b.get()?.cost] }, {
			calls: [['a', 'b'], ['a'], ['a', 'b']],
			first: [0.5, undefined],
			second: [0.75, undefined],
			third: [0.75, 0.1],
		});
	}));
});
