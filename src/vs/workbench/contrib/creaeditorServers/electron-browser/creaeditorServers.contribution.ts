/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: Add CreaEditor Server and Delegate to Server from the editor window (and the CreaEditor
// Features walkthrough). CreaEditor Servers live in the Agents window: this opens it and asks it to
// start the flow.

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { CREAEDITOR_DELEGATE_REQUEST_KEY, CREAEDITOR_OPEN_DELEGATE_TO_SERVER_COMMAND_ID, IDelegateToServerRequest } from '../../../../platform/agentHost/common/creaeditorDelegation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { CREAEDITOR_SERVERS_ADD_REQUEST_KEY, OPEN_ADD_CREAEDITOR_SERVER_COMMAND_ID } from '../../../../platform/agentHost/common/creaeditorServer.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IsSessionsWindowContext } from '../../../common/contextkeys.js';
import { OPEN_AGENTS_WINDOW_COMMAND_ID } from '../../chat/common/constants.js';

registerAction2(class OpenAddCreaEditorServerAction extends Action2 {
	constructor() {
		super({
			id: OPEN_ADD_CREAEDITOR_SERVER_COMMAND_ID,
			title: localize2('creaeditorServers.openAdd', "Add CreaEditor Server..."),
			icon: Codicon.server,
			precondition: IsSessionsWindowContext.toNegated(),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		const commandService = accessor.get(ICommandService);
		// The Agents window starts Add CreaEditor Server when it sees this (now, or when it opens).
		storageService.store(CREAEDITOR_SERVERS_ADD_REQUEST_KEY, Date.now(), StorageScope.APPLICATION, StorageTarget.MACHINE);
		await commandService.executeCommand(OPEN_AGENTS_WINDOW_COMMAND_ID);
	}
});

registerAction2(class OpenDelegateToServerAction extends Action2 {
	constructor() {
		super({
			id: CREAEDITOR_OPEN_DELEGATE_TO_SERVER_COMMAND_ID,
			title: localize2('creaeditorServers.openDelegate', "Delegate to Server..."),
			category: localize2('creaeditorServers.chatCategory', "Chat"),
			icon: Codicon.server,
			precondition: IsSessionsWindowContext.toNegated(),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const storageService = accessor.get(IStorageService);
		const commandService = accessor.get(ICommandService);
		const sessionResource = accessor.get(IChatWidgetService).lastFocusedWidget?.viewModel?.sessionResource;
		if (!sessionResource) {
			accessor.get(INotificationService).info(localize('creaeditorServers.delegateNoChat', "Open the chat to delegate first."));
			return;
		}
		// The Agents window delegates this chat when it sees the request (now, or when it opens).
		const request: IDelegateToServerRequest = { sessionResource: sessionResource.toString(), requestedAt: Date.now() };
		storageService.store(CREAEDITOR_DELEGATE_REQUEST_KEY, JSON.stringify(request), StorageScope.APPLICATION, StorageTarget.MACHINE);
		await commandService.executeCommand(OPEN_AGENTS_WINDOW_COMMAND_ID);
	}
});
