/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: "Stop All Chats" cancels every running request in every window: the chat view, chat
// editors, the chats of the Agents window and agent host (Claude, Codex, Copilot) sessions that are
// running but not open. Each window publishes the chats it runs in application storage, so every window
// knows whether anything runs anywhere, and a stop request in application storage reaches the others.
// It asks first when more than one chat runs.

import { IntervalTimer } from '../../../../../base/common/async.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { isAgentHostTarget, isSessionInProgressStatus, type ChatSessionStatus } from '../../common/chatSessionsService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { IAgentSessionsService } from '../agentSessions/agentSessionsService.js';
import { CHAT_CATEGORY } from './chatActions.js';

export const STOP_ALL_CHATS_COMMAND_ID = 'workbench.action.chat.stopAllChats';

/** Whether a chat of any window, or an agent host session, has a request running. */
export const ChatHasRunningChatsContext = new RawContextKey<boolean>('chatHasRunningChats', false, { type: 'boolean', description: localize('chatHasRunningChats', "True when any chat has a request running.") });

export const stopAllChatsIcon = registerIcon('chat-stop-all-chats', Codicon.debugStop, localize('chatStopAllChatsIcon', "Icon of the Stop All Chats action."));

/** Application storage: the running chats of each window, by window instance id ({@link IWindowRunningChats}). */
const RUNNING_CHATS_STORAGE_KEY = 'chat.stopAllChats.runningByWindow';
/** Application storage: changes to a new id each time a window asks every other window to stop its chats. */
const STOP_REQUEST_STORAGE_KEY = 'chat.stopAllChats.stopRequest';
/** How often a window with running chats refreshes its entry. */
const HEARTBEAT_INTERVAL = 20 * 1000;
/** After this long without a refresh an entry is ignored: its window closed without removing it. */
const ENTRY_EXPIRY = 3 * HEARTBEAT_INTERVAL;

/** Identifies this window's entry in {@link RUNNING_CHATS_STORAGE_KEY}. */
const windowInstanceId = generateUuid();

/** The running chats one window published. */
interface IWindowRunningChats {
	readonly resources: readonly string[];
	/** When the window last published, in milliseconds since the epoch. */
	readonly updated: number;
}

type RunningChatsByWindow = Record<string, IWindowRunningChats>;

/** A chat with a request running: loaded in this window, or an agent session that runs without being open. */
export interface IRunningChat {
	readonly resource: URI;
	/** Whether its chat model is loaded in this window, so its request can be cancelled right away. */
	readonly loaded: boolean;
}

/**
 * The running chats of this window, each once: the loaded chat models with a request in progress or
 * waiting for input, then the agent host sessions that report a running (or waiting for input) status
 * but are not loaded here. The agent host is shared by all windows, so any window can stop those.
 * Local sessions listed but not loaded here run in another window, which publishes them itself.
 */
export function getRunningChats(
	models: Iterable<{ readonly sessionResource: URI; readonly requestInProgress: { get(): boolean }; readonly requestNeedsInput: { get(): unknown } }>,
	agentSessions: Iterable<{ readonly resource: URI; readonly providerType: string; readonly status: ChatSessionStatus; isArchived(): boolean }>,
): IRunningChat[] {
	const running: IRunningChat[] = [];
	const loaded = new Set<string>();
	for (const model of models) {
		loaded.add(model.sessionResource.toString());
		if (model.requestInProgress.get() || model.requestNeedsInput.get()) {
			running.push({ resource: model.sessionResource, loaded: true });
		}
	}
	for (const session of agentSessions) {
		const key = session.resource.toString();
		if (!loaded.has(key) && isAgentHostTarget(session.providerType) && isSessionInProgressStatus(session.status) && !session.isArchived()) {
			loaded.add(key);
			running.push({ resource: session.resource, loaded: false });
		}
	}
	return running;
}

function parseRunningChatsByWindow(raw: string | undefined): RunningChatsByWindow {
	if (!raw) {
		return {};
	}
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * The resources of the chats the other windows published as running, each once, leaving out entries
 * that were not refreshed for {@link ENTRY_EXPIRY}.
 */
export function getRunningChatsOfOtherWindows(raw: string | undefined, selfId: string, now: number): string[] {
	const resources = new Set<string>();
	for (const [id, entry] of Object.entries(parseRunningChatsByWindow(raw))) {
		if (id === selfId || !entry || !Array.isArray(entry.resources) || typeof entry.updated !== 'number' || now - entry.updated > ENTRY_EXPIRY) {
			continue;
		}
		for (const resource of entry.resources) {
			if (typeof resource === 'string') {
				resources.add(resource);
			}
		}
	}
	return [...resources];
}

/**
 * Returns the stored value with this window's entry replaced by `resources` (removed when empty), and
 * entries that expired dropped. Returns `undefined` when nothing is left.
 */
export function updateRunningChatsOfWindow(raw: string | undefined, selfId: string, resources: readonly string[], now: number): string | undefined {
	const next: RunningChatsByWindow = {};
	for (const [id, entry] of Object.entries(parseRunningChatsByWindow(raw))) {
		if (id !== selfId && entry && typeof entry.updated === 'number' && now - entry.updated <= ENTRY_EXPIRY) {
			next[id] = entry;
		}
	}
	if (resources.length) {
		next[selfId] = { resources, updated: now };
	}
	return Object.keys(next).length ? JSON.stringify(next) : undefined;
}

/** Clears the queued messages of each chat, so none starts once its request stops, then cancels its request. */
async function stopChats(chatService: IChatService, logService: ILogService, chats: readonly IRunningChat[]): Promise<void> {
	await Promise.all(chats.map(async chat => {
		try {
			if (chat.loaded) {
				chatService.setPendingRequests(chat.resource, []);
				await chatService.cancelCurrentRequestForSession(chat.resource, 'stopAllChats');
				return;
			}
			// A running session that is not open here has no request tracked in this window: loading its model re-establishes it.
			const reference = await chatService.acquireOrLoadSession(chat.resource, ChatAgentLocation.Chat, CancellationToken.None, 'stopAllChats');
			try {
				chatService.setPendingRequests(chat.resource, []);
				await chatService.cancelCurrentRequestForSession(chat.resource, 'stopAllChats');
			} finally {
				reference?.dispose();
			}
		} catch (error) {
			logService.warn(`[StopAllChats] Could not stop ${chat.resource.toString()}`, error);
		}
	}));
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
		const storageService = accessor.get(IStorageService);

		const running = getRunningChats(chatService.chatModels.get(), agentSessionsService.model.sessions);
		const elsewhere = getRunningChatsOfOtherWindows(storageService.get(RUNNING_CHATS_STORAGE_KEY, StorageScope.APPLICATION), windowInstanceId, Date.now());
		const total = new Set([...running.map(chat => chat.resource.toString()), ...elsewhere]).size;
		logService.info(`[StopAllChats] ${running.length} running in this window, ${elsewhere.length} in other windows`);
		if (!total) {
			return;
		}
		if (total > 1) {
			const { confirmed } = await dialogService.confirm({
				message: localize('chat.stopAllChats.confirm', "Stop {0} running chats?", total),
				detail: localize('chat.stopAllChats.confirmDetail', "Every running request is cancelled in every window, and queued messages are dropped. The chats keep what they did so far."),
				primaryButton: localize({ key: 'chat.stopAllChats.confirmButton', comment: ['&& denotes a mnemonic'] }, "&&Stop All"),
			});
			if (!confirmed) {
				return;
			}
		}
		if (elsewhere.length) {
			// The other windows stop their own chats when this value changes (see RunningChatsContribution).
			storageService.store(STOP_REQUEST_STORAGE_KEY, generateUuid(), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		// Read again: the list may have changed while the confirmation was open.
		await stopChats(chatService, logService, getRunningChats(chatService.chatModels.get(), agentSessionsService.model.sessions));
	}
}
registerAction2(StopAllChatsAction);

/**
 * Publishes the running chats of this window to the other windows, keeps {@link ChatHasRunningChatsContext}
 * current for all windows, and stops this window's chats when another window runs Stop All Chats.
 */
class RunningChatsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatRunningChatsContextKey';

	private readonly hasRunningChatsKey: IContextKey<boolean>;
	private ownRunning: readonly string[] = [];
	private readonly heartbeat = this._register(new IntervalTimer());
	private heartbeatRunning = false;

	constructor(
		@IChatService private readonly chatService: IChatService,
		@IAgentSessionsService agentSessionsService: IAgentSessionsService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		this.hasRunningChatsKey = ChatHasRunningChatsContext.bindTo(contextKeyService);

		const agentSessionsChanged = observableSignalFromEvent(this, agentSessionsService.model.onDidChangeSessions);
		this._register(autorun(reader => {
			agentSessionsChanged.read(reader);
			const models = [...chatService.chatModels.read(reader)];
			// Read every model's state so this follows each request starting and ending.
			for (const model of models) {
				model.requestInProgress.read(reader);
				model.requestNeedsInput.read(reader);
			}
			const resources = getRunningChats(models, agentSessionsService.model.sessions).map(chat => chat.resource.toString()).sort();
			if (resources.join('\n') !== this.ownRunning.join('\n')) {
				this.ownRunning = resources;
				this.publish();
			}
			this.update();
		}));

		const storageListeners = this._register(new DisposableStore());
		this._register(storageService.onDidChangeValue(StorageScope.APPLICATION, RUNNING_CHATS_STORAGE_KEY, storageListeners)(e => {
			if (e.external) {
				this.update();
			}
		}));
		this._register(storageService.onDidChangeValue(StorageScope.APPLICATION, STOP_REQUEST_STORAGE_KEY, storageListeners)(e => {
			if (e.external) {
				this.stopOwnChats();
			}
		}));

		this._register(lifecycleService.onWillShutdown(() => {
			this.ownRunning = [];
			this.publish();
		}));
	}

	/** Writes this window's running chats to application storage. */
	private publish(): void {
		const value = updateRunningChatsOfWindow(this.storageService.get(RUNNING_CHATS_STORAGE_KEY, StorageScope.APPLICATION), windowInstanceId, this.ownRunning, Date.now());
		if (value === undefined) {
			this.storageService.remove(RUNNING_CHATS_STORAGE_KEY, StorageScope.APPLICATION);
		} else {
			this.storageService.store(RUNNING_CHATS_STORAGE_KEY, value, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	/** Sets the context key, and keeps a timer while anything runs to refresh this window's entry and let expired entries go. */
	private update(): void {
		const elsewhere = getRunningChatsOfOtherWindows(this.storageService.get(RUNNING_CHATS_STORAGE_KEY, StorageScope.APPLICATION), windowInstanceId, Date.now());
		const anyRunning = this.ownRunning.length > 0 || elsewhere.length > 0;
		this.hasRunningChatsKey.set(anyRunning);
		if (anyRunning) {
			if (!this.heartbeatRunning) {
				this.heartbeatRunning = true;
				this.heartbeat.cancelAndSet(() => {
					if (this.ownRunning.length) {
						this.publish();
					}
					this.update();
				}, HEARTBEAT_INTERVAL);
			}
		} else if (this.heartbeatRunning) {
			this.heartbeatRunning = false;
			this.heartbeat.cancel();
		}
	}

	/** Another window ran Stop All Chats: stop the chats loaded here. That window stops the agent host sessions not loaded anywhere. */
	private async stopOwnChats(): Promise<void> {
		const running = getRunningChats(this.chatService.chatModels.get(), []).filter(chat => chat.loaded);
		this.logService.info(`[StopAllChats] Another window stops all chats: stopping ${running.length} here`);
		await stopChats(this.chatService, this.logService, running);
	}
}

registerWorkbenchContribution2(RunningChatsContribution.ID, RunningChatsContribution, WorkbenchPhase.AfterRestored);
