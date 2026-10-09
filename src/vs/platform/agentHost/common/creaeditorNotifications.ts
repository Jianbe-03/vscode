/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: push notifications to the user's phone (ntfy) when a chat finishes, fails or needs
// approval. The agent host sends them (`node/shared/chatNotifications.ts`), so chats on this laptop
// (with Remote Access on) and on CreaEditor Servers notify alike. What the agent host reads:
//
// - the settings below, mirrored into every connected agent host's root config by their `agentHost`
//   declaration (same key as the setting id);
// - the ntfy topic (and its access token), kept in the laptop's secret storage under
//   {@link CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY} and pushed by the desktop as the transient root
//   config value {@link CreaEditorNotificationsRootKey.Target}; a CreaEditor Server also keeps it in
//   its file secret store, so it notifies after a restart while no laptop is connected;
// - {@link CreaEditorNotificationsRootKey.LastActive}: when a desktop window last had focus, for
//   "Only When I'm Away";
// - {@link CreaEditorNotificationsRootKey.WebUrl}: the web Agents window the notification opens.

/** Root config keys (and, for the user settings, setting ids) of notifications. */
export const enum CreaEditorNotificationsRootKey {
	Enabled = 'creaeditor.notifications.enabled',
	Events = 'creaeditor.notifications.events',
	OnlyWhenAway = 'creaeditor.notifications.onlyWhenAway',
	AwayMinutes = 'creaeditor.notifications.awayMinutes',
	/** {@link ICreaEditorNotificationTarget}; transient, never written to the agent host's config file. */
	Target = 'creaeditor.notifications.target',
	/** Epoch milliseconds a desktop window last had focus; transient. */
	LastActive = 'creaeditor.notifications.lastActive',
	/** The web Agents window of this agent host (Remote Access address); transient. */
	WebUrl = 'creaeditor.notifications.webUrl',
}

/** What a notification is about. */
export type CreaEditorNotificationEvent = 'finished' | 'failed' | 'needsInput';

export const CREAEDITOR_NOTIFICATION_EVENTS: readonly CreaEditorNotificationEvent[] = ['finished', 'failed', 'needsInput'];

/** The default of "Only When I'm Away": no desktop window focused for this many minutes. */
export const CREAEDITOR_NOTIFICATIONS_DEFAULT_AWAY_MINUTES = 5;

/** Secret storage key (desktop) of the {@link ICreaEditorNotificationTarget} JSON. */
export const CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY = 'creaeditor.notifications.target';

/** The file secret store name (CreaEditor Server) of the {@link ICreaEditorNotificationTarget} JSON. */
export const CREAEDITOR_NOTIFICATIONS_TARGET_SERVER_SECRET_NAME = 'notifications-target';

/** Set by the CreaEditor Server for its agent host: the address of its web Agents window, opened by a notification. */
export const AGENT_HOST_WEB_URL_ENV_VAR = 'CREAEDITOR_AGENT_HOST_WEB_URL';

/** Set by the CreaEditor Server for its agent host: the name the server goes by in notifications and queue messages. */
export const AGENT_HOST_SERVER_NAME_ENV_VAR = 'CREAEDITOR_AGENT_HOST_SERVER_NAME';

/** The public ntfy server; a self-hosted one works the same way. */
export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

/** Set Up Notifications in the editor and the Agents window. */
export const CREAEDITOR_SET_UP_NOTIFICATIONS_COMMAND_ID = 'creaeditor.notifications.setUp';

/** Where notifications go: an ntfy topic URL such as `https://ntfy.sh/creaeditor-<random>`. */
export interface ICreaEditorNotificationTarget {
	readonly url: string;
	/** An ntfy access token, for a topic that needs one (self-hosted with access control). */
	readonly token?: string;
}

/** The effective notification settings of an agent host. */
export interface ICreaEditorNotificationsConfig {
	readonly enabled: boolean;
	readonly events: ReadonlySet<CreaEditorNotificationEvent>;
	readonly onlyWhenAway: boolean;
	readonly awayMinutes: number;
	readonly target: ICreaEditorNotificationTarget | undefined;
	readonly lastActive: number | undefined;
	readonly webUrl: string | undefined;
}

/** Reads a topic URL: http(s), with a host and a topic, without credentials. Undefined otherwise. */
export function parseNotificationTarget(value: unknown): ICreaEditorNotificationTarget | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { url, token } = value as { url?: unknown; token?: unknown };
	if (typeof url !== 'string' || !isNtfyTopicUrl(url) || (token !== undefined && typeof token !== 'string')) {
		return undefined;
	}
	return { url: url.trim().replace(/\/+$/, ''), ...(token ? { token } : {}) };
}

/** Whether `url` is an ntfy topic URL: `http(s)://host[:port][/base]/<topic>`. */
export function isNtfyTopicUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return false;
	}
	const topic = parsed.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
	return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !!parsed.hostname && !parsed.username && !parsed.password
		&& !parsed.search && /^[\w-]{1,64}$/.test(topic);
}

/**
 * A new topic URL on `server` with 128 random bits in the name, so nobody can guess it (on ntfy.sh
 * anyone who knows a topic can read it).
 */
export function createNtfyTopicUrl(server: string = NTFY_DEFAULT_SERVER, random: (bytes: Uint8Array) => Uint8Array = bytes => crypto.getRandomValues(bytes)): string {
	const bytes = random(new Uint8Array(16));
	const name = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
	return `${server.trim().replace(/\/+$/, '')}/creaeditor-${name}`;
}

/** Reads the notification settings from an agent host's root config values. */
export function readCreaEditorNotificationsConfig(values: Readonly<Record<string, unknown>> | undefined): ICreaEditorNotificationsConfig {
	const get = (key: CreaEditorNotificationsRootKey) => values?.[key];
	const events = get(CreaEditorNotificationsRootKey.Events);
	const awayMinutes = get(CreaEditorNotificationsRootKey.AwayMinutes);
	const lastActive = get(CreaEditorNotificationsRootKey.LastActive);
	const webUrl = get(CreaEditorNotificationsRootKey.WebUrl);
	return {
		enabled: get(CreaEditorNotificationsRootKey.Enabled) === true,
		events: new Set(Array.isArray(events) ? CREAEDITOR_NOTIFICATION_EVENTS.filter(event => events.includes(event)) : CREAEDITOR_NOTIFICATION_EVENTS),
		onlyWhenAway: get(CreaEditorNotificationsRootKey.OnlyWhenAway) !== false,
		awayMinutes: typeof awayMinutes === 'number' && Number.isFinite(awayMinutes) && awayMinutes >= 0 ? awayMinutes : CREAEDITOR_NOTIFICATIONS_DEFAULT_AWAY_MINUTES,
		target: parseNotificationTarget(get(CreaEditorNotificationsRootKey.Target)),
		lastActive: typeof lastActive === 'number' && Number.isFinite(lastActive) ? lastActive : undefined,
		webUrl: typeof webUrl === 'string' && /^https?:\/\//i.test(webUrl) ? webUrl : undefined,
	};
}

/** One notification, before it is turned into an ntfy request. */
export interface ICreaEditorNotification {
	readonly title: string;
	readonly message: string;
	/** ntfy priority: 3 is the default, 4 high (needs input), 2 low. */
	readonly priority: 2 | 3 | 4;
	/** ntfy tags; known emoji names show as icons. */
	readonly tags: readonly string[];
	/** Opened when the notification is tapped. */
	readonly click?: string;
}

/** An HTTP request to publish a notification. */
export interface INtfyRequest {
	readonly url: string;
	readonly headers: Record<string, string>;
	readonly body: string;
}

/**
 * The ntfy JSON publish request of a notification: `POST <server root>` with `{ topic, title, ... }`.
 * JSON (rather than headers) carries any characters in the chat title.
 */
export function createNtfyRequest(target: ICreaEditorNotificationTarget, notification: ICreaEditorNotification): INtfyRequest {
	const url = new URL(target.url);
	const segments = url.pathname.replace(/\/+$/, '').split('/');
	const topic = segments.pop() ?? '';
	url.pathname = segments.join('/') || '/';
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (target.token) {
		headers['Authorization'] = `Bearer ${target.token}`;
	}
	return {
		url: url.toString(),
		headers,
		body: JSON.stringify({
			topic,
			title: notification.title,
			message: notification.message,
			priority: notification.priority,
			tags: notification.tags,
			...(notification.click ? { click: notification.click } : {}),
		}),
	};
}

/** Shortens a chat title for a notification. */
export function shortenNotificationTitle(title: string | undefined, fallback: string, max = 80): string {
	const line = title?.trim().split(/\r?\n/)[0] ?? '';
	if (!line) {
		return fallback;
	}
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
