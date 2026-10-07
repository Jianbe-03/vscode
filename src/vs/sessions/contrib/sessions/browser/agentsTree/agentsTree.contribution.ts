/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: registers the "Agents" view (live tree of sessions, subagents and created sessions) in the Agents window,
// and the Open Agents Tree and Open AI Costs buttons in the header of the Sessions list.

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IsSessionsWindowContext } from '../../../../../workbench/common/contextkeys.js';
import { IViewsRegistry, Extensions as ViewExtensions, WindowEnablement } from '../../../../../workbench/common/views.js';
import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CHAT_CATEGORY } from '../../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { Menus } from '../../../../browser/menus.js';
import { agentSessionsViewContainer } from '../sessions.contribution.js';
import { SESSIONS_AGENTS_TREE_VIEW_ID, SessionsAgentsTreeViewPane } from './sessionsAgentsTreeView.js';

/** Command of the Copilot extension that opens the AI Costs page (cost per issue and chat). */
const SHOW_AI_COSTS_COMMAND_ID = 'creaeditor.showAiCosts';

const aiCostsIcon = registerIcon('sessions-ai-costs-icon', Codicon.creditCard, localize('sessionsAiCostsIcon', "Icon of the Open AI Costs action in the Agents window."));
const agentsTreeViewIcon = registerIcon('sessions-agents-tree-view-icon', Codicon.typeHierarchySub, localize('sessionsAgentsTreeViewIcon', "View icon of the Agents view in the Agents window."));

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: SESSIONS_AGENTS_TREE_VIEW_ID,
	name: localize2('sessionsAgentsTree.view.label', "Agents"),
	containerIcon: agentsTreeViewIcon,
	ctorDescriptor: new SyncDescriptor(SessionsAgentsTreeViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	// Hidden until opened so the Sessions list keeps its single-view layout.
	hideByDefault: true,
	order: 100,
	windowEnablement: WindowEnablement.Sessions,
}], agentSessionsViewContainer);

class ShowSessionsAgentsTreeAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.action.showAgentsTree',
			title: localize2('sessions.openAgentsTree', "Open Agents Tree"),
			category: CHAT_CATEGORY,
			icon: agentsTreeViewIcon,
			precondition: ContextKeyExpr.and(IsSessionsWindowContext, ChatContextKeys.enabled),
			menu: [
				{ id: MenuId.CommandPalette, when: IsSessionsWindowContext },
				// After New (0), Filter (10) and Find (20) in the Sessions header.
				{ id: Menus.SidebarSessionsHeader, group: 'navigation', order: 30, when: ChatContextKeys.enabled },
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(SESSIONS_AGENTS_TREE_VIEW_ID, true);
	}
}
registerAction2(ShowSessionsAgentsTreeAction);

/**
 * Opens the AI Costs page of the Copilot extension. The extension runs in the Agents window too,
 * so the page opens as a webview editor in the Agents window's editor area.
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
		await accessor.get(ICommandService).executeCommand(SHOW_AI_COSTS_COMMAND_ID);
	}
}
registerAction2(OpenAiCostsAction);
