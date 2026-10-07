/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: model for the live Agents tree (chats -> subagents -> nested subagents).

import { getSubagentIsActive, IChatSubagentToolInvocationData, IChatToolInvocation, IChatToolInvocationSerialized, ToolConfirmKind } from '../chatService/chatService.js';

/**
 * Status of an entry in the Agents tree.
 */
export const enum AgentsTreeStatus {
	Running = 'running',
	WaitingForConfirmation = 'waiting',
	Done = 'done',
	Failed = 'failed',
	Cancelled = 'cancelled',
}

/**
 * A subagent started by a chat request or by another subagent.
 */
export interface IAgentsTreeSubagentNode {
	/** Tool call id of the tool invocation that started the subagent. */
	readonly id: string;
	/** Provider display name, or internal name, of the subagent type. */
	readonly name: string | undefined;
	readonly description: string | undefined;
	readonly modelName: string | undefined;
	readonly status: AgentsTreeStatus;
	/** Elapsed (running) or final duration in milliseconds, when known. */
	readonly duration: number | undefined;
	/** The subagent's own chat resource, when it runs as a distinct chat that is not reported unavailable. */
	readonly chatResource: string | undefined;
	readonly children: readonly IAgentsTreeSubagentNode[];
}

type ToolInvocation = IChatToolInvocation | IChatToolInvocationSerialized;

/**
 * Returns whether a tool invocation is waiting for the user (confirmation, post-approval or authentication).
 */
export function isWaitingForUser(invocation: ToolInvocation): boolean {
	if (invocation.kind === 'toolInvocationSerialized') {
		return false;
	}
	const type = invocation.state.get().type;
	return type === IChatToolInvocation.StateKind.WaitingForConfirmation
		|| type === IChatToolInvocation.StateKind.WaitingForPostApproval
		|| type === IChatToolInvocation.StateKind.WaitingForAuthentication;
}

/**
 * Derives the status of a subagent from the tool invocation that started it.
 * @param hasWaitingChild whether a tool run by the subagent is waiting for the user.
 */
export function getSubagentStatus(invocation: ToolInvocation, data: IChatSubagentToolInvocationData, hasWaitingChild: boolean): AgentsTreeStatus {
	if (data.presentation === 'phase') {
		switch (data.phaseStatus) {
			case 'failed': return AgentsTreeStatus.Failed;
			case 'cancelled': return AgentsTreeStatus.Cancelled;
			case 'succeeded': return AgentsTreeStatus.Done;
		}
	}

	const isComplete = IChatToolInvocation.isComplete(invocation);
	const isActive = getSubagentIsActive(data) ?? !isComplete;
	if (isActive) {
		return hasWaitingChild || isWaitingForUser(invocation) ? AgentsTreeStatus.WaitingForConfirmation : AgentsTreeStatus.Running;
	}

	const confirmation = IChatToolInvocation.executionConfirmedOrDenied(invocation);
	if (confirmation?.type === ToolConfirmKind.Denied || confirmation?.type === ToolConfirmKind.Skipped) {
		return AgentsTreeStatus.Cancelled;
	}
	if (invocation.kind === 'toolInvocation') {
		const state = invocation.state.get();
		if (state.type === IChatToolInvocation.StateKind.Cancelled) {
			return AgentsTreeStatus.Cancelled;
		}
		if (state.type === IChatToolInvocation.StateKind.Completed && state.resultError) {
			return AgentsTreeStatus.Failed;
		}
	} else if (invocation.resultError) {
		return AgentsTreeStatus.Failed;
	}
	return AgentsTreeStatus.Done;
}

/**
 * Turns the tool invocations of a response into the subagents they started, nested by
 * `subAgentInvocationId` to any depth. A subagent call carries `toolSpecificData.kind === 'subagent'`;
 * a nested one points at the tool call id of the subagent that started it. Subagents whose parent is
 * unknown are returned at the top level.
 * @param now the current time, used for the elapsed duration of running subagents.
 */
export function buildSubagentNodes(invocations: Iterable<ToolInvocation>, now: number): IAgentsTreeSubagentNode[] {
	const subagents: { invocation: ToolInvocation; data: IChatSubagentToolInvocationData }[] = [];
	const waitingParents = new Set<string>();
	for (const invocation of invocations) {
		const data = invocation.toolSpecificData;
		if (data?.kind === 'subagent') {
			subagents.push({ invocation, data });
		} else if (invocation.subAgentInvocationId && isWaitingForUser(invocation)) {
			waitingParents.add(invocation.subAgentInvocationId);
		}
	}

	const ids = new Set(subagents.map(s => s.invocation.toolCallId));
	const childrenByParent = new Map<string | undefined, typeof subagents>();
	for (const subagent of subagents) {
		const parentId = subagent.invocation.subAgentInvocationId;
		const key = parentId && parentId !== subagent.invocation.toolCallId && ids.has(parentId) ? parentId : undefined;
		let siblings = childrenByParent.get(key);
		if (!siblings) {
			siblings = [];
			childrenByParent.set(key, siblings);
		}
		siblings.push(subagent);
	}

	const visited = new Set<string>();
	const toNodes = (parentId: string | undefined): IAgentsTreeSubagentNode[] => {
		const nodes: IAgentsTreeSubagentNode[] = [];
		for (const { invocation, data } of childrenByParent.get(parentId) ?? []) {
			if (visited.has(invocation.toolCallId)) {
				continue; // guards against malformed cycles
			}
			visited.add(invocation.toolCallId);
			const status = getSubagentStatus(invocation, data, waitingParents.has(invocation.toolCallId));
			const isRunning = status === AgentsTreeStatus.Running || status === AgentsTreeStatus.WaitingForConfirmation;
			nodes.push({
				id: invocation.toolCallId,
				name: data.agentDisplayName?.trim() || data.agentName?.trim() || undefined,
				description: data.description,
				modelName: data.modelName,
				status,
				duration: data.duration ?? (isRunning && data.startedAt !== undefined ? Math.max(0, now - data.startedAt) : undefined),
				chatResource: data.isChatAvailable === false ? undefined : data.chatResource,
				children: toNodes(invocation.toolCallId),
			});
		}
		return nodes;
	};
	return toNodes(undefined);
}
