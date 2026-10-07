/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: classifies what the agents of a chat are doing, so the Creacoon pet (and its crew) can act it out.

import { URI } from '../../../../../base/common/uri.js';
import { AgentsTreeStatus, buildSubagentNodes, IAgentsTreeSubagentNode, isWaitingForUser } from '../agentsTree/agentsTreeModel.js';
import { IChatService, IChatToolInvocation, IChatToolInvocationSerialized } from '../chatService/chatService.js';
import { IChatModel, IChatRequestModel } from '../model/chatModel.js';

/**
 * What an agent is currently doing.
 */
export const enum ChatAgentActivity {
	Thinking = 'thinking',
	Programming = 'programming',
	Testing = 'testing',
	Researching = 'researching',
	Planning = 'planning',
	Reviewing = 'reviewing',
	WaitingForInput = 'waitingForInput',
	Done = 'done',
	Failed = 'failed',
}

/**
 * An agent working on a chat: the chat's own (root) agent, or a subagent it started.
 */
export interface IChatAgentActivityEntry {
	/** `root` for the chat's own agent, otherwise the tool call id that started the subagent. */
	readonly id: string;
	/** The id of the agent that started this one, `undefined` for the root agent. */
	readonly parentId: string | undefined;
	/** 0 for the root agent, 1 for subagents it started, and so on. */
	readonly depth: number;
	/** Display name of the agent (mode, agent type or subagent type), when known. */
	readonly name: string | undefined;
	readonly description: string | undefined;
	readonly activity: ChatAgentActivity;
	readonly status: AgentsTreeStatus;
}

/** The id of the entry for the chat's own agent. */
export const CHAT_ROOT_AGENT_ID = 'root';

type ToolInvocation = IChatToolInvocation | IChatToolInvocationSerialized;

const PLANNING_TOOL = /todo|plan/i;
const INPUT_TOOL = /ask_?questions?|ask_?user|elicit/i;
const TESTING_TOOL = /terminal|bash|shell|powershell|execute|exec_|run_?in|run_?command|run_?task|run_?tests?|test_?failure/i;
const PROGRAMMING_TOOL = /edit|replace|create|apply_?patch|insert|rename|write|patch|delete_?file|move_?file|scaffold/i;
const RESEARCH_TOOL = /read|grep|search|find|glob|list|view|fetch|web|usages|semantic|codebase|symbol|get_?errors|problems|changes|lookup|browse|open/i;

/**
 * Classifies a tool call by its id and tool-specific data. Returns `undefined` for tools that
 * do not say anything about the agent's activity, such as the call that starts a subagent.
 */
export function classifyToolActivity(toolId: string, toolSpecificDataKind?: string): ChatAgentActivity | undefined {
	switch (toolSpecificDataKind) {
		case 'subagent':
			return undefined;
		case 'terminal':
			return ChatAgentActivity.Testing;
		case 'todoList':
			return ChatAgentActivity.Planning;
		case 'search':
			return ChatAgentActivity.Researching;
	}
	if (PLANNING_TOOL.test(toolId)) {
		return ChatAgentActivity.Planning;
	}
	if (INPUT_TOOL.test(toolId)) {
		return ChatAgentActivity.WaitingForInput;
	}
	if (TESTING_TOOL.test(toolId)) {
		return ChatAgentActivity.Testing;
	}
	if (PROGRAMMING_TOOL.test(toolId)) {
		return ChatAgentActivity.Programming;
	}
	if (RESEARCH_TOOL.test(toolId)) {
		return ChatAgentActivity.Researching;
	}
	return undefined;
}

const NAME_HINTS: readonly (readonly [RegExp, ChatAgentActivity])[] = [
	[/review|audit|critic|inspect|verif/i, ChatAgentActivity.Reviewing],
	[/\btests?\b|tester|testing|\bqa\b/i, ChatAgentActivity.Testing],
	[/plan|architect/i, ChatAgentActivity.Planning],
	[/research|explor|search|investigat|scout|analy[sz]|\bask\b/i, ChatAgentActivity.Researching],
	[/implement|\bcode|coder|coding|program|\bfix|build|develop|\bdev\b|engineer|refactor/i, ChatAgentActivity.Programming],
];

/**
 * Guesses the activity of an agent from its names (agent type, display name, task description,
 * mode name), checked in order. Returns `undefined` when no name gives a hint.
 */
export function getAgentNameActivity(...names: readonly (string | undefined)[]): ChatAgentActivity | undefined {
	for (const name of names) {
		if (!name) {
			continue;
		}
		for (const [pattern, activity] of NAME_HINTS) {
			if (pattern.test(name)) {
				return activity;
			}
		}
	}
	return undefined;
}

/**
 * Combines the activity of a running tool with the hint from an agent's name. Reading code is
 * part of reviewing and planning, so a reviewer or planner that reads files keeps its role.
 */
function combineActivity(toolActivity: ChatAgentActivity | undefined, nameActivity: ChatAgentActivity | undefined): ChatAgentActivity {
	if (toolActivity === ChatAgentActivity.Researching && (nameActivity === ChatAgentActivity.Reviewing || nameActivity === ChatAgentActivity.Planning)) {
		return nameActivity;
	}
	return toolActivity ?? nameActivity ?? ChatAgentActivity.Thinking;
}

/**
 * Returns the activity of the most recently started tool that is still running among `invocations`.
 */
function getRunningToolActivity(invocations: readonly ToolInvocation[]): ChatAgentActivity | undefined {
	for (let i = invocations.length - 1; i >= 0; i--) {
		const invocation = invocations[i];
		if (IChatToolInvocation.isComplete(invocation)) {
			continue;
		}
		if (isWaitingForUser(invocation)) {
			return ChatAgentActivity.WaitingForInput;
		}
		const activity = classifyToolActivity(invocation.toolId, invocation.toolSpecificData?.kind);
		if (activity) {
			return activity;
		}
	}
	return undefined;
}

function getToolInvocations(request: IChatRequestModel | undefined): ToolInvocation[] {
	return request?.response?.response.value.filter((part): part is ToolInvocation => part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized') ?? [];
}

/** Tools run by the agent itself, not by one of its subagents. */
function getOwnTools(invocations: readonly ToolInvocation[]): ToolInvocation[] {
	return invocations.filter(invocation => !invocation.subAgentInvocationId && invocation.toolSpecificData?.kind !== 'subagent');
}

function getStatusActivity(status: AgentsTreeStatus): ChatAgentActivity | undefined {
	switch (status) {
		case AgentsTreeStatus.WaitingForConfirmation: return ChatAgentActivity.WaitingForInput;
		case AgentsTreeStatus.Done: return ChatAgentActivity.Done;
		case AgentsTreeStatus.Failed:
		case AgentsTreeStatus.Cancelled: return ChatAgentActivity.Failed;
		default: return undefined;
	}
}

/**
 * Lists the agents working on the last request of a chat, in depth-first order: the chat's own
 * agent first (only while its request is active), followed by every subagent it started, nested
 * to any depth. A subagent that runs as its own chat continues with that chat's subagents when
 * `chatService` can resolve its model.
 */
export function getChatAgentActivities(model: IChatModel, chatService?: Pick<IChatService, 'getSession'>): IChatAgentActivityEntry[] {
	const entries: IChatAgentActivityEntry[] = [];
	const request = model.lastRequest;
	const needsInput = !!model.requestNeedsInput.get();
	if (needsInput || model.hasActiveRequest.get()) {
		const modeInfo = request?.modeInfo;
		const name = modeInfo?.modeInstructions?.name ?? modeInfo?.telemetryModeName;
		const toolActivity = getRunningToolActivity(getOwnTools(getToolInvocations(request)));
		entries.push({
			id: CHAT_ROOT_AGENT_ID,
			parentId: undefined,
			depth: 0,
			name,
			description: undefined,
			activity: needsInput ? ChatAgentActivity.WaitingForInput : combineActivity(toolActivity, getAgentNameActivity(name, modeInfo?.kind)),
			status: needsInput ? AgentsTreeStatus.WaitingForConfirmation : AgentsTreeStatus.Running,
		});
	}
	collectSubagents(model, undefined, 1, chatService, new Set(), entries);
	return entries;
}

function collectSubagents(model: IChatModel, parentId: string | undefined, depth: number, chatService: Pick<IChatService, 'getSession'> | undefined, visitedModels: Set<string>, entries: IChatAgentActivityEntry[]): void {
	const modelKey = model.sessionResource.toString();
	if (visitedModels.has(modelKey)) {
		return;
	}
	visitedModels.add(modelKey);

	const invocations = getToolInvocations(model.lastRequest);
	const toolsBySubagent = new Map<string, ToolInvocation[]>();
	for (const invocation of invocations) {
		if (invocation.subAgentInvocationId && invocation.toolSpecificData?.kind !== 'subagent') {
			let tools = toolsBySubagent.get(invocation.subAgentInvocationId);
			if (!tools) {
				tools = [];
				toolsBySubagent.set(invocation.subAgentInvocationId, tools);
			}
			tools.push(invocation);
		}
	}

	const visit = (node: IAgentsTreeSubagentNode, nodeParentId: string | undefined, nodeDepth: number) => {
		const childModel = node.chatResource ? chatService?.getSession(URI.parse(node.chatResource)) : undefined;
		let toolActivity = getRunningToolActivity(toolsBySubagent.get(node.id) ?? []);
		if (!toolActivity && childModel) {
			toolActivity = getRunningToolActivity(getOwnTools(getToolInvocations(childModel.lastRequest)));
		}
		entries.push({
			id: node.id,
			parentId: nodeParentId,
			depth: nodeDepth,
			name: node.name,
			description: node.description,
			activity: getStatusActivity(node.status) ?? combineActivity(toolActivity, getAgentNameActivity(node.name, node.description)),
			status: node.status,
		});
		for (const child of node.children) {
			visit(child, node.id, nodeDepth + 1);
		}
		if (node.children.length === 0 && childModel) {
			collectSubagents(childModel, node.id, nodeDepth + 1, chatService, visitedModels, entries);
		}
	};
	for (const node of buildSubagentNodes(invocations, 0)) {
		visit(node, parentId, depth);
	}
}
