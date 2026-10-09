/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: sends a push notification (ntfy) when a chat of this agent host finishes, fails or needs
// approval; see `common/creaeditorNotifications.ts` for the settings and how the topic gets here.

import { hostname } from 'os';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { type IAgentHostChatContribution, type IAgentHostChatContributionContext } from '../../common/agentHostChatContributionsService.js';
import { AGENT_HOST_SERVER_NAME_ENV_VAR, AGENT_HOST_WEB_URL_ENV_VAR, CREAEDITOR_NOTIFICATIONS_TARGET_SERVER_SECRET_NAME, CreaEditorNotificationEvent, CreaEditorNotificationsRootKey, createNtfyRequest, ICreaEditorNotification, ICreaEditorNotificationsConfig, ICreaEditorNotificationTarget, parseNotificationTarget, readCreaEditorNotificationsConfig, shortenNotificationTitle } from '../../common/creaeditorNotifications.js';
import { parseSubagentSessionUri, SessionStatus } from '../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { AgentHostStateManager, IAgentHostStateManager } from '../agentHostStateManager.js';
import { FileSecretStore, getAgentHostSecretStore } from './fileSecretStore.js';

/** A status change is only notified when it holds this long (an approval answered at once is not). */
const DEFAULT_SETTLE_MS = 4000;
/** At most this many notifications per {@link RATE_WINDOW_MS}. */
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;
const SEND_TIMEOUT_MS = 10_000;

type ChatPhase = 'idle' | 'running' | 'needsInput' | 'failed';

function phaseOf(status: SessionStatus): ChatPhase {
	if ((status & SessionStatus.InputNeeded) === SessionStatus.InputNeeded) {
		return 'needsInput';
	}
	if (status & SessionStatus.InProgress) {
		return 'running';
	}
	if (status & SessionStatus.Error) {
		return 'failed';
	}
	return 'idle';
}

/** The event a change from `previous` to `next` stands for, if any. */
export function getNotificationEvent(previous: ChatPhase | undefined, next: ChatPhase): CreaEditorNotificationEvent | undefined {
	const wasActive = previous === 'running' || previous === 'needsInput';
	if (next === 'needsInput' && previous === 'running') {
		return 'needsInput';
	}
	if (next === 'idle' && wasActive) {
		return 'finished';
	}
	if (next === 'failed' && wasActive) {
		return 'failed';
	}
	return undefined;
}

/** Posts a request; resolves with the HTTP status. Replaced in tests: tests never reach the network. */
export type NotificationFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ readonly status: number }>;

export interface IChatNotifierOptions {
	readonly getConfig: () => ICreaEditorNotificationsConfig;
	/** The chat's title, if it has one. */
	readonly getTitle: (session: string) => string | undefined;
	readonly fetch: NotificationFetch;
	/** The machine named in the message, e.g. the server's name; undefined on the laptop. */
	readonly machineName?: string;
	readonly logService: ILogService;
	readonly now?: () => number;
	readonly settleMs?: number;
	/** `setTimeout` replacement for tests. */
	readonly setTimer?: (callback: () => void, ms: number) => { dispose(): void };
}

/**
 * Decides which status changes of chats become notifications: a chat that finished, failed or waits
 * for approval (once per change, only when the change holds for a few seconds, rate limited, and with
 * "Only When I'm Away" only when no desktop window had focus for a while).
 */
export class ChatNotifier extends Disposable {

	private readonly _phases = new Map<string, ChatPhase>();
	private readonly _pending = new Map<string, { dispose(): void }>();
	private readonly _sentAt: number[] = [];
	private readonly _now: () => number;
	private readonly _settleMs: number;
	private readonly _setTimer: (callback: () => void, ms: number) => { dispose(): void };

	constructor(private readonly _options: IChatNotifierOptions) {
		super();
		this._now = _options.now ?? Date.now;
		this._settleMs = _options.settleMs ?? DEFAULT_SETTLE_MS;
		this._setTimer = _options.setTimer ?? ((callback, ms) => {
			const handle = setTimeout(callback, ms);
			return { dispose: () => clearTimeout(handle) };
		});
		this._register(toDisposable(() => {
			for (const timer of this._pending.values()) {
				timer.dispose();
			}
			this._pending.clear();
		}));
	}

	/** Takes a session's new status. */
	onStatusChanged(session: string, status: SessionStatus): void {
		if (parseSubagentSessionUri(session)) {
			return;
		}
		const next = phaseOf(status);
		const previous = this._phases.get(session);
		if (previous === next) {
			return;
		}
		this._phases.set(session, next);
		// Any change cancels a notification that did not go out yet.
		this._pending.get(session)?.dispose();
		this._pending.delete(session);
		const event = getNotificationEvent(previous, next);
		if (!event) {
			return;
		}
		this._pending.set(session, this._setTimer(() => {
			this._pending.delete(session);
			void this._notify(session, event);
		}, this._settleMs));
	}

	/** Forgets a removed session. */
	onSessionRemoved(session: string): void {
		this._phases.delete(session);
		this._pending.get(session)?.dispose();
		this._pending.delete(session);
	}

	private async _notify(session: string, event: CreaEditorNotificationEvent): Promise<void> {
		const config = this._options.getConfig();
		if (!config.enabled || !config.events.has(event) || !config.target) {
			return;
		}
		const now = this._now();
		if (config.onlyWhenAway && config.lastActive !== undefined && now - config.lastActive < config.awayMinutes * 60_000) {
			this._options.logService.trace(`[ChatNotifications] Not notifying '${event}': a desktop window was active recently.`);
			return;
		}
		while (this._sentAt.length && now - this._sentAt[0] >= RATE_WINDOW_MS) {
			this._sentAt.shift();
		}
		if (this._sentAt.length >= RATE_LIMIT) {
			this._options.logService.warn('[ChatNotifications] Too many notifications in a minute; skipping one.');
			return;
		}
		this._sentAt.push(now);
		await this._send(config.target, this._createNotification(session, event, config.webUrl));
	}

	private _createNotification(session: string, event: CreaEditorNotificationEvent, webUrl: string | undefined): ICreaEditorNotification {
		const title = shortenNotificationTitle(this._options.getTitle(session), localize('chatNotifications.untitled', "Chat"));
		const machine = this._options.machineName;
		let message: string;
		switch (event) {
			case 'finished':
				message = machine ? localize('chatNotifications.finishedOn', "Finished on {0}.", machine) : localize('chatNotifications.finished', "Finished.");
				return { title, message, priority: 3, tags: ['white_check_mark'], ...(webUrl ? { click: webUrl } : {}) };
			case 'failed':
				message = machine ? localize('chatNotifications.failedOn', "Stopped with an error on {0}.", machine) : localize('chatNotifications.failed', "Stopped with an error.");
				return { title, message, priority: 3, tags: ['x'], ...(webUrl ? { click: webUrl } : {}) };
			case 'needsInput':
				message = machine ? localize('chatNotifications.needsInputOn', "Waits for your approval or answer on {0}.", machine) : localize('chatNotifications.needsInput', "Waits for your approval or answer.");
				return { title, message, priority: 4, tags: ['raised_hand'], ...(webUrl ? { click: webUrl } : {}) };
		}
	}

	private async _send(target: ICreaEditorNotificationTarget, notification: ICreaEditorNotification): Promise<void> {
		const request = createNtfyRequest(target, notification);
		try {
			const response = await this._options.fetch(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
			if (response.status < 200 || response.status >= 300) {
				this._options.logService.warn(`[ChatNotifications] The notification server answered ${response.status}.`);
			}
		} catch (error) {
			this._options.logService.warn(`[ChatNotifications] Could not send a notification: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

/** Posts with the global `fetch` (Node 18+). */
const globalFetch: NotificationFetch = async (url, init) => {
	const response = await fetch(url, init);
	return { status: response.status };
};

/**
 * Wires the {@link ChatNotifier} to this agent host: chat status changes from the state manager, the
 * settings from root config. On a CreaEditor Server the topic is also kept in the file secret store.
 */
export class ChatNotificationsContribution extends Disposable implements IAgentHostChatContribution {

	static readonly id = 'creaeditorChatNotifications';

	private readonly _secretStore: FileSecretStore | undefined;
	private _storedTarget: string | undefined;

	constructor(
		protected readonly _context: IAgentHostChatContributionContext,
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._secretStore = getAgentHostSecretStore();
		const machineName = this._secretStore ? (process.env[AGENT_HOST_SERVER_NAME_ENV_VAR] || hostname()) : undefined;
		const notifier = this._register(new ChatNotifier({
			getConfig: () => readCreaEditorNotificationsConfig(this._configurationService.getRootConfigValues?.()),
			getTitle: session => this._stateManager.getSessionSummary(session)?.title,
			fetch: globalFetch,
			machineName,
			logService: _logService,
		}));
		this._register(this._stateManager.onDidChangeSessionStatus(({ session, status }) => {
			if (!this._stateManager.isEphemeralSession(session)) {
				notifier.onStatusChanged(session, status);
			}
		}));
		this._register(this._stateManager.onDidRemoveSession(session => notifier.onSessionRemoved(session)));

		// The topic and the activity are transient: never written to the agent host's config file.
		this._storedTarget = this._readStoredTarget();
		const webUrl = process.env[AGENT_HOST_WEB_URL_ENV_VAR];
		this._configurationService.publishRootTransientValues?.({
			[CreaEditorNotificationsRootKey.Target]: this._storedTarget ? JSON.parse(this._storedTarget) : undefined,
			[CreaEditorNotificationsRootKey.LastActive]: undefined,
			[CreaEditorNotificationsRootKey.WebUrl]: webUrl || undefined,
		});
		if (this._secretStore) {
			this._register(this._configurationService.onDidRootConfigChange(() => this._persistTarget()));
		}
	}

	private _readStoredTarget(): string | undefined {
		try {
			const stored = this._secretStore?.get(CREAEDITOR_NOTIFICATIONS_TARGET_SERVER_SECRET_NAME);
			return stored && parseNotificationTarget(JSON.parse(stored)) ? stored : undefined;
		} catch (error) {
			this._logService.warn(`[ChatNotifications] Could not read the stored notification topic: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/** Server: keeps the topic a laptop pushed (or forgets it when the laptop turned notifications off). */
	private _persistTarget(): void {
		const values = this._configurationService.getRootConfigValues?.();
		if (!values || !this._secretStore || !(CreaEditorNotificationsRootKey.Target in values)) {
			return;
		}
		const raw = values[CreaEditorNotificationsRootKey.Target];
		if (raw === null) {
			if (this._storedTarget !== undefined) {
				this._storedTarget = undefined;
				void this._secretStore.delete(CREAEDITOR_NOTIFICATIONS_TARGET_SERVER_SECRET_NAME);
			}
			return;
		}
		const target = parseNotificationTarget(raw);
		const serialized = target ? JSON.stringify(target) : undefined;
		if (serialized && serialized !== this._storedTarget) {
			this._storedTarget = serialized;
			void this._secretStore.set(CREAEDITOR_NOTIFICATIONS_TARGET_SERVER_SECRET_NAME, serialized);
		}
	}
}
