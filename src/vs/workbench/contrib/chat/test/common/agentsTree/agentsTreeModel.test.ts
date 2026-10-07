/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: tests for building the Agents tree from tool invocations.

import assert from 'assert';
import { constObservable, observableValue } from '../../../../../../base/common/observable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildSubagentNodes, IAgentsTreeSubagentNode } from '../../../common/agentsTree/agentsTreeModel.js';
import { IChatSubagentToolInvocationData, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../common/chatService/chatService.js';
import { ToolDataSource } from '../../../common/tools/languageModelToolsService.js';

/** A tool invocation from a restored chat. */
function serialized(toolCallId: string, options: { subAgentInvocationId?: string; data?: IChatSubagentToolInvocationData; denied?: boolean; resultError?: string } = {}): IChatToolInvocationSerialized {
	return {
		kind: 'toolInvocationSerialized',
		presentation: undefined,
		toolSpecificData: options.data,
		invocationMessage: toolCallId,
		originMessage: undefined,
		pastTenseMessage: undefined,
		resultError: options.resultError,
		isConfirmed: { type: options.denied ? ToolConfirmKind.Denied : ToolConfirmKind.ConfirmationNotNeeded },
		isComplete: true,
		toolCallId,
		toolId: options.data ? 'runSubagent' : 'readFile',
		source: ToolDataSource.Internal,
		subAgentInvocationId: options.subAgentInvocationId,
	};
}

/** A live tool invocation that is executing, or waiting for confirmation. */
function live(toolCallId: string, options: { subAgentInvocationId?: string; data?: IChatSubagentToolInvocationData; waiting?: boolean } = {}): IChatToolInvocation {
	const state: IChatToolInvocation.State = options.waiting
		? { type: IChatToolInvocation.StateKind.WaitingForConfirmation, parameters: {}, confirm: () => { } }
		: { type: IChatToolInvocation.StateKind.Executing, parameters: {}, confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded }, progress: constObservable({ progress: undefined }) };
	const invocation: IChatToolInvocation = {
		kind: 'toolInvocation',
		presentation: undefined,
		toolSpecificData: options.data,
		toolSpecificDataKind: constObservable(options.data?.kind),
		originMessage: undefined,
		invocationMessage: toolCallId,
		pastTenseMessage: undefined,
		source: ToolDataSource.Internal,
		toolId: options.data ? 'runSubagent' : 'readFile',
		toolCallId,
		subAgentInvocationId: options.subAgentInvocationId,
		state: observableValue<IChatToolInvocation.State>('state', state),
		isAttachedToThinking: false,
		toJSON: () => serialized(toolCallId, options),
	};
	return invocation;
}

function subagent(description: string, extra: Partial<IChatSubagentToolInvocationData> = {}): IChatSubagentToolInvocationData {
	return { kind: 'subagent', description, ...extra };
}

/** Reduces nodes to a readable shape for snapshot assertions. */
function summarize(nodes: readonly IAgentsTreeSubagentNode[]): object[] {
	return nodes.map(node => ({
		id: node.id,
		name: node.name,
		description: node.description,
		modelName: node.modelName,
		status: node.status,
		duration: node.duration,
		chatResource: node.chatResource,
		children: summarize(node.children),
	}));
}

suite('AgentsTreeModel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('nests subagents by subAgentInvocationId and derives their status', () => {
		const now = 10_000;
		const invocations = [
			serialized('plain-tool'),
			// A completed root subagent with a nested subagent that failed.
			serialized('explore', { data: subagent('Explore the code', { agentDisplayName: 'Explore', agentName: 'explore', modelName: 'Model A', duration: 1500 }) }),
			serialized('explore-child', { subAgentInvocationId: 'explore', data: subagent('Find tests', { agentName: 'search' }), resultError: 'boom' }),
			serialized('explore-tool', { subAgentInvocationId: 'explore' }),
			// A running root subagent with a nested subagent waiting on a tool confirmation two levels deep.
			live('plan', { data: subagent('Plan the change', { agentName: 'plan', startedAt: 4_000 }) }),
			live('plan-child', { subAgentInvocationId: 'plan', data: subagent('Review the plan', { startedAt: 7_000, chatResource: 'agent-host:/child', isChatAvailable: true }) }),
			live('plan-grandchild', { subAgentInvocationId: 'plan-child', data: subagent('Check style') }),
			live('plan-grandchild-tool', { subAgentInvocationId: 'plan-grandchild', waiting: true }),
			// A denied subagent call and one whose chat is reported unavailable.
			serialized('denied', { data: subagent('Denied work'), denied: true }),
			serialized('unavailable', { data: subagent('Detached work', { chatResource: 'agent-host:/gone', isChatAvailable: false }) }),
			// A subagent whose parent is unknown is shown at the top level.
			serialized('orphan', { subAgentInvocationId: 'missing', data: subagent('Orphan work') }),
		];

		assert.deepStrictEqual(summarize(buildSubagentNodes(invocations, now)), [
			{
				id: 'explore', name: 'Explore', description: 'Explore the code', modelName: 'Model A', status: 'done', duration: 1500, chatResource: undefined, children: [
					{ id: 'explore-child', name: 'search', description: 'Find tests', modelName: undefined, status: 'failed', duration: undefined, chatResource: undefined, children: [] },
				]
			},
			{
				id: 'plan', name: 'plan', description: 'Plan the change', modelName: undefined, status: 'running', duration: 6_000, chatResource: undefined, children: [
					{
						id: 'plan-child', name: undefined, description: 'Review the plan', modelName: undefined, status: 'running', duration: 3_000, chatResource: 'agent-host:/child', children: [
							{ id: 'plan-grandchild', name: undefined, description: 'Check style', modelName: undefined, status: 'waiting', duration: undefined, chatResource: undefined, children: [] },
						]
					},
				]
			},
			{ id: 'denied', name: undefined, description: 'Denied work', modelName: undefined, status: 'cancelled', duration: undefined, chatResource: undefined, children: [] },
			{ id: 'unavailable', name: undefined, description: 'Detached work', modelName: undefined, status: 'done', duration: undefined, chatResource: undefined, children: [] },
			{ id: 'orphan', name: undefined, description: 'Orphan work', modelName: undefined, status: 'done', duration: undefined, chatResource: undefined, children: [] },
		]);
	});
});
