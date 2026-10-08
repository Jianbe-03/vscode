/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Toggle Agents Tree and Open AI Costs buttons in the Sessions header of the Agents window.
// The Agents tree itself is a section of the Sessions view, see `SessionsAgentsTreeSection`.

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { CHAT_CATEGORY } from '../../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { Menus } from '../../../../browser/menus.js';
import { SessionsView, SessionsViewId } from '../views/sessionsView.js';

/** Command of the Copilot extension that opens the AI Costs page (cost per issue and chat). */
const SHOW_AI_COSTS_COMMAND_ID = 'creaeditor.showAiCosts';

/** Maximizes the editor area of the Agents window over the chat (see the sessions editor contribution). */
const MAXIMIZE_MAIN_EDITOR_PART_COMMAND_ID = 'workbench.action.agentSessions.maximizeMainEditorPart';

const aiCostsIcon = registerIcon('sessions-ai-costs-icon', Codicon.creditCard, localize('sessionsAiCostsIcon', "Icon of the Open AI Costs action in the Agents window."));
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
 * Opens the AI Costs page of the Copilot extension. The extension runs in the Agents window too,
 * so the page opens as a webview editor, maximized over the chat.
 */
class OpenAiCostsAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.action.openAiCosts',
			title: localize2('sessions.openAiCosts', "Open AI Costs"),
			category: CHAT_CATEGORY,
			icon: aiCostsIcon,
			precondition: IsSessionsWindowContext,
			menu: [
				{ id: MenuId.CommandPalette, when: IsSessionsWindowContext },
				{ id: Menus.SidebarSessionsHeader, group: 'navigation', order: 40 },
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand(SHOW_AI_COSTS_COMMAND_ID);
		await commandService.executeCommand(MAXIMIZE_MAIN_EDITOR_PART_COMMAND_ID);
	}
}
registerAction2(OpenAiCostsAction);
