/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: registers the "Agents" view (live tree of chats and subagents) next to the Chat view.

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IsSessionsWindowContext } from '../../../../common/contextkeys.js';
import { IViewContainersRegistry, IViewsRegistry, Extensions as ViewExtensions } from '../../../../common/views.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from '../actions/chatActions.js';
import { ChatViewContainerId } from '../chat.js';
import { AGENTS_TREE_VIEW_ID, ChatAgentsTreeViewPane } from './agentsTreeView.js';

const agentsTreeViewIcon = registerIcon('chat-agents-tree-view-icon', Codicon.typeHierarchySub, localize('agentsTreeViewIcon', "View icon of the Agents view."));

const chatViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).get(ChatViewContainerId);
if (chatViewContainer) {
	Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
		id: AGENTS_TREE_VIEW_ID,
		name: localize2('agentsTree.view.label', "Agents"),
		containerIcon: agentsTreeViewIcon,
		ctorDescriptor: new SyncDescriptor(ChatAgentsTreeViewPane),
		canToggleVisibility: true,
		canMoveView: true,
		// Hidden until opened so the Chat view keeps its single-view layout.
		hideByDefault: true,
		collapsed: true,
		order: 100,
		when: ChatContextKeys.enabled,
	}], chatViewContainer);
}

class ShowAgentsTreeAction extends Action2 {
	static readonly ID = 'workbench.action.chat.showAgentsTree';

	constructor() {
		super({
			id: ShowAgentsTreeAction.ID,
			title: localize2('chat.showAgentsTree', "Show Agents Tree"),
			category: CHAT_CATEGORY,
			icon: agentsTreeViewIcon,
			precondition: ChatContextKeys.enabled,
			// The Agents window registers its own Agents view and command.
			menu: { id: MenuId.CommandPalette, when: IsSessionsWindowContext.negate() },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(AGENTS_TREE_VIEW_ID, true);
	}
}
registerAction2(ShowAgentsTreeAction);
