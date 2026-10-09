/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Toggle Agents Tree, Show AI Costs, Show Subscription Usage and Stop All Chats buttons in the Sessions header of the Agents window.
// The Agents tree itself is a section of the Sessions view, see `SessionsAgentsTreeSection`.

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { CHAT_CATEGORY } from '../../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatHasRunningChatsContext, STOP_ALL_CHATS_COMMAND_ID, stopAllChatsIcon } from '../../../../../workbench/contrib/chat/browser/actions/chatStopAllActions.js';
import { SHOW_AI_COSTS_ACTION_ID } from '../../../../../workbench/contrib/chat/browser/gatewayCost/chatGatewayCost.js';
import { SHOW_SUBSCRIPTION_USAGE_COMMAND_ID } from '../../../../../workbench/contrib/chat/browser/subscriptionAccounts/subscriptionAccountsLimit.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { Menus } from '../../../../browser/menus.js';
import { SessionsView, SessionsViewId } from '../views/sessionsView.js';

const aiCostsIcon = registerIcon('sessions-ai-costs-icon', Codicon.creditCard, localize('sessionsAiCostsIcon', "Icon of the Show AI Costs action in the Agents window."));
const subscriptionUsageIcon = registerIcon('sessions-subscription-usage-icon', Codicon.pulse, localize('sessionsSubscriptionUsageIcon', "Icon of the Show Subscription Usage action in the Agents window."));
const agentsTreeIcon = registerIcon('sessions-agents-tree-view-icon', Codicon.typeHierarchySub, localize('sessionsAgentsTreeViewIcon', "Icon of the Toggle Agents Tree action in the Agents window."));

class ToggleSessionsAgentsTreeAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.action.showAgentsTree',
			title: localize2('sessions.toggleAgentsTree', "Toggle Agents Tree"),
			category: CHAT_CATEGORY,
			icon: agentsTreeIcon,
			precondition: ContextKeyExpr.and(IsSessionsWindowContext, ChatContextKeys.enabled),
			menu: [
				{ id: MenuId.CommandPalette, when: IsSessionsWindowContext },
				// After New (0), Filter (10) and Find (20) in the Sessions header.
				{ id: Menus.SidebarSessionsHeader, group: 'navigation', order: 30, when: ChatContextKeys.enabled },
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await accessor.get(IViewsService).openView<SessionsView>(SessionsViewId, false);
		view?.toggleAgentsTree();
	}
}
registerAction2(ToggleSessionsAgentsTreeAction);

/**
 * Opens the AI Costs page of the Copilot extension, maximized over the chat. In the Command Palette
 * it is "Chat: Show AI Costs", which works in every window.
 */
class OpenAiCostsAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.action.openAiCosts',
			title: localize2('sessions.openAiCosts', "Show AI Costs"),
			tooltip: localize2('sessions.openAiCostsTooltip', "Show AI Costs per Issue, Chat and Key"),
			category: CHAT_CATEGORY,
			icon: aiCostsIcon,
			precondition: IsSessionsWindowContext,
			menu: [
				{ id: Menus.SidebarSessionsHeader, group: 'navigation', order: 40 },
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(SHOW_AI_COSTS_ACTION_ID);
	}
}
registerAction2(OpenAiCostsAction);

class OpenSubscriptionUsageAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.action.openSubscriptionUsage',
			title: localize2('sessions.openSubscriptionUsage', "Show Subscription Usage"),
			tooltip: localize2('sessions.openSubscriptionUsageTooltip', "Show What Is Left of Your Claude and Codex Accounts"),
			category: CHAT_CATEGORY,
			icon: subscriptionUsageIcon,
			precondition: IsSessionsWindowContext,
			menu: [
				// After AI Costs (40) in the Sessions header.
				{ id: Menus.SidebarSessionsHeader, group: 'navigation', order: 50 },
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// Opens the page full screen over the chat, like AI Costs.
		await accessor.get(ICommandService).executeCommand(SHOW_SUBSCRIPTION_USAGE_COMMAND_ID);
	}
}
registerAction2(OpenSubscriptionUsageAction);

// Stop All Chats (registered by the chat contribution, also in the command palette), last in the Sessions header.
MenuRegistry.appendMenuItem(Menus.SidebarSessionsHeader, {
	command: {
		id: STOP_ALL_CHATS_COMMAND_ID,
		title: localize2('sessions.stopAllChats', "Stop All Chats"),
		tooltip: localize2('sessions.stopAllChatsTooltip', "Stop All Running Chats in Every Window"),
		icon: stopAllChatsIcon,
		precondition: ChatHasRunningChatsContext,
	},
	group: 'navigation',
	order: 60,
	when: ChatContextKeys.enabled,
});
