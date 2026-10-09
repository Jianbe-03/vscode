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

/** What `GET /health` of a CreaEditor Server answers. */
export interface ICreaEditorServerHealth {
	/** Always `creaeditor-server`, so a client knows it reached a CreaEditor Server. */
	readonly product: 'creaeditor-server';
	/** `true` while the agent host runs. */
	readonly ok: boolean;
	readonly version: string;
	readonly commit?: string;
	/** `linux`, `darwin`, ... */
	readonly platform: string;
	readonly arch: string;
	readonly uptimeSeconds: number;
	/** The agent host process the server supervises. */
	readonly agentHost: 'starting' | 'running' | 'restarting' | 'stopped';
	readonly cpu: {
		readonly cores: number;
		/** The 1-minute load average divided by the number of cores, 0-100 (capped). */
		readonly percent: number;
	};
	readonly memory: {
		readonly totalBytes: number;
		readonly freeBytes: number;
	};
	/** Chats with a turn in progress, when the server knows. */
	readonly runningChats?: number;
	/** Clients connected to the agent host right now, when the server knows. */
	readonly connectedClients?: number;
}

/** Reads a `/health` answer; undefined when it is not one of a CreaEditor Server. */
export function parseCreaEditorServerHealth(value: unknown): ICreaEditorServerHealth | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as Partial<Record<keyof ICreaEditorServerHealth, unknown>>;
	const cpu = candidate.cpu as Partial<ICreaEditorServerHealth['cpu']> | undefined;
	const memory = candidate.memory as Partial<ICreaEditorServerHealth['memory']> | undefined;
	if (candidate.product !== 'creaeditor-server' || typeof candidate.version !== 'string') {
		return undefined;
	}
	const number = (input: unknown) => typeof input === 'number' && Number.isFinite(input) ? input : undefined;
	const agentHost = candidate.agentHost === 'starting' || candidate.agentHost === 'running' || candidate.agentHost === 'restarting' || candidate.agentHost === 'stopped' ? candidate.agentHost : 'stopped';
	return {
		product: 'creaeditor-server',
		ok: candidate.ok === true,
		version: candidate.version,
		...(typeof candidate.commit === 'string' ? { commit: candidate.commit } : {}),
		platform: typeof candidate.platform === 'string' ? candidate.platform : '',
		arch: typeof candidate.arch === 'string' ? candidate.arch : '',
		uptimeSeconds: number(candidate.uptimeSeconds) ?? 0,
		agentHost,
		cpu: { cores: number(cpu?.cores) ?? 0, percent: number(cpu?.percent) ?? 0 },
		memory: { totalBytes: number(memory?.totalBytes) ?? 0, freeBytes: number(memory?.freeBytes) ?? 0 },
		...(number(candidate.runningChats) !== undefined ? { runningChats: number(candidate.runningChats) } : {}),
		...(number(candidate.connectedClients) !== undefined ? { connectedClients: number(candidate.connectedClients) } : {}),
	};
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

/** A pairing code as typed: spaces dropped and upper case, so `abcd 1234` and `ABCD-1234` match. */
export function normalizePairingCode(code: string): string {
	return code.replace(/\s+/g, '').toUpperCase();
}

/** The web page of the server for a browser (the web Agents window). */
export function getCreaEditorServerWebUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/`;
}
