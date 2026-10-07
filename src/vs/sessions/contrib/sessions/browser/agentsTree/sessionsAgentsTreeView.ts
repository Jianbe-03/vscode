/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Agents view of the Agents window: sessions, their subagents and the sessions they created,
// including the most recently archived sessions, shown as turned off.

import { autorun, observableFromEvent } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { AgentsTreeElement, AgentsTreeViewPane, buildChatModelSubagentElements, IAgentsTreeChatElement, IAgentsTreeGroupElement, IAgentsTreeSubagentElement } from '../../../../../workbench/contrib/chat/browser/agentsTree/agentsTreeView.js';
import { IChatWidget, IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { AgentsTreeStatus, orderAgentsTreeRoots } from '../../../../../workbench/contrib/chat/common/agentsTree/agentsTreeModel.js';
import { IChatService } from '../../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISession, SessionStatus } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

export const SESSIONS_AGENTS_TREE_VIEW_ID = 'workbench.sessions.auxiliaryBar.agentsTree';

function getSessionStatus(status: SessionStatus): AgentsTreeStatus | undefined {
	switch (status) {
		case SessionStatus.InProgress: return AgentsTreeStatus.Running;
		case SessionStatus.NeedsInput: return AgentsTreeStatus.WaitingForConfirmation;
		case SessionStatus.Completed: return AgentsTreeStatus.Done;
		case SessionStatus.Error: return AgentsTreeStatus.Failed;
		default: return undefined;
	}
}

/**
 * Shows the sessions of the Agents window with the subagents of their loaded chats, and the
 * sessions they created (`create_session`), grouped by their agent-created session group.
 * Archived sessions stay visible as turned off; at the top level only the most recent ones are kept.
 */
export class SessionsAgentsTreeViewPane extends AgentsTreeViewPane {

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IChatService chatService: IChatService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@ICommandService commandService: ICommandService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@ISessionGroupsService private readonly _sessionGroupsService: ISessionGroupsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, chatService, chatWidgetService, commandService);

		const sessions = observableFromEvent(this, this._sessionsManagementService.onDidChangeSessions, () => this._sessionsManagementService.getSessions());
		this._register(autorun(reader => {
			for (const session of sessions.read(reader)) {
				session.title.read(reader);
				session.status.read(reader);
				session.isArchived.read(reader);
				session.chats.read(reader);
				session.createdBySession?.read(reader);
			}
			this.scheduleRefresh();
		}));
		this._register(this._sessionGroupsService.onDidChange(() => this.scheduleRefresh()));
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
			// The main chat goes first so that subagent chats nest under the subagent that started them.
			const mainChat = session.mainChat.get();
			const chats = [mainChat, ...session.chats.get().filter(chat => chat !== mainChat)];
			for (const chat of chats) {
				const model = referencedChats.has(chat.resource.toString()) ? undefined : this.chatService.getSession(chat.resource);
				if (model) {
					children.push(...buildChatModelSubagentElements(this.chatService, model, now, referencedChats, visitedChats));
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

	protected async openChat(element: IAgentsTreeChatElement, preserveFocus: boolean): Promise<void> {
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
