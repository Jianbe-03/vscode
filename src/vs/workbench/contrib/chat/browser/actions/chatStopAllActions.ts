/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: "Stop All Chats" cancels every running request of this window: the chat view, chat
// editors, the chats of the Agents window and agent host (Claude, Codex, Copilot) sessions that are
// running but not open. It asks first when more than one chat runs.

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { isAgentHostTarget, isSessionInProgressStatus, type ChatSessionStatus } from '../../common/chatSessionsService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { IAgentSessionsService } from '../agentSessions/agentSessionsService.js';
import { CHAT_CATEGORY } from './chatActions.js';

export const STOP_ALL_CHATS_COMMAND_ID = 'workbench.action.chat.stopAllChats';

/** Whether a chat of this window, or an agent host session, has a request running. */
export const ChatHasRunningChatsContext = new RawContextKey<boolean>('chatHasRunningChats', false, { type: 'boolean', description: localize('chatHasRunningChats', "True when any chat has a request running.") });

export const stopAllChatsIcon = registerIcon('chat-stop-all-chats', Codicon.debugStop, localize('chatStopAllChatsIcon', "Icon of the Stop All Chats action."));

/** A chat with a request running: loaded in this window, or an agent session that runs without being open. */
export interface IRunningChat {
	readonly resource: URI;
	/** Whether its chat model is loaded in this window, so its request can be cancelled right away. */
	readonly loaded: boolean;
}

/**
 * The running chats, each once: the loaded chat models with a request in progress, then the agent
 * host sessions that report a running (or waiting for input) status but are not loaded here.
 */
export function getRunningChats(
	models: Iterable<{ readonly sessionResource: URI; readonly requestInProgress: { get(): boolean } }>,
	agentSessions: Iterable<{ readonly resource: URI; readonly providerType: string; readonly status: ChatSessionStatus }>,
): IRunningChat[] {
	const running: IRunningChat[] = [];
	const loaded = new Set<string>();
	for (const model of models) {
		loaded.add(model.sessionResource.toString());
		if (model.requestInProgress.get()) {
			running.push({ resource: model.sessionResource, loaded: true });
		}
	}
	for (const session of agentSessions) {
		const key = session.resource.toString();
		if (!loaded.has(key) && isAgentHostTarget(session.providerType) && isSessionInProgressStatus(session.status)) {
			loaded.add(key);
			running.push({ resource: session.resource, loaded: false });
		}
	}
	return running;
}

class StopAllChatsAction extends Action2 {
	constructor() {
		super({
			id: STOP_ALL_CHATS_COMMAND_ID,
			title: localize2('chat.stopAllChats', "Stop All Chats"),
			category: CHAT_CATEGORY,
			icon: stopAllChatsIcon,
			f1: true,
			// The Agents window adds it to its Sessions header (see the agents tree contribution).
			precondition: ChatHasRunningChatsContext,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const chatService = accessor.get(IChatService);
		const agentSessionsService = accessor.get(IAgentSessionsService);
		const dialogService = accessor.get(IDialogService);
		const logService = accessor.get(ILogService);
		const running = getRunningChats(chatService.chatModels.get(), agentSessionsService.model.sessions);
		if (!running.length) {
			return;
		}
		if (running.length > 1) {
			const { confirmed } = await dialogService.confirm({
				message: localize('chat.stopAllChats.confirm', "Stop {0} running chats?", running.length),
				detail: localize('chat.stopAllChats.confirmDetail', "Every running request is cancelled. The chats keep what they did so far."),
				primaryButton: localize({ key: 'chat.stopAllChats.confirmButton', comment: ['&& denotes a mnemonic'] }, "&&Stop All"),
			});
			if (!confirmed) {
				return;
			}
		}
		await Promise.all(running.map(async chat => {
			try {
				if (chat.loaded) {
					await chatService.cancelCurrentRequestForSession(chat.resource, 'stopAllChats');
					return;
				}
				// A running session that is not open here has no request tracked in this window: loading its model re-establishes it.
				const reference = await chatService.acquireOrLoadSession(chat.resource, ChatAgentLocation.Chat, CancellationToken.None, 'stopAllChats');
				try {
					await chatService.cancelCurrentRequestForSession(chat.resource, 'stopAllChats');
				} finally {
					reference?.dispose();
				}
			} catch (error) {
				logService.warn(`[StopAllChats] Could not stop ${chat.resource.toString()}`, error);
			}
		}));
	}
}
registerAction2(StopAllChatsAction);

/** Keeps {@link ChatHasRunningChatsContext} current. */
class RunningChatsContextKeyContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatRunningChatsContextKey';

	constructor(
		@IChatService chatService: IChatService,
		@IAgentSessionsService agentSessionsService: IAgentSessionsService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		const key = ChatHasRunningChatsContext.bindTo(contextKeyService);
		const agentSessionsChanged = observableSignalFromEvent(this, agentSessionsService.model.onDidChangeSessions);
		this._register(autorun(reader => {
			agentSessionsChanged.read(reader);
			const models = [...chatService.chatModels.read(reader)];
			// Read every model's state so the key follows each request starting and ending.
			const anyLoadedRunning = models.map(model => model.requestInProgress.read(reader)).some(Boolean);
			key.set(anyLoadedRunning || getRunningChats(models, agentSessionsService.model.sessions).length > 0);
		}));
	}
}

registerWorkbenchContribution2(RunningChatsContextKeyContribution.ID, RunningChatsContextKeyContribution, WorkbenchPhase.AfterRestored);
