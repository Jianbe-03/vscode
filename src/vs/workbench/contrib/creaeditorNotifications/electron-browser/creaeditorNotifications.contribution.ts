/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: push notifications to the phone (ntfy) when a chat finishes, fails or needs approval, on
// this computer and on CreaEditor Servers. The agent hosts send them (see
// `platform/agentHost/common/creaeditorNotifications.ts`); this window provides the settings, Set Up
// Notifications, and pushes the topic (from secret storage), when a desktop window was last used and
// the Remote Access address to every agent host it is connected to.

import { IntervalTimer } from '../../../../base/common/async.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAgentConnection, IAgentHostService } from '../../../../platform/agentHost/common/agentService.js';
import { CREAEDITOR_NOTIFICATION_EVENTS, CREAEDITOR_NOTIFICATIONS_DEFAULT_AWAY_MINUTES, CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY, CreaEditorNotificationsRootKey, ICreaEditorNotificationTarget, parseNotificationTarget } from '../../../../platform/agentHost/common/creaeditorNotifications.js';
import { IRemoteAccessService, RemoteAccessState } from '../../../../platform/agentHost/common/remoteAccess.js';
import { IRemoteAgentHostService } from '../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ActionType } from '../../../../platform/agentHost/common/state/protocol/actions.js';
import { ROOT_STATE_URI } from '../../../../platform/agentHost/common/state/sessionState.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IHostService } from '../../../services/host/browser/host.js';
import './creaeditorNotificationsSetup.js';

/** While a window has focus, how often it tells the agent hosts the user is here. */
const ACTIVE_PING_MS = 2 * 60_000;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'creaeditor.notifications',
	title: localize('creaeditorNotifications.title', "Notifications on Your Phone"),
	type: 'object',
	properties: {
		[CreaEditorNotificationsRootKey.Enabled]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('creaeditorNotifications.enabled', "Send a push notification to your phone (with the ntfy app) when a chat finishes, fails or needs your approval, for chats on this computer and on your CreaEditor Servers. Run **Set Up Notifications** to choose the topic."),
			agentHost: { key: CreaEditorNotificationsRootKey.Enabled },
		},
		[CreaEditorNotificationsRootKey.Events]: {
			type: 'array',
			items: { type: 'string', enum: [...CREAEDITOR_NOTIFICATION_EVENTS] },
			uniqueItems: true,
			default: [...CREAEDITOR_NOTIFICATION_EVENTS],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('creaeditorNotifications.events', "Which events send a notification: `finished` (a chat is done), `failed` (it stopped with an error) and `needsInput` (it waits for your approval or an answer)."),
			agentHost: { key: CreaEditorNotificationsRootKey.Events },
		},
		[CreaEditorNotificationsRootKey.OnlyWhenAway]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('creaeditorNotifications.onlyWhenAway', "Only notify when you are away: no CreaEditor window on a computer had focus for `#creaeditor.notifications.awayMinutes#` minutes."),
			agentHost: { key: CreaEditorNotificationsRootKey.OnlyWhenAway },
		},
		[CreaEditorNotificationsRootKey.AwayMinutes]: {
			type: 'number',
			minimum: 0,
			default: CREAEDITOR_NOTIFICATIONS_DEFAULT_AWAY_MINUTES,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('creaeditorNotifications.awayMinutes', "With `#creaeditor.notifications.onlyWhenAway#`, how many minutes without a focused CreaEditor window count as away."),
			agentHost: { key: CreaEditorNotificationsRootKey.AwayMinutes },
		},
	},
});

/**
 * Pushes the transient notification values to the local agent host and to every connected remote
 * agent host (CreaEditor Servers): the topic, when a window here last had focus, and (local only) the
 * Remote Access address a notification opens.
 */
class CreaEditorNotificationsForwarder extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.creaeditorNotificationsForwarder';

	/** Undefined: never set up (nothing to push); null: turned off (hosts forget it). */
	private _target: ICreaEditorNotificationTarget | null | undefined;
	private _lastActive: number | undefined;
	/** Undefined until known; null while Remote Access is off. */
	private _webUrl: string | null | undefined;
	private readonly _remoteListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _activeTimer = this._register(new IntervalTimer());

	constructor(
		@IAgentHostService private readonly _agentHostService: IAgentHostService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@IHostService private readonly _hostService: IHostService,
		@IRemoteAccessService private readonly _remoteAccessService: IRemoteAccessService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._agentHostService.onAgentHostStart(() => this._sync(this._agentHostService, true)));
		this._register(this._agentHostService.rootState.onDidChange(() => this._sync(this._agentHostService, true)));
		this._register(this._remoteAgentHostService.onDidChangeConnections(() => this._watchRemotes()));
		this._register(this._secretStorageService.onDidChangeSecret(key => {
			if (key === CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY) {
				void this._loadTarget(true);
			}
		}));
		this._register(this._hostService.onDidChangeFocus(focused => this._onFocus(focused)));
		this._register(this._remoteAccessService.onDidChangeStatus(status => this._setWebUrl(status.state === RemoteAccessState.On ? status.publicUrl ?? status.magicDnsUrl ?? status.url : undefined)));
		this._remoteAccessService.getStatus().then(status => this._setWebUrl(status.state === RemoteAccessState.On ? status.publicUrl ?? status.magicDnsUrl ?? status.url : undefined), () => undefined);
		this._watchRemotes();
		this._onFocus(this._hostService.hasFocus);
		void this._loadTarget(false);
	}

	private async _loadTarget(changed: boolean): Promise<void> {
		let raw: string | undefined;
		try {
			raw = await this._secretStorageService.get(CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY);
		} catch (error) {
			this._logService.warn('[CreaEditor Notifications] Could not read the notification topic', error);
			return;
		}
		let target: ICreaEditorNotificationTarget | undefined;
		try {
			target = raw ? parseNotificationTarget(JSON.parse(raw)) : undefined;
		} catch {
			target = undefined;
		}
		// Removed while this window runs: tell the hosts to forget it; never set: push nothing.
		this._target = target ?? (changed ? null : undefined);
		this._syncAll();
	}

	private _onFocus(focused: boolean): void {
		if (!focused) {
			this._activeTimer.cancel();
			return;
		}
		const ping = () => {
			this._lastActive = Date.now();
			this._syncAll();
		};
		ping();
		this._activeTimer.cancelAndSet(ping, ACTIVE_PING_MS);
	}

	private _setWebUrl(url: string | undefined): void {
		if (this._webUrl !== (url ?? null)) {
			this._webUrl = url ?? null;
			this._sync(this._agentHostService, true);
		}
	}

	private _watchRemotes(): void {
		const connected = new Set<string>();
		for (const info of this._remoteAgentHostService.connections) {
			const connection = this._remoteAgentHostService.getConnection(info.address);
			if (!connection) {
				continue;
			}
			connected.add(info.address);
			if (!this._remoteListeners.has(info.address)) {
				const store = new DisposableStore();
				store.add(connection.rootState.onDidChange(() => this._sync(connection, false)));
				this._remoteListeners.set(info.address, store);
				this._sync(connection, false);
			}
		}
		for (const address of [...this._remoteListeners.keys()]) {
			if (!connected.has(address)) {
				this._remoteListeners.deleteAndDispose(address);
			}
		}
	}

	private _syncAll(): void {
		this._sync(this._agentHostService, true);
		for (const address of this._remoteListeners.keys()) {
			const connection = this._remoteAgentHostService.getConnection(address);
			if (connection) {
				this._sync(connection, false);
			}
		}
	}

	/**
	 * Dispatches only values the host does not hold yet, so windows never fight: the topic is the same
	 * in every window, and the activity time only moves forward.
	 */
	private _sync(connection: IAgentConnection, local: boolean): void {
		const rootState = connection.rootState.value;
		if (!rootState || rootState instanceof Error || !rootState.config) {
			return;
		}
		const values = rootState.config.values;
		const patch: Record<string, unknown> = {};
		if (this._target !== undefined && !structuralEquals(values[CreaEditorNotificationsRootKey.Target], this._target)) {
			patch[CreaEditorNotificationsRootKey.Target] = this._target;
		}
		const hostActive = values[CreaEditorNotificationsRootKey.LastActive];
		if (this._lastActive !== undefined && (typeof hostActive !== 'number' || hostActive < this._lastActive)) {
			patch[CreaEditorNotificationsRootKey.LastActive] = this._lastActive;
		}
		if (local && this._webUrl !== undefined && values[CreaEditorNotificationsRootKey.WebUrl] !== this._webUrl) {
			patch[CreaEditorNotificationsRootKey.WebUrl] = this._webUrl;
		}
		if (Object.keys(patch).length) {
			connection.dispatch(ROOT_STATE_URI, { type: ActionType.RootConfigChanged, config: patch });
		}
	}
}

registerWorkbenchContribution2(CreaEditorNotificationsForwarder.ID, CreaEditorNotificationsForwarder, WorkbenchPhase.AfterRestored);
