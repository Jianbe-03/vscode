/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the gateway cost counter of the active chat in the session title bar of the Agents window.

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { derived } from '../../../../base/common/observable.js';
import { localize2 } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { MenuItemAction, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ChatGatewayCostActionViewItem, SHOW_CHAT_GATEWAY_COST_ACTION_ID } from '../../../../workbench/contrib/chat/browser/gatewayCost/chatGatewayCost.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

MenuRegistry.appendMenuItem(Menus.TitleBarSessionMenu, {
	command: {
		id: SHOW_CHAT_GATEWAY_COST_ACTION_ID,
		title: localize2('sessions.showChatGatewayCost', "Show AI Costs of This Chat"),
		icon: Codicon.creditCard,
	},
	group: 'navigation',
	// Before the changes (5) and panel (10) actions.
	order: 1,
});

/** Renders the counter for the active chat of the active session. */
class SessionsChatGatewayCostContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.sessionsChatGatewayCost';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ISessionsService sessionsService: ISessionsService,
	) {
		super();
		const sessionResource = derived(this, reader => sessionsService.activeSession.read(reader)?.activeChat.read(reader).resource);
		this._register(actionViewItemService.register(Menus.TitleBarSessionMenu, SHOW_CHAT_GATEWAY_COST_ACTION_ID, (action, options) => {
			return action instanceof MenuItemAction ? instantiationService.createInstance(ChatGatewayCostActionViewItem, action, options, sessionResource) : undefined;
		}));
	}
}

registerWorkbenchContribution2(SessionsChatGatewayCostContribution.ID, SessionsChatGatewayCostContribution, WorkbenchPhase.BlockRestore);
