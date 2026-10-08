/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Agents tree of the Agents window: sessions, their subagents and the sessions they created,
// including the most recently archived sessions, shown as turned off.

import { DisposableMap, IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, IReader, observableFromEvent, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { AgentsTreeControl, AgentsTreeElement, buildChatModelSubagentElements, collectChatModelSubagentNodes, IAgentsTreeChatElement, IAgentsTreeGroupElement, IAgentsTreeSubagentElement } from '../../../../../workbench/contrib/chat/browser/agentsTree/agentsTreeView.js';
import { IChatWidget, IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { AgentsTreeStatus, IAgentsTreeSubagentNode, orderAgentsTreeRoots } from '../../../../../workbench/contrib/chat/common/agentsTree/agentsTreeModel.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ChatOriginKind, IChat, ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

function getSessionStatus(status: SessionStatus): AgentsTreeStatus | undefined {
	switch (status) {
		case SessionStatus.InProgress: return AgentsTreeStatus.Running;
		case SessionStatus.NeedsInput: return AgentsTreeStatus.WaitingForConfirmation;
		case SessionStatus.Completed: return AgentsTreeStatus.Done;
		case SessionStatus.Error: return AgentsTreeStatus.Failed;
		default: return undefined;
	}
}

/** How many of the most recent sessions keep their subagent chats listed, on top of the running ones. */
const RECENT_SESSIONS_TO_RETAIN = 5;

/**
 * Returns the sessions whose subagents the tree shows: the running ones and the most recent ones that are not archived.
 */
function getSessionsToRetain(sessions: readonly ISession[], reader: IReader): ISession[] {
	const active = sessions
		.filter(session => !session.isArchived.read(reader))
		.sort((a, b) => b.updatedAt.read(reader).getTime() - a.updatedAt.read(reader).getTime());
	return active.filter((session, index) => index < RECENT_SESSIONS_TO_RETAIN || session.status.read(reader) === SessionStatus.InProgress || session.status.read(reader) === SessionStatus.NeedsInput);
}

/**
 * Shows the sessions of the Agents window with their subagents, nested under the subagent that
 * started them, and the sessions they created (`create_session`), grouped by their agent-created
 * session group. Archived sessions stay visible as turned off; at the top level only the most recent ones are kept.
 */
export class SessionsAgentsTreeControl extends AgentsTreeControl {

	private readonly _retainedSessions = this._register(new DisposableMap<string, IDisposable>());
	private readonly _visibleObs = observableValue(this, false);

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IChatService chatService: IChatService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@ICommandService commandService: ICommandService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionGroupsService private readonly _sessionGroupsService: ISessionGroupsService,
	) {
		super(instantiationService, chatService, chatWidgetService, commandService);

		const sessions = observableFromEvent(this, this._sessionsManagementService.onDidChangeSessions, () => this._sessionsManagementService.getSessions());
		this._register(autorun(reader => {
			for (const session of sessions.read(reader)) {
				session.title.read(reader);
				session.status.read(reader);
				session.isArchived.read(reader);
				session.createdBySession?.read(reader);
				for (const chat of session.chats.read(reader)) {
					if (chat.origin?.kind === ChatOriginKind.Tool) {
						chat.title.read(reader);
						chat.status.read(reader);
					}
				}
			}
			this.scheduleRefresh();
		}));
		// Sessions only list the subagent chats their agent starts while someone holds on to their chats.
		this._register(autorun(reader => {
			const retain = this._visibleObs.read(reader) ? getSessionsToRetain(sessions.read(reader), reader) : [];
			const keys = new Set(retain.map(session => session.sessionId));
			for (const key of [...this._retainedSessions.keys()]) {
				if (!keys.has(key)) {
					this._retainedSessions.deleteAndDispose(key);
				}
			}
			for (const session of retain) {
				if (!this._retainedSessions.has(session.sessionId) && session.retainChats) {
					this._retainedSessions.set(session.sessionId, session.retainChats());
				}
			}
		}));
		this._register(this._sessionGroupsService.onDidChange(() => this.scheduleRefresh()));
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this._visibleObs.set(visible, undefined);
	}

	protected computeRoots(now: number): AgentsTreeElement[] {
		const sessions = this._sessionsManagementService.getSessions();
		const sessionKeys = new Set(sessions.map(session => session.resource.toString()));
		const createdByCreator = new Map<string, ISession[]>();
		const roots: ISession[] = [];
		for (const session of sessions) {
			const creatorKey = session.createdBySession?.get()?.session.toString();
			if (creatorKey && creatorKey !== session.resource.toString() && sessionKeys.has(creatorKey)) {
				let created = createdByCreator.get(creatorKey);
				if (!created) {
					created = [];
					createdByCreator.set(creatorKey, created);
				}
				created.push(session);
			} else {
				roots.push(session);
			}
		}

		const referencedChats = new Set<string>();
		const visitedChats = new Set<string>();
		const visitedSessions = new Set<string>();
		const toElement = (session: ISession): IAgentsTreeChatElement => {
			const key = session.resource.toString();
			visitedSessions.add(key);
			const children: AgentsTreeElement[] = [];
			const allChats = session.chats.get();
			const mainChat = session.mainChat.get();
			const subagentChats = allChats.filter(chat => chat.origin?.kind === ChatOriginKind.Tool);
			if (subagentChats.length > 0) {
				children.push(...this._getSubagentChatElements(mainChat, allChats, subagentChats, now));
			} else {
				// Sessions whose subagents do not run as their own chats: read them from the loaded chat models.
				for (const chat of allChats) {
					const model = this.chatService.getSession(chat.resource);
					if (model) {
						children.push(...buildChatModelSubagentElements(this.chatService, model, now, referencedChats, visitedChats));
					}
				}
			}

			const groups = new Map<string, { label: string; children: IAgentsTreeChatElement[] }>();
			for (const created of createdByCreator.get(key) ?? []) {
				if (visitedSessions.has(created.resource.toString())) {
					continue;
				}
				const element = toElement(created);
				const sessionGroup = created.createdBySession?.get()?.sessionGroup;
				if (!sessionGroup) {
					children.push(element);
					continue;
				}
				let group = groups.get(sessionGroup.id);
				if (!group) {
					group = { label: this._sessionGroupsService.getGroup(sessionGroup.id)?.name ?? sessionGroup.name, children: [] };
					groups.set(sessionGroup.id, group);
				}
				group.children.push(element);
			}
			for (const [groupId, group] of groups) {
				const groupElement: IAgentsTreeGroupElement = { kind: 'group', id: `${key}#${groupId}`, label: group.label, children: group.children };
				children.push(groupElement);
			}

			return {
				kind: 'chat',
				id: key,
				label: session.title.get() || localize('sessionsAgentsTree.untitledSession', "New Session"),
				status: getSessionStatus(session.status.get()),
				resource: session.resource,
				closed: session.isArchived.get() ? 'archived' : undefined,
				children,
			};
		};

		const ordered = orderAgentsTreeRoots(roots, session => ({
			status: getSessionStatus(session.status.get()),
			closed: session.isArchived.get(),
			lastActivity: session.updatedAt.get().getTime(),
		}));
		return ordered.map(toElement);
	}

	/**
	 * Builds the subagents of a session from its subagent chats, which the session lists whether or not
	 * a chat is open. Each subagent nests under the subagent that started it; a loaded chat model adds
	 * the agent name, model and duration of the subagents it started.
	 */
	private _getSubagentChatElements(mainChat: IChat, allChats: readonly IChat[], subagentChats: readonly IChat[], now: number): IAgentsTreeSubagentElement[] {
		const nodes = new Map<string, IAgentsTreeSubagentNode>();
		for (const chat of allChats) {
			const model = this.chatService.getSession(chat.resource);
			if (model) {
				collectChatModelSubagentNodes(model, now, nodes);
			}
		}

		const subagentKeys = new Set(subagentChats.map(chat => chat.resource.toString()));
		const byParent = new Map<string, IChat[]>();
		const mainKey = mainChat.resource.toString();
		for (const chat of subagentChats) {
			const parent = (chat.origin?.spawningChat ?? chat.origin?.parentChat)?.toString();
			// Subagents started by a chat the user talks to show at the top of the session.
			const parentKey = parent && subagentKeys.has(parent) ? parent : mainKey;
			let siblings = byParent.get(parentKey);
			if (!siblings) {
				siblings = [];
				byParent.set(parentKey, siblings);
			}
			siblings.push(chat);
		}

		const visited = new Set<string>();
		const toElements = (parent: IChat): IAgentsTreeSubagentElement[] => {
			const result: IAgentsTreeSubagentElement[] = [];
			for (const chat of byParent.get(parent.resource.toString()) ?? []) {
				const key = chat.resource.toString();
				if (visited.has(key)) {
					continue;
				}
				visited.add(key);
				const toolCallId = chat.origin?.toolCallId;
				const known = toolCallId ? nodes.get(toolCallId) : undefined;
				const status = getSessionStatus(chat.status.get()) ?? known?.status ?? AgentsTreeStatus.Done;
				const running = status === AgentsTreeStatus.Running || status === AgentsTreeStatus.WaitingForConfirmation;
				const elapsed = (running ? now : chat.updatedAt.get().getTime()) - chat.createdAt.getTime();
				const node: IAgentsTreeSubagentNode = {
					id: toolCallId ?? key,
					name: known?.name,
					description: chat.title.get() || known?.description,
					modelName: known?.modelName,
					status,
					duration: known?.duration ?? (elapsed > 0 ? elapsed : undefined),
					chatResource: key,
					children: [],
				};
				result.push({ kind: 'subagent', id: key, node, sessionResource: parent.resource, responseId: '', children: toElements(chat) });
			}
			return result;
		};
		return toElements(mainChat);
	}

	protected override async openSubagent(element: IAgentsTreeSubagentElement, preserveFocus: boolean): Promise<void> {
		// A subagent chat of a session opens as a chat of that session.
		const owner = element.node.chatResource ? this._sessionsManagementService.getSessionForChatResource(URI.parse(element.node.chatResource)) : undefined;
		if (owner) {
			await this._sessionsService.openChat(owner.session, owner.chat.resource, { preserveFocus, source: 'navigation' });
			return;
		}
		return super.openSubagent(element, preserveFocus);
	}

	protected async openChat(element: IAgentsTreeChatElement, preserveFocus: boolean): Promise<void> {
		// A subagent chat opens as a chat of its session; anything else is a session.
		const owner = this._sessionsManagementService.getSessionForChatResource(element.resource);
		if (owner && owner.chat !== owner.session.mainChat.get()) {
			await this._sessionsService.openChat(owner.session, owner.chat.resource, { preserveFocus, source: 'navigation' });
			return;
		}
		await this._sessionsService.openSession(element.resource, { preserveFocus, source: 'navigation' });
	}

	protected override async openSubagentParentChat(element: IAgentsTreeSubagentElement, preserveFocus: boolean): Promise<IChatWidget | undefined> {
		const owner = this._sessionsManagementService.getSessionForChatResource(element.sessionResource);
		if (owner) {
			await this._sessionsService.openSession(owner.session.resource, { preserveFocus, source: 'navigation' });
		}
		return this.chatWidgetService.getWidgetBySessionResource(element.sessionResource);
	}
}
