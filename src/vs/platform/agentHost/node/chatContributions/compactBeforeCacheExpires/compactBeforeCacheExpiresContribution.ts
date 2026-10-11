/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: compacts an idle Claude chat shortly before its prompt cache expires, so the summary is
// made from cached (cheap) context and the next message starts small. See
// `common/creaeditorCacheCompaction.ts`. The compaction is a `/compact` turn started like any
// host-authored turn, so it runs through the Claude CLI's own `/compact`. The ids of the automatic
// compactions are kept in the chat's database, so a reloaded chat still says why it was compacted.

import { SequencerByKey } from '../../../../../base/common/async.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ILogService } from '../../../../log/common/log.js';
import { type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IDispatchedAction, type IHydrationContext, type IIncomingRequest, type IncomingRequestDisposition, type ITurnEnd } from '../../../common/agentHostChatContributionsService.js';
import { applyAutoCompactNotices, AUTO_COMPACT_BOUNDARIES_METADATA_KEY, AUTO_COMPACT_MESSAGE_META_KEY, COMPACT_COMMAND_TEXT, getAutoCompactNotice, getCompactDelayMs, ICompactBeforeCacheExpiresConfig, isAutoCompactMessage, isAutoCompactTurn, isCompactMessage, parseAutoCompactBoundaries, readCompactBeforeCacheExpiresConfig, readCompactBoundaryId, readPromptCacheUsage } from '../../../common/creaeditorCacheCompaction.js';
import { readCreaEditorServerChats } from '../../../common/creaeditorServer.js';
import { ISessionDataService } from '../../../common/sessionDataService.js';
import { ActionType, isChatAction } from '../../../common/state/sessionActions.js';
import { buildDefaultChatUri, chatStorageUri, isAhpChatChannel, isChatReadOnly, isDefaultChatUri, isSubagentChatUri, MessageKind, parseRequiredSessionUriFromChatUri, SessionStatus, TurnState, withMessageSystemInitiatedLabel, type Message, type Turn, type UsageInfo } from '../../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../../agentConfigurationService.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../agentHostStateManager.js';
import { IAgentHostTurnService } from '../../agentHostTurnService.js';
import { ISessionWorkspaceConversionService } from '../sessionWorkspaceConversion/sessionWorkspaceConversionService.js';

/** What {@link IdleCompactionScheduler} needs from the agent host. */
export interface IIdleCompactionSchedulerOptions {
	readonly getConfig: () => ICompactBeforeCacheExpiresConfig;
	/** Whether the chat may be compacted now: idle since the turn `turnId` ended, nothing waiting. */
	readonly canCompact: (channel: string, turnId: string) => boolean;
	/** Starts the `/compact` turn. */
	readonly compact: (channel: string) => void;
	readonly logService: ILogService;
	/** `setTimeout` replacement for tests. */
	readonly setTimer?: (callback: () => void, ms: number) => IDisposable;
}

/** One pending compaction of a chat. */
interface IScheduledCompaction {
	readonly session: string;
	readonly turnId: string;
	readonly timer: IDisposable;
}

/**
 * Decides when an idle chat is compacted: when a turn ended with enough context in the prompt cache,
 * a timer runs to shortly before the cache expires. A new turn or the chat going away cancel it, and
 * with the setting turned off it does nothing; the compaction itself and a `/compact` the user sent schedule nothing, so a
 * chat is compacted at most once per idle period.
 */
export class IdleCompactionScheduler extends Disposable {

	private readonly _scheduled = new Map<string, IScheduledCompaction>();
	private readonly _setTimer: (callback: () => void, ms: number) => IDisposable;

	constructor(private readonly _options: IIdleCompactionSchedulerOptions) {
		super();
		this._setTimer = _options.setTimer ?? ((callback, ms) => {
			const handle = setTimeout(callback, ms);
			return toDisposable(() => clearTimeout(handle));
		});
		this._register(toDisposable(() => this.cancelAll()));
	}

	/** Channels with a compaction scheduled (for tests). */
	get scheduledChannels(): readonly string[] {
		return [...this._scheduled.keys()];
	}

	/** A turn of `channel` ended successfully; schedules its compaction when it qualifies. */
	onTurnSucceeded(session: string, channel: string, turnId: string, message: Message | undefined, usage: UsageInfo | undefined): void {
		this.cancel(channel);
		const config = this._options.getConfig();
		if (!config.enabled || isCompactMessage(message)) {
			return;
		}
		const cache = readPromptCacheUsage(usage);
		if (!cache || cache.contextTokens < config.minTokens) {
			return;
		}
		const delay = getCompactDelayMs(cache.ttlSeconds);
		const timer = this._setTimer(() => this._fire(channel, turnId), delay);
		this._scheduled.set(channel, { session, turnId, timer });
		this._options.logService.trace(`[CompactBeforeCacheExpires] Compacting ${channel} in ${Math.round(delay / 1000)}s (${cache.contextTokens} tokens, ${cache.ttlSeconds}s cache).`);
	}

	cancel(channel: string): void {
		const scheduled = this._scheduled.get(channel);
		if (scheduled) {
			scheduled.timer.dispose();
			this._scheduled.delete(channel);
		}
	}

	cancelSession(session: string): void {
		for (const [channel, scheduled] of [...this._scheduled]) {
			if (scheduled.session === session) {
				this.cancel(channel);
			}
		}
	}

	cancelAll(): void {
		for (const channel of [...this._scheduled.keys()]) {
			this.cancel(channel);
		}
	}

	private _fire(channel: string, turnId: string): void {
		this._scheduled.delete(channel);
		if (!this._options.getConfig().enabled) {
			return;
		}
		if (!this._options.canCompact(channel, turnId)) {
			this._options.logService.trace(`[CompactBeforeCacheExpires] Not compacting ${channel}: it is busy, waiting or locked.`);
			return;
		}
		this._options.logService.info(`[CompactBeforeCacheExpires] Compacting ${channel} before its prompt cache expires.`);
		this._options.compact(channel);
	}
}

/**
 * Whether every running turn of `session` is an automatic compaction (and one runs): such a run is
 * not the user's work, so it neither notifies nor marks the chat unread.
 */
export function isOnlyAutoCompactRunning(stateManager: AgentHostStateManager, session: string): boolean {
	const state = stateManager.getSessionState(session);
	if (!state) {
		return false;
	}
	const chats = new Set([buildDefaultChatUri(session), ...state.chats.map(chat => chat.resource)]);
	let running = 0;
	for (const chat of chats) {
		const activeTurn = stateManager.getChatState(chat)?.activeTurn;
		if (!activeTurn) {
			continue;
		}
		if (!isAutoCompactMessage(activeTurn.message)) {
			return false;
		}
		running++;
	}
	return running > 0;
}

/** Wires {@link IdleCompactionScheduler} to the agent host. */
export class CompactBeforeCacheExpiresContribution extends Disposable implements IAgentHostChatContribution {

	static readonly id = 'creaeditorCompactBeforeCacheExpires';
	/** After the read-only and archive checks (a refused request changes nothing), before the running chats limit. */
	readonly order = 800;

	private readonly _scheduler: IdleCompactionScheduler;
	/** Serializes the read-modify-write of a chat's {@link AUTO_COMPACT_BOUNDARIES_METADATA_KEY}. */
	private readonly _boundaryWrites = new SequencerByKey<string>();

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@IAgentHostTurnService private readonly _turnService: IAgentHostTurnService,
		@ISessionWorkspaceConversionService private readonly _conversionService: ISessionWorkspaceConversionService,
		@ISessionDataService private readonly _sessionDataService: ISessionDataService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._scheduler = this._register(new IdleCompactionScheduler({
			getConfig: () => this._getConfig(),
			canCompact: (channel, turnId) => this._canCompact(channel, turnId),
			compact: channel => this._compact(channel),
			logService: _logService,
		}));
		// The setting turned off cancels too: a due compaction reads it again and does nothing.
		this._register(this._stateManager.onDidRemoveSession(session => this._scheduler.cancelSession(session)));
	}

	onIncomingRequest(request: IIncomingRequest): IncomingRequestDisposition | undefined {
		// A new turn: the chat is not idle any more.
		this._scheduler.cancel(request.turnChannel);
		return undefined;
	}

	onTurnEnd(turn: ITurnEnd): void {
		if (turn.reason.kind !== 'success' || turn.turnId === undefined || isSubagentChatUri(turn.channel) || this._stateManager.isEphemeralSession(turn.session)) {
			return;
		}
		const ended = this._stateManager.getChatState(turn.channel)?.turns.at(-1);
		if (ended?.id !== turn.turnId) {
			return;
		}
		this._scheduler.onTurnSucceeded(turn.session, turn.channel, turn.turnId, ended.message, ended.usage);
	}

	onDidDispatchAction(dispatched: IDispatchedAction): void {
		const { channel, action } = dispatched;
		if (dispatched.rejectionReason !== undefined || !isAhpChatChannel(channel) || !isChatAction(action) || action.type !== ActionType.ChatResponsePart || isSubagentChatUri(channel)) {
			return;
		}
		const boundaryId = readCompactBoundaryId(action.part);
		if (boundaryId && isAutoCompactTurn(this._stateManager.getChatState(channel), action.turnId)) {
			this._recordAutoCompaction(channel, boundaryId);
		}
	}

	/** A reloaded chat: the notifications of its automatic compactions get their own text again. */
	async onHydrateTurns(context: IHydrationContext, turns: readonly Turn[]): Promise<readonly Turn[]> {
		const storage = chatStorageUri(context.chat);
		if (!storage || !turns.some(turn => turn.responseParts.some(part => readCompactBoundaryId(part) !== undefined))) {
			return turns;
		}
		const ref = await this._sessionDataService.tryOpenDatabase(storage);
		if (!ref) {
			return turns;
		}
		try {
			const boundaryIds = parseAutoCompactBoundaries(await ref.object.getMetadata(AUTO_COMPACT_BOUNDARIES_METADATA_KEY));
			return applyAutoCompactNotices(turns, new Set(boundaryIds));
		} finally {
			ref.dispose();
		}
	}

	private _recordAutoCompaction(channel: string, boundaryId: string): void {
		const storage = chatStorageUri(channel);
		if (!storage) {
			return;
		}
		this._boundaryWrites.queue(storage.toString(), async () => {
			const ref = this._sessionDataService.openDatabase(storage);
			try {
				const boundaryIds = parseAutoCompactBoundaries(await ref.object.getMetadata(AUTO_COMPACT_BOUNDARIES_METADATA_KEY));
				if (!boundaryIds.includes(boundaryId)) {
					await ref.object.setMetadata(AUTO_COMPACT_BOUNDARIES_METADATA_KEY, JSON.stringify([...boundaryIds, boundaryId]));
				}
			} finally {
				ref.dispose();
			}
		}).catch(error => this._logService.warn(`[CompactBeforeCacheExpires] Could not record the automatic compaction of ${channel}: ${error instanceof Error ? error.message : String(error)}`));
	}

	private _getConfig(): ICompactBeforeCacheExpiresConfig {
		return readCompactBeforeCacheExpiresConfig(this._configurationService.getRootConfigValues?.());
	}

	private _canCompact(channel: string, turnId: string): boolean {
		const chat = this._stateManager.getChatState(channel);
		const latest = chat?.turns.at(-1);
		if (!chat || chat.activeTurn || latest?.id !== turnId || latest.state !== TurnState.Complete || chat.queuedMessages?.length || chat.steeringMessage) {
			return false;
		}
		if (this._conversionService.isPending(channel)) {
			return false;
		}
		const session = parseRequiredSessionUriFromChatUri(channel);
		const sessionStatus = this._stateManager.getSessionSummary(session)?.status ?? 0;
		if ((sessionStatus & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) {
			return false;
		}
		// A delegated chat is archived (and locked) on this machine while it runs on a server.
		const sessionArchived = (sessionStatus & SessionStatus.IsArchived) === SessionStatus.IsArchived;
		const chatArchived = !isDefaultChatUri(channel) && (chat.status & SessionStatus.IsArchived) === SessionStatus.IsArchived;
		if (sessionArchived || chatArchived || isChatReadOnly(chat.interactivity, false)) {
			return false;
		}
		// On a CreaEditor Server at its running chats limit the compaction would wait in the queue,
		// before the user's own chats: skip it.
		const serverChats = readCreaEditorServerChats(this._configurationService.getRootConfigValues?.());
		if (serverChats && (serverChats.running >= serverChats.max || serverChats.queued > 0)) {
			return false;
		}
		return true;
	}

	private _compact(channel: string): void {
		const previous = this._stateManager.getChatState(channel)?.turns.at(-1)?.message;
		const message = withMessageSystemInitiatedLabel({
			text: COMPACT_COMMAND_TEXT,
			origin: { kind: MessageKind.SystemNotification },
			// Keep the chat's model and agent: a message without them runs on the defaults.
			...(previous?.model ? { model: previous.model } : {}),
			...(previous?.agent ? { agent: previous.agent } : {}),
			_meta: { [AUTO_COMPACT_MESSAGE_META_KEY]: true },
		}, getAutoCompactNotice());
		try {
			this._turnService.startTurnMessage(URI.parse(channel), message);
		} catch (error) {
			this._logService.warn(`[CompactBeforeCacheExpires] Could not compact ${channel}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
