/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: tests for classifying what the agents of a chat are doing.

import assert from 'assert';
import { constObservable, observableValue } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { classifyToolActivity, getAgentNameActivity, getChatAgentActivities } from '../../../common/chatPet/chatAgentActivity.js';
import { IChatSubagentToolInvocationData, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../../../common/chatService/chatService.js';
import { ChatModeKind } from '../../../common/constants.js';
import { IChatModel, IChatRequestModel, IChatRequestModeInfo, IChatResponseModel } from '../../../common/model/chatModel.js';
import { ToolDataSource } from '../../../common/tools/languageModelToolsService.js';

interface IToolOptions {
	readonly toolId?: string;
	readonly subAgentInvocationId?: string;
	readonly data?: IChatSubagentToolInvocationData;
	readonly waiting?: boolean;
	readonly resultError?: string;
}

/** A finished tool invocation. */
function done(toolCallId: string, options: IToolOptions = {}): IChatToolInvocationSerialized {
	return {
		kind: 'toolInvocationSerialized',
		presentation: undefined,
		toolSpecificData: options.data,
		invocationMessage: toolCallId,
		originMessage: undefined,
		pastTenseMessage: undefined,
		resultError: options.resultError,
		isConfirmed: { type: ToolConfirmKind.ConfirmationNotNeeded },
		isComplete: true,
		toolCallId,
		toolId: options.toolId ?? (options.data ? 'runSubagent' : 'read_file'),
		source: ToolDataSource.Internal,
		subAgentInvocationId: options.subAgentInvocationId,
	};
}

/** A tool invocation that is executing, or waiting for confirmation. */
function running(toolCallId: string, options: IToolOptions = {}): IChatToolInvocation {
	const state: IChatToolInvocation.State = options.waiting
		? { type: IChatToolInvocation.StateKind.WaitingForConfirmation, parameters: {}, confirm: () => { } }
		: { type: IChatToolInvocation.StateKind.Executing, parameters: {}, confirmed: { type: ToolConfirmKind.ConfirmationNotNeeded }, progress: constObservable({ progress: undefined }) };
	return {
		kind: 'toolInvocation',
		presentation: undefined,
		toolSpecificData: options.data,
		toolSpecificDataKind: constObservable(options.data?.kind),
		originMessage: undefined,
		invocationMessage: toolCallId,
		pastTenseMessage: undefined,
		source: ToolDataSource.Internal,
		toolId: options.toolId ?? (options.data ? 'runSubagent' : 'read_file'),
		toolCallId,
		subAgentInvocationId: options.subAgentInvocationId,
		state: observableValue<IChatToolInvocation.State>('state', state),
		isAttachedToThinking: false,
		toJSON: () => done(toolCallId, options),
	};
}

function subagent(agentName: string | undefined, description: string, extra: Partial<IChatSubagentToolInvocationData> = {}): IChatSubagentToolInvocationData {
	return { kind: 'subagent', agentName, description, ...extra };
}

/** A chat whose last request ran `parts`. */
function chat(resource: string, parts: readonly (IChatToolInvocation | IChatToolInvocationSerialized)[], options: { active?: boolean; needsInput?: boolean; mode?: Partial<IChatRequestModeInfo> } = {}): IChatModel {
	const response = new class extends mock<IChatResponseModel>() {
		override readonly response = new class extends mock<IChatResponseModel['response']>() {
			override readonly value = [...parts];
		}();
	}();
	const request = new class extends mock<IChatRequestModel>() {
		override readonly response = response;
		override readonly modeInfo = options.mode as IChatRequestModeInfo | undefined;
	}();
	return new class extends mock<IChatModel>() {
		override readonly sessionResource = URI.parse(resource);
		override readonly lastRequest = request;
		override readonly hasActiveRequest = constObservable(!!options.active);
		override readonly requestNeedsInput = constObservable(options.needsInput ? { title: 'chat' } : undefined);
	}();
}

suite('ChatAgentActivity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies tools and agent names', () => {
		assert.deepStrictEqual({
			tools: [
				'vscode_editFile_internal', 'replace_string_in_file', 'copilot_applyPatch', 'create_file', 'str_replace_editor', 'vscode_renameSymbol',
				'run_in_terminal', 'bash', 'runTests',
				'read_file', 'grep_search', 'glob', 'view', 'fetch_webpage', 'vscode_listCodeUsages', 'semantic_search',
				'manage_todo_list', 'vscode_reviewPlan', 'vscode_askQuestions', 'think',
			].map(toolId => [toolId, classifyToolActivity(toolId)]),
			kinds: [classifyToolActivity('anything', 'terminal'), classifyToolActivity('runSubagent', 'subagent'), classifyToolActivity('x', 'todoList')],
			names: ['Code Reviewer', 'Plan', 'Explore', 'Implementer', 'test-runner', 'helper'].map(name => [name, getAgentNameActivity(name)]),
		}, {
			tools: [
				['vscode_editFile_internal', 'programming'], ['replace_string_in_file', 'programming'], ['copilot_applyPatch', 'programming'], ['create_file', 'programming'], ['str_replace_editor', 'programming'], ['vscode_renameSymbol', 'programming'],
				['run_in_terminal', 'testing'], ['bash', 'testing'], ['runTests', 'testing'],
				['read_file', 'researching'], ['grep_search', 'researching'], ['glob', 'researching'], ['view', 'researching'], ['fetch_webpage', 'researching'], ['vscode_listCodeUsages', 'researching'], ['semantic_search', 'researching'],
				['manage_todo_list', 'planning'], ['vscode_reviewPlan', 'planning'], ['vscode_askQuestions', 'waitingForInput'], ['think', undefined],
			],
			kinds: ['testing', undefined, 'planning'],
			names: [['Code Reviewer', 'reviewing'], ['Plan', 'planning'], ['Explore', 'researching'], ['Implementer', 'programming'], ['test-runner', 'testing'], ['helper', undefined]],
		});
	});

	test('lists the root agent and every nested subagent with its activity', () => {
		const childChat = chat('agent-host:/child', [
			running('child-edit', { toolId: 'edit' }),
			running('child-sub', { data: subagent('explore', 'Look around') }),
		], { active: true });
		const model = chat('chat:/root', [
			done('root-read'),
			running('root-edit', { toolId: 'replace_string_in_file' }),
			// A reviewer that reads code keeps reviewing.
			running('review', { data: subagent('code-reviewer', 'Review the change') }),
			running('review-read', { toolId: 'read_file', subAgentInvocationId: 'review' }),
			// An unnamed subagent that runs the tests, with a nested planner that has no tool running.
			running('worker', { data: subagent(undefined, 'Do the work') }),
			running('worker-test', { toolId: 'run_in_terminal', subAgentInvocationId: 'worker' }),
			running('planner', { subAgentInvocationId: 'worker', data: subagent('Plan', 'Plan next steps') }),
			// A subagent waiting for confirmation, one that finished, and one that failed.
			running('asker', { data: subagent('helper', 'Ask first') }),
			running('asker-tool', { toolId: 'run_in_terminal', subAgentInvocationId: 'asker', waiting: true }),
			done('finished', { data: subagent('explore', 'Explored') }),
			done('broken', { data: subagent('helper', 'Broke'), resultError: 'boom' }),
			// A subagent running as its own chat continues with that chat's tools and subagents.
			running('remote', { data: subagent('helper', 'Remote work', { chatResource: 'agent-host:/child', isChatAvailable: true }) }),
		], { active: true, mode: { kind: ChatModeKind.Agent, telemetryModeName: 'Agent' } });

		const getSession = (resource: URI) => resource.toString() === 'agent-host:/child' ? childChat : undefined;
		assert.deepStrictEqual(getChatAgentActivities(model, { getSession }).map(entry => `${'  '.repeat(entry.depth)}${entry.id} (${entry.name ?? '-'}, parent ${entry.parentId ?? '-'}): ${entry.activity} / ${entry.status}`), [
			'root (Agent, parent -): programming / running',
			'  review (code-reviewer, parent -): reviewing / running',
			'  worker (-, parent -): testing / running',
			'    planner (Plan, parent worker): planning / running',
			'  asker (helper, parent -): waitingForInput / waiting',
			'  finished (explore, parent -): done / done',
			'  broken (helper, parent -): failed / failed',
			'  remote (helper, parent -): programming / running',
			'    child-sub (explore, parent remote): researching / running',
		]);
	});

	test('reports a waiting or idle chat', () => {
		assert.deepStrictEqual({
			waiting: getChatAgentActivities(chat('chat:/a', [running('t', { waiting: true })], { active: true, needsInput: true })).map(entry => [entry.id, entry.activity, entry.status]),
			thinking: getChatAgentActivities(chat('chat:/b', [], { active: true })).map(entry => [entry.id, entry.activity]),
			planMode: getChatAgentActivities(chat('chat:/c', [done('read')], { active: true, mode: { telemetryModeName: 'Plan' } })).map(entry => [entry.id, entry.activity]),
			idle: getChatAgentActivities(chat('chat:/d', [done('read')])),
		}, {
			waiting: [['root', 'waitingForInput', 'waiting']],
			thinking: [['root', 'thinking']],
			planMode: [['root', 'planning']],
			idle: [],
		});
	});
});
