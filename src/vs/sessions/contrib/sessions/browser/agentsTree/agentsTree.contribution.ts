/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: registers the "Agents" view (live tree of sessions, subagents and created sessions) in the Agents window.

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
import { CHAT_CATEGORY } from '../../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ChatContextKeys } from '../../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { agentSessionsViewContainer } from '../sessions.contribution.js';
import { SESSIONS_AGENTS_TREE_VIEW_ID, SessionsAgentsTreeViewPane } from './sessionsAgentsTreeView.js';

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
			title: localize2('sessions.showAgentsTree', "Show Agents Tree"),
			category: CHAT_CATEGORY,
			icon: agentsTreeViewIcon,
			precondition: ContextKeyExpr.and(IsSessionsWindowContext, ChatContextKeys.enabled),
			menu: { id: MenuId.CommandPalette, when: IsSessionsWindowContext },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(SESSIONS_AGENTS_TREE_VIEW_ID, true);
	}
}
registerAction2(ShowSessionsAgentsTreeAction);
