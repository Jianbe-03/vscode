/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: what the CreaEditor Server's front knows about the chats of its agent host, for the
// cleanup of delegated worktrees. The front is an ordinary Agent Host Protocol client of the agent
// host's unix socket (the same socket it relays paired devices to; only the server's user can open
// it, so it needs no token): `initialize`, then `listSessions` (paged) for the full list, and the
// broadcast `root/sessionAdded`, `root/sessionRemoved` and `root/sessionSummaryChanged`
// notifications to follow archiving, unarchiving and deleting as they happen. No new channel: the
// list, the archived flag and the working directories are all part of the protocol's session summary.

import type * as wsTypes from 'ws';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { PROTOCOL_VERSION } from '../../../platform/agentHost/common/state/protocol/version/registry.js';
import { isSessionStatusArchived, parseSubagentSessionUri, SessionStatus } from '../../../platform/agentHost/common/state/sessionState.js';

/** A chat (session) of the agent host, as the cleanup needs it. */
export interface IServerChatSession {
	/** The session URI (`claude:/<id>`, `copilotcli:/<id>`, ...). */
	readonly resource: string;
	readonly archived: boolean;
	/** The session's working directories, as file system paths. */
	readonly workingDirectories: readonly string[];
}

/** The chats of the agent host. */
export interface ICreaEditorServerSessionsSource {
	/** Every chat now; undefined when the agent host does not answer (then nothing may be concluded). */
	listSessions(): Promise<readonly IServerChatSession[] | undefined>;
	/** A chat was deleted on the agent host; carries its last known state. */
	readonly onDidRemoveSession: Event<IServerChatSession>;
	/** A chat was added, or its archived state or working directories changed. */
	readonly onDidChangeSession: Event<IServerChatSession>;
}

/** The protocol's session summary fields the cleanup reads. */
interface IWireSessionSummary {
	readonly resource?: unknown;
	readonly status?: unknown;
	readonly workingDirectories?: unknown;
}

/** Reads a chat from a session summary (the protocol's `SessionSummary`); undefined for subagent and invalid ones. */
export function toServerChatSession(summary: IWireSessionSummary, previous?: IServerChatSession): IServerChatSession | undefined {
	const resource = typeof summary.resource === 'string' ? summary.resource : previous?.resource;
	if (!resource) {
		return undefined;
	}
	try {
		if (parseSubagentSessionUri(resource)) {
			return undefined;
		}
	} catch {
		return undefined;
	}
	const archived = typeof summary.status === 'number' ? isSessionStatusArchived(summary.status as SessionStatus) : previous?.archived ?? false;
	const workingDirectories = Array.isArray(summary.workingDirectories)
		? summary.workingDirectories.flatMap(value => {
			if (typeof value !== 'string') {
				return [];
			}
			try {
				const uri = URI.parse(value);
				return uri.scheme === 'file' ? [uri.fsPath] : [];
			} catch {
				return [];
			}
		})
		: previous?.workingDirectories ?? [];
	return { resource, archived, workingDirectories };
}

/** How long a request to the agent host may take. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The largest page of `listSessions`. */
const PAGE_SIZE = 200;
/** Reconnect delays after the agent host connection drops. */
const MIN_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		promise.then(value => {
			clearTimeout(timer);
			resolve(value);
		}, error => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

interface IPendingRequest {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface IConnection {
	readonly socket: wsTypes.WebSocket;
	readonly pending: Map<number, IPendingRequest>;
	nextId: number;
}

/** An Agent Host Protocol client of the agent host's unix socket; see the top of this file. */
export class AgentHostSessionsWatcher extends Disposable implements ICreaEditorServerSessionsSource {

	private readonly _onDidRemoveSession = this._register(new Emitter<IServerChatSession>());
	readonly onDidRemoveSession = this._onDidRemoveSession.event;
	private readonly _onDidChangeSession = this._register(new Emitter<IServerChatSession>());
	readonly onDidChangeSession = this._onDidChangeSession.event;

	private readonly _sessions = new Map<string, IServerChatSession>();
	/** The cache holds the full list (a `listSessions` succeeded on the current connection). */
	private _complete = false;
	private _connection: Promise<IConnection> | undefined;
	private _listing: Promise<readonly IServerChatSession[] | undefined> | undefined;
	/** While a full list is read: what it has so far, and what notifications changed meanwhile (null: removed). */
	private _pendingList: { readonly listed: Map<string, IServerChatSession>; readonly updates: Map<string, IServerChatSession | null> } | undefined;
	private _reconnectDelay = MIN_RECONNECT_MS;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _disposed = false;

	constructor(
		private readonly _resolveSocketPath: () => Promise<string>,
		private readonly _logService: ILogService,
	) {
		super();
	}

	/** Connects now (and again whenever the connection drops), so deletions are seen as they happen. */
	start(): void {
		void this.listSessions();
	}

	async listSessions(): Promise<readonly IServerChatSession[] | undefined> {
		if (this._complete) {
			return [...this._sessions.values()];
		}
		this._listing ??= this._listAll().finally(() => this._listing = undefined);
		return this._listing;
	}

	private async _listAll(): Promise<readonly IServerChatSession[] | undefined> {
		try {
			const connection = await withTimeout(this._connect(), REQUEST_TIMEOUT_MS, 'The agent host does not run.');
			const listed = new Map<string, IServerChatSession>();
			const updates = new Map<string, IServerChatSession | null>();
			this._pendingList = { listed, updates };
			let cursor: string | undefined;
			for (let page = 0; page < 1000; page++) {
				const result = await this._request(connection, 'listSessions', { channel: 'ahp-root://', limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) }) as { items?: unknown; nextCursor?: unknown } | undefined;
				for (const item of Array.isArray(result?.items) ? result.items as IWireSessionSummary[] : []) {
					const session = toServerChatSession(item);
					if (session) {
						listed.set(session.resource, session);
					}
				}
				cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
				if (!cursor) {
					break;
				}
			}
			// Notifications that came while the pages were read are newer than the pages.
			for (const [resource, update] of updates) {
				if (update) {
					listed.set(resource, update);
				} else {
					listed.delete(resource);
				}
			}
			this._sessions.clear();
			for (const [resource, session] of listed) {
				this._sessions.set(resource, session);
			}
			this._complete = true;
			return [...listed.values()];
		} catch (error) {
			this._logService.warn(`[Delegation cleanup] Cannot list the agent host's chats: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		} finally {
			this._pendingList = undefined;
		}
	}

	private _knownSession(resource: string): IServerChatSession | undefined {
		const update = this._pendingList?.updates.get(resource);
		return update === null ? undefined : update ?? this._sessions.get(resource) ?? this._pendingList?.listed.get(resource);
	}

	private _setSession(session: IServerChatSession): void {
		this._sessions.set(session.resource, session);
		this._pendingList?.updates.set(session.resource, session);
	}

	private _connect(): Promise<IConnection> {
		this._connection ??= this._open().catch(error => {
			this._connection = undefined;
			this._scheduleReconnect();
			throw error;
		});
		return this._connection;
	}

	private async _open(): Promise<IConnection> {
		const ws = await import('ws');
		const socketPath = await this._resolveSocketPath();
		const socket = new ws.WebSocket(`ws+unix://${socketPath}:/`);
		await new Promise<void>((resolve, reject) => {
			socket.once('open', () => resolve());
			socket.once('error', reject);
		});
		const connection: IConnection = { socket, pending: new Map(), nextId: 1 };
		socket.on('message', data => this._onMessage(connection, data.toString()));
		socket.on('error', () => socket.terminate());
		socket.once('close', () => {
			for (const request of connection.pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error('The agent host connection closed.'));
			}
			connection.pending.clear();
			if (this._connection) {
				this._connection = undefined;
			}
			// Notifications missed while disconnected: the next list asks again.
			this._complete = false;
			this._scheduleReconnect();
		});
		await this._request(connection, 'initialize', {
			channel: 'ahp-root://',
			protocolVersions: [PROTOCOL_VERSION],
			clientId: `creaeditor-server-cleanup-${generateUuid()}`,
			clientInfo: { name: 'CreaEditor Server worktree cleanup', version: '1' },
		});
		this._reconnectDelay = MIN_RECONNECT_MS;
		return connection;
	}

	private _scheduleReconnect(): void {
		if (this._disposed || this._reconnectTimer) {
			return;
		}
		const delay = this._reconnectDelay;
		this._reconnectDelay = Math.min(MAX_RECONNECT_MS, this._reconnectDelay * 2);
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = undefined;
			void this.listSessions();
		}, delay);
	}

	private _request(connection: IConnection, method: string, params: object): Promise<unknown> {
		const id = connection.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				connection.pending.delete(id);
				reject(new Error(`The agent host did not answer ${method}.`));
			}, REQUEST_TIMEOUT_MS);
			connection.pending.set(id, { resolve, reject, timer });
			connection.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
		});
	}

	private _onMessage(connection: IConnection, text: string): void {
		let message: { id?: unknown; method?: unknown; params?: { session?: unknown; summary?: IWireSessionSummary; changes?: IWireSessionSummary }; result?: unknown; error?: { message?: unknown } };
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof message.id === 'number' && message.method === undefined) {
			const request = connection.pending.get(message.id);
			if (request) {
				connection.pending.delete(message.id);
				clearTimeout(request.timer);
				if (message.error) {
					request.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'The agent host refused the request.'));
				} else {
					request.resolve(message.result);
				}
			}
			return;
		}
		const params = message.params;
		switch (message.method) {
			case 'root/sessionAdded': {
				const session = params?.summary && toServerChatSession(params.summary);
				if (session) {
					this._setSession(session);
					this._onDidChangeSession.fire(session);
				}
				break;
			}
			case 'root/sessionSummaryChanged': {
				const resource = typeof params?.session === 'string' ? params.session : undefined;
				const previous = resource ? this._knownSession(resource) : undefined;
				const session = resource && params?.changes ? toServerChatSession({ ...params.changes, resource }, previous) : undefined;
				if (session && (!previous || previous.archived !== session.archived || previous.workingDirectories.join('\n') !== session.workingDirectories.join('\n'))) {
					this._setSession(session);
					this._onDidChangeSession.fire(session);
				}
				break;
			}
			case 'root/sessionRemoved': {
				const resource = typeof params?.session === 'string' ? params.session : undefined;
				if (!resource) {
					break;
				}
				const previous = this._knownSession(resource);
				this._sessions.delete(resource);
				this._pendingList?.updates.set(resource, null);
				this._onDidRemoveSession.fire(previous ?? { resource, archived: false, workingDirectories: [] });
				break;
			}
		}
	}

	override dispose(): void {
		this._disposed = true;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
		}
		void this._connection?.then(connection => connection.socket.close(), () => undefined);
		super.dispose();
	}
}
