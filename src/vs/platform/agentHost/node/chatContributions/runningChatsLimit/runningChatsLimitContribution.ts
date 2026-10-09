/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: a CreaEditor Server runs several chats at once, up to `--max-running-chats`. A chat sent
// while that many run waits in a queue (its activity reads "Queued on <server> (2 ahead)") and starts
// when another one ends. The counts are published for the Servers list. Without the limit (the
// desktop app) this does nothing.

import { hostname } from 'os';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { StopWatch } from '../../../../../base/common/stopwatch.js';
import { IInstantiationService } from '../../../../instantiation/common/instantiation.js';
import { ILogService } from '../../../../log/common/log.js';
import { localize } from '../../../../../nls.js';
import { IAgentHostChatContributions, type IAgentHostChatContribution, type IAgentHostChatContributionContext, type IIncomingRequest, type IncomingRequestDisposition, type ITurnEnd } from '../../../common/agentHostChatContributionsService.js';
import { CREAEDITOR_SERVER_CHATS_KEY, ICreaEditorServerChats } from '../../../common/creaeditorServer.js';
import { ActionType } from '../../../common/state/sessionActions.js';
import { parseSubagentSessionUri } from '../../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../../agentConfigurationService.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../../agentHostStateManager.js';
import { startTurn } from '../../agentHostTurnStarter.js';
import { AGENT_HOST_SERVER_NAME_ENV_VAR } from '../../../common/creaeditorNotifications.js';
import { AGENT_HOST_CHATS_STATUS_FILE_ENV_VAR, AGENT_HOST_MAX_RUNNING_CHATS_ENV_VAR, writeServerChatsStatus } from '../../shared/serverChatsStatus.js';

/** Reads {@link AGENT_HOST_MAX_RUNNING_CHATS_ENV_VAR}; undefined (no limit) unless it is a positive integer. */
export function readMaxRunningChats(value: string | undefined): number | undefined {
	const max = value ? Number(value) : NaN;
	return Number.isInteger(max) && max > 0 ? max : undefined;
}

/**
 * The bookkeeping of running and queued turns, without the agent host around it, so it can be
 * tested on its own.
 */
export class RunningChatsQueue<T extends { readonly turnId: string; readonly turnChannel: string }> {

	private readonly _running = new Map<string, string>();
	private readonly _queue: T[] = [];

	constructor(readonly max: number) { }

	get running(): number { return this._running.size; }
	get queued(): readonly T[] { return this._queue; }

	/** Whether `request` may run now (and counts it as running); otherwise it is queued. */
	admit(request: T): boolean {
		if (this._running.has(request.turnId)) {
			return true;
		}
		if (this._running.size < this.max && this._queue.length === 0) {
			this._running.set(request.turnId, request.turnChannel);
			return true;
		}
		this._queue.push(request);
		return false;
	}

	/**
	 * A turn ended (or was cancelled while it waited). Returns the queued requests that may run now;
	 * they count as running.
	 */
	ended(turnId: string | undefined, channel: string): T[] {
		if (turnId !== undefined) {
			this._running.delete(turnId);
		} else {
			for (const [id, runningChannel] of this._running) {
				if (runningChannel === channel) {
					this._running.delete(id);
				}
			}
		}
		const queuedIndex = this._queue.findIndex(request => turnId !== undefined ? request.turnId === turnId : request.turnChannel === channel);
		if (queuedIndex !== -1) {
			this._queue.splice(queuedIndex, 1);
		}
		const released: T[] = [];
		while (this._running.size < this.max && this._queue.length) {
			const next = this._queue.shift()!;
			this._running.set(next.turnId, next.turnChannel);
			released.push(next);
		}
		return released;
	}
}

/** Limits how many chats run at once; see the top of this file. */
export class RunningChatsLimitContribution extends Disposable implements IAgentHostChatContribution {

	static readonly id = 'creaeditorRunningChatsLimit';
	/** Last: only requests every other admission check accepted wait in the queue. */
	readonly order = 1000;

	private readonly _queue: RunningChatsQueue<IIncomingRequest> | undefined;
	private readonly _serverName: string;

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@IAgentHostChatContributions private readonly _chatContributions: IAgentHostChatContributions,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		const max = readMaxRunningChats(process.env[AGENT_HOST_MAX_RUNNING_CHATS_ENV_VAR]);
		this._queue = max ? new RunningChatsQueue<IIncomingRequest>(max) : undefined;
		this._serverName = process.env[AGENT_HOST_SERVER_NAME_ENV_VAR] || hostname();
		this._publish();
	}

	onIncomingRequest(request: IIncomingRequest): IncomingRequestDisposition | undefined {
		if (!this._queue || parseSubagentSessionUri(request.session) || this._stateManager.isEphemeralSession(request.session)) {
			return undefined;
		}
		if (this._queue.admit(request)) {
			this._publish();
			return undefined;
		}
		this._logService.info(`[RunningChatsLimit] ${this._queue.running} chats run (limit ${this._queue.max}); queued turn ${request.turnId}.`);
		this._showQueuePositions();
		this._publish();
		// The turn stays started in the chat (it shows as working) until it gets a slot.
		return { kind: 'handled' };
	}

	onTurnEnd(turn: ITurnEnd): void {
		if (!this._queue) {
			return;
		}
		const released = this._queue.ended(turn.turnId, turn.channel);
		for (const request of released) {
			this._run(request);
		}
		this._showQueuePositions();
		this._publish();
	}

	private _run(request: IIncomingRequest): void {
		const host = this._chatContributions.getHost();
		if (!host) {
			this._logService.warn('[RunningChatsLimit] Chat contribution host is not registered');
			return;
		}
		this._stateManager.dispatchServerAction(request.turnChannel, { type: ActionType.ChatActivityChanged, activity: undefined });
		const turnStopWatch = StopWatch.create(false);
		// Admission runs again; this contribution lets it through (it already counts as running).
		const started = this._instantiationService.invokeFunction(startTurn, { ...request, turnStopWatch });
		if (!started) {
			return;
		}
		host.sendTurnMessage({
			agent: started.agent,
			sessionChannel: request.session,
			turnChannel: request.turnChannel,
			chat: request.chat,
			message: request.message,
			turnId: request.turnId,
			senderClientId: request.clientId,
			clientContext: request.clientContext,
			turnStopWatch,
		});
	}

	private _showQueuePositions(): void {
		this._queue?.queued.forEach((request, ahead) => {
			this._stateManager.dispatchServerAction(request.turnChannel, {
				type: ActionType.ChatActivityChanged,
				activity: ahead === 0
					? localize('runningChatsLimit.queuedNext', "Queued on {0} (next)", this._serverName)
					: localize('runningChatsLimit.queued', "Queued on {0} ({1} ahead)", this._serverName, ahead),
			});
		});
	}

	private _publish(): void {
		if (!this._queue) {
			return;
		}
		const chats: ICreaEditorServerChats = { running: this._queue.running, queued: this._queue.queued.length, max: this._queue.max };
		this._configurationService.publishRootTransientValues?.({ [CREAEDITOR_SERVER_CHATS_KEY]: chats });
		const statusFile = process.env[AGENT_HOST_CHATS_STATUS_FILE_ENV_VAR];
		if (statusFile) {
			writeServerChatsStatus(statusFile, chats);
		}
	}
}
