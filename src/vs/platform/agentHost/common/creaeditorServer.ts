/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: what the CreaEditor Server (a headless agent host with the web Agents window, see
// `src/vs/server/node/creaeditorServer/`) and its clients share: the default port, the `/health`
// answer and how a server address or pairing link is read.

/** The port a CreaEditor Server listens on by default. */
export const CREAEDITOR_SERVER_DEFAULT_PORT = 31600;

/** The path of the status endpoint; it needs no authentication and tells nothing secret. */
export const CREAEDITOR_SERVER_HEALTH_PATH = '/health';

/** The path that exchanges a pairing code for a device key (`POST { code, deviceName, password? }`). */
export const CREAEDITOR_SERVER_PAIR_PATH = '/api/pair';

/** The path of the agent host WebSocket; it takes the device key as `?tkn=`. */
export const CREAEDITOR_SERVER_WEBSOCKET_PATH = '/ahp';

/**
 * What `GET /health` of a CreaEditor Server (or of a desktop's Remote Access) answers, see
 * `src/vs/platform/agentHost/node/remoteAccess/README.md`.
 */
export interface ICreaEditorServerHealth {
	/** `CreaEditor Server`, or the desktop app's name for its Remote Access. */
	readonly product: string;
	readonly version: string;
	readonly commit?: string;
	/** Whether pairing needs the password (the server is reachable from the internet). */
	readonly publicMode: boolean;
	/** Whether the server serves the web Agents window. */
	readonly webUi: boolean;
	readonly uptimeSeconds: number;
}

/** Reads a `/health` answer; undefined when it is not one of a Remote Access server. */
export function parseCreaEditorServerHealth(value: unknown): ICreaEditorServerHealth | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as Partial<Record<keyof ICreaEditorServerHealth | 'status', unknown>>;
	if (candidate.status !== 'ok' || typeof candidate.product !== 'string' || typeof candidate.version !== 'string') {
		return undefined;
	}
	return {
		product: candidate.product,
		version: candidate.version,
		...(typeof candidate.commit === 'string' ? { commit: candidate.commit } : {}),
		publicMode: candidate.publicMode === true,
		webUi: candidate.webUi === true,
		uptimeSeconds: typeof candidate.uptimeSeconds === 'number' && Number.isFinite(candidate.uptimeSeconds) ? candidate.uptimeSeconds : 0,
	};
}

/** Why a pairing attempt failed, as `POST /api/pair` answers it. */
export type CreaEditorServerPairError = 'invalidCode' | 'expiredCode' | 'passwordRequired' | 'wrongPassword' | 'noPasswordSet' | 'lockedOut' | 'unreachable' | 'unexpected';

export type CreaEditorServerPairResult =
	| { readonly ok: true; readonly deviceId: string; readonly deviceKey: string }
	| { readonly ok: false; readonly error: CreaEditorServerPairError; readonly retryAfterSeconds?: number };

/** Reads the answer of `POST /api/pair` with HTTP status `status`. */
export function parseCreaEditorServerPairResponse(status: number, body: unknown): CreaEditorServerPairResult {
	const value = (body && typeof body === 'object' ? body : {}) as { deviceId?: unknown; deviceKey?: unknown; error?: unknown; retryAfterSeconds?: unknown };
	if (status === 200 && typeof value.deviceKey === 'string' && value.deviceKey && typeof value.deviceId === 'string') {
		return { ok: true, deviceId: value.deviceId, deviceKey: value.deviceKey };
	}
	const known: readonly CreaEditorServerPairError[] = ['invalidCode', 'expiredCode', 'passwordRequired', 'wrongPassword', 'noPasswordSet', 'lockedOut'];
	const error = known.find(candidate => candidate === value.error) ?? 'unexpected';
	return { ok: false, error, ...(typeof value.retryAfterSeconds === 'number' ? { retryAfterSeconds: value.retryAfterSeconds } : {}) };
}

/**
 * The agent host address of a server in the form remote agent host addresses are kept in: `host:port/ahp`
 * over plain WebSocket, `wss://host/ahp` over TLS.
 */
export function getCreaEditorServerAgentHostAddress(baseUrl: string): string {
	const url = new URL(baseUrl);
	const address = `${url.host}${CREAEDITOR_SERVER_WEBSOCKET_PATH}`;
	return url.protocol === 'https:' ? `wss://${address}` : address;
}

/** A server address the user typed or pasted, read by {@link parseCreaEditorServerInput}. */
export interface ICreaEditorServerInput {
	/** `http(s)://host[:port]`, without a path, query or trailing slash. */
	readonly baseUrl: string;
	/** The pairing code, when the input was a pairing link. */
	readonly pairingCode?: string;
	/** The host name, as a default name for the server. */
	readonly suggestedName: string;
}

const PAIRING_CODE_PARAMETERS = ['code', 'pair', 'pairing', 'pairingCode'];

/**
 * Reads a server address or pairing link: `https://host`, `http://100.64.0.2:31600`, `100.64.0.2`
 * (http on {@link CREAEDITOR_SERVER_DEFAULT_PORT}), `host:31600`, or a pairing link that carries the
 * code as `?code=`, `?pair=` or in the fragment (`#code=...`). Undefined when it is no address.
 */
export function parseCreaEditorServerInput(input: string): ICreaEditorServerInput | undefined {
	const trimmed = input.trim();
	if (!trimmed || /\s/.test(trimmed)) {
		return undefined;
	}
	const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
	let url: URL;
	try {
		url = new URL(hasScheme ? trimmed : `http://${trimmed}`);
	} catch {
		return undefined;
	}
	const protocol = url.protocol.toLowerCase();
	if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'ws:' && protocol !== 'wss:') {
		return undefined;
	}
	if (!url.hostname || url.username || url.password) {
		return undefined;
	}
	const secure = protocol === 'https:' || protocol === 'wss:';
	// A bare address without a port is a server on the default port; a URL with a scheme keeps its own.
	const port = url.port || (hasScheme ? '' : String(CREAEDITOR_SERVER_DEFAULT_PORT));
	const baseUrl = `${secure ? 'https' : 'http'}://${url.hostname}${port ? `:${port}` : ''}`;
	const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
	let pairingCode: string | undefined;
	for (const name of PAIRING_CODE_PARAMETERS) {
		pairingCode ??= url.searchParams.get(name) ?? fragment.get(name) ?? undefined;
	}
	pairingCode = pairingCode ? normalizePairingCode(pairingCode) : undefined;
	return { baseUrl, ...(pairingCode ? { pairingCode } : {}), suggestedName: url.hostname };
}

/** A pairing code as typed, in upper case without spaces (the server also ignores dashes). */
export function normalizePairingCode(code: string): string {
	return code.replace(/\s+/g, '').toUpperCase();
}

/** The web page of the server for a browser (the web Agents window). */
export function getCreaEditorServerWebUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/`;
}

/**
 * The root config value (transient) in which the agent host of a CreaEditor Server publishes how busy
 * its machine is, so clients can show it next to the server (`readCreaEditorServerMachine`).
 */
export const CREAEDITOR_SERVER_MACHINE_KEY = 'creaeditor.server.machine';

/** What {@link CREAEDITOR_SERVER_MACHINE_KEY} holds. */
export interface ICreaEditorServerMachine {
	/** The 1-minute load average as a share of all cores, 0-100. */
	readonly cpuPercent: number;
	readonly cores: number;
	readonly memoryTotalBytes: number;
	readonly memoryFreeBytes: number;
	/** Epoch milliseconds of the reading. */
	readonly updatedAt: number;
}

/** Reads {@link CREAEDITOR_SERVER_MACHINE_KEY} from root config values. */
export function readCreaEditorServerMachine(values: Readonly<Record<string, unknown>> | undefined): ICreaEditorServerMachine | undefined {
	const value = values?.[CREAEDITOR_SERVER_MACHINE_KEY] as Partial<ICreaEditorServerMachine> | undefined;
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const numbers = [value.cpuPercent, value.cores, value.memoryTotalBytes, value.memoryFreeBytes, value.updatedAt];
	return numbers.every(item => typeof item === 'number' && Number.isFinite(item)) ? value as ICreaEditorServerMachine : undefined;
}

/**
 * The root config value (transient) in which the agent host publishes how many chats run and wait,
 * when it limits how many run at once (a CreaEditor Server's `--max-running-chats`).
 */
export const CREAEDITOR_SERVER_CHATS_KEY = 'creaeditor.server.chats';

/** What {@link CREAEDITOR_SERVER_CHATS_KEY} holds. */
export interface ICreaEditorServerChats {
	readonly running: number;
	readonly queued: number;
	/** How many chats may run at once. */
	readonly max: number;
}

/** Reads {@link CREAEDITOR_SERVER_CHATS_KEY} from root config values. */
export function readCreaEditorServerChats(values: Readonly<Record<string, unknown>> | undefined): ICreaEditorServerChats | undefined {
	const value = values?.[CREAEDITOR_SERVER_CHATS_KEY] as Partial<ICreaEditorServerChats> | undefined;
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const numbers = [value.running, value.queued, value.max];
	return numbers.every(item => typeof item === 'number' && Number.isInteger(item) && item >= 0) ? value as ICreaEditorServerChats : undefined;
}

/** The default of `creaeditor-server --max-running-chats`. */
export const CREAEDITOR_SERVER_DEFAULT_MAX_RUNNING_CHATS = 4;

/**
 * Application storage key the editor window sets (to `Date.now()`) to have the Agents window start Add
 * CreaEditor Server, e.g. from the CreaEditor Features walkthrough.
 */
export const CREAEDITOR_SERVERS_ADD_REQUEST_KEY = 'creaeditor.servers.addRequested';

/** Add CreaEditor Server in the editor window: opens the Agents window, which runs it. */
export const OPEN_ADD_CREAEDITOR_SERVER_COMMAND_ID = 'creaeditor.servers.openAdd';
