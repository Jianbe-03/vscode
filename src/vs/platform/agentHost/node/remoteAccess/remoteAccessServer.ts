/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Remote Access HTTP server. One port serves the web Agents window, the pairing
// API, `/health`, and the agent host WebSocket (authenticated with a device key). See README.md.

import { promises as fs } from 'fs';
import type * as httpTypes from 'http';
import type { Socket } from 'net';
import { extname, join, resolve, sep } from '../../../../base/common/path.js';
import type * as wsTypes from 'ws';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { connectionTokenQueryName } from '../../../../base/common/network.js';
import { ILogService } from '../../../log/common/log.js';
import type { IProtocolServer, IProtocolTransport } from '../../common/state/sessionTransport.js';
import { WebSocketProtocolTransport } from '../webSocketTransport.js';
import { IRemoteAccessAuth, IRemoteAccessDevice, RemoteAccessAuthFailure } from './remoteAccessAuth.js';
import { renderRemoteAccessPage } from './remoteAccessPage.js';

/** Receives each authenticated agent host WebSocket. */
export interface IRemoteAccessConnector {
	/** Takes ownership of `socket`: it speaks the Agent Host Protocol (JSON text frames). */
	handleConnection(socket: wsTypes.WebSocket, device: IRemoteAccessDevice): void;
}

/** Options of {@link startRemoteAccessServer}. */
export interface IRemoteAccessServerOptions {
	/** Addresses to listen on, e.g. the Tailscale IPv4 address, or `127.0.0.1`. Never `0.0.0.0` unless you mean it. */
	readonly hosts: readonly string[];
	/** TCP port; 0 picks a free one (see {@link IRemoteAccessServerHandle.port}). */
	readonly port: number;
	/**
	 * Folder of the web Agents window build (`build/next/index.ts bundle --target web`), holding
	 * `vs/sessions/sessions.web.main.internal.js`. `undefined` or missing: the page says the web UI is not available.
	 */
	readonly webRoot: string | undefined;
	readonly auth: IRemoteAccessAuth;
	/** When true, pairing also needs the password. Change it later with {@link IRemoteAccessServerHandle.setPublicMode}. */
	readonly publicMode: boolean;
	/** Where authenticated agent host connections go, e.g. {@link RemoteAccessProtocolServer} or {@link createSocketRelayConnector}. */
	readonly connector: IRemoteAccessConnector;
	readonly logService: ILogService;
	/** Shown in `/health` and on the page. */
	readonly product: { readonly name: string; readonly version: string; readonly commit?: string };
	/** The name of this machine shown to devices, e.g. `os.hostname()`. */
	readonly hostName: string;
	/**
	 * More authenticated routes (CreaEditor Server: Delegate to Server under `/api/delegation/`). A
	 * request whose path starts with a prefix goes to its handler once its device key checks out;
	 * without a valid key it gets 401. The handler reads the body itself (it may be large).
	 */
	readonly apiHandlers?: readonly IRemoteAccessApiHandler[];
	/**
	 * More of `/health` for a paired device: when the request carries a valid device key, the answer
	 * also has `details` with this (CreaEditor Server: CPU, memory, running chats). Without a key
	 * `/health` stays minimal.
	 */
	readonly getHealthDetails?: () => object | Promise<object>;
}

/** An authenticated route group of {@link IRemoteAccessServerOptions.apiHandlers}. */
export interface IRemoteAccessApiHandler {
	/** Path prefix, e.g. `/api/delegation/`. */
	readonly prefix: string;
	handle(request: httpTypes.IncomingMessage, response: httpTypes.ServerResponse, path: string, url: URL, device: IRemoteAccessDevice): Promise<void>;
}

/** A running Remote Access server. Dispose (or {@link close}) to stop it and drop all connections. */
export interface IRemoteAccessServerHandle extends IDisposable {
	/** The bound port. */
	readonly port: number;
	/** Number of open agent host connections. */
	readonly connectionCount: number;
	readonly onDidChangeConnectionCount: Event<number>;
	readonly publicMode: boolean;
	setPublicMode(publicMode: boolean): void;
	close(): Promise<void>;
}

/** Path of the agent host WebSocket. Upgrades on `/` are accepted too. */
export const REMOTE_ACCESS_WEBSOCKET_PATH = '/ahp';
/** Path prefix of the web build's files. */
export const REMOTE_ACCESS_STATIC_PATH = '/static/';
/** Close code sent to the connections of a device that was signed out. */
export const REMOTE_ACCESS_SIGNED_OUT_CLOSE_CODE = 4001;

const MAX_BODY_BYTES = 8 * 1024;
const CONTENT_TYPES: Record<string, string> = {
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.ttf': 'font/ttf',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
	'.map': 'application/json; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
};

/** Starts the server; resolves once it listens on every host. */
export async function startRemoteAccessServer(options: IRemoteAccessServerOptions): Promise<IRemoteAccessServerHandle> {
	if (options.hosts.length === 0) {
		throw new Error('Remote Access needs at least one address to listen on.');
	}
	const [http, ws] = await Promise.all([import('http'), import('ws')]);
	const server = new RemoteAccessServer(options, http, ws);
	try {
		await server.listen();
	} catch (error) {
		server.dispose();
		throw error;
	}
	return server;
}

class RemoteAccessServer extends Disposable implements IRemoteAccessServerHandle {

	private readonly _servers: httpTypes.Server[] = [];
	private readonly _wss: wsTypes.WebSocketServer;
	private readonly _socketsByDevice = new Map<string, Set<wsTypes.WebSocket>>();
	private readonly _openSockets = new Set<Socket>();
	private readonly _startedAt = Date.now();
	private _port = 0;
	private _publicMode: boolean;
	private _connectionCount = 0;
	private _closed = false;

	private readonly _onDidChangeConnectionCount = this._register(new Emitter<number>());
	readonly onDidChangeConnectionCount = this._onDidChangeConnectionCount.event;

	get port(): number { return this._port; }
	get connectionCount(): number { return this._connectionCount; }
	get publicMode(): boolean { return this._publicMode; }

	constructor(
		private readonly _options: IRemoteAccessServerOptions,
		private readonly _http: typeof httpTypes,
		ws: typeof wsTypes,
	) {
		super();
		this._publicMode = _options.publicMode;
		this._wss = new ws.WebSocketServer({ noServer: true });
		this._register(toDisposable(() => this._wss.close()));
		this._register(_options.auth.onDidRevokeDevice(id => {
			for (const socket of this._socketsByDevice.get(id) ?? []) {
				socket.close(REMOTE_ACCESS_SIGNED_OUT_CLOSE_CODE, 'Signed out');
			}
		}));
	}

	async listen(): Promise<void> {
		let port = this._options.port;
		for (const host of this._options.hosts) {
			const server = this._http.createServer((request, response) => {
				this._handleRequest(request, response).catch(error => {
					this._options.logService.error('[RemoteAccess] Request failed', error);
					if (!response.headersSent) {
						sendJson(response, 500, { error: 'internal' });
					} else {
						response.destroy();
					}
				});
			});
			server.on('upgrade', (request: httpTypes.IncomingMessage, socket: Socket, head: Buffer) => this._handleUpgrade(request, socket, head));
			server.on('connection', (socket: Socket) => {
				this._openSockets.add(socket);
				socket.once('close', () => this._openSockets.delete(socket));
			});
			this._servers.push(server);
			await new Promise<void>((resolvePromise, reject) => {
				server.once('error', reject);
				server.listen(port, host, () => {
					server.off('error', reject);
					resolvePromise();
				});
			});
			server.on('error', error => this._options.logService.error('[RemoteAccess] Server error', error));
			const address = server.address();
			if (address && typeof address !== 'string') {
				port = address.port;
			}
			this._options.logService.info(`[RemoteAccess] Listening on ${host.includes(':') ? `[${host}]` : host}:${port}`);
		}
		this._port = port;
	}

	setPublicMode(publicMode: boolean): void {
		this._publicMode = publicMode;
	}

	async close(): Promise<void> {
		const closed = this._shutdown();
		super.dispose();
		await closed;
	}

	override dispose(): void {
		void this._shutdown();
		super.dispose();
	}

	private _shutdown(): Promise<void> {
		if (this._closed) {
			return Promise.resolve();
		}
		this._closed = true;
		for (const sockets of this._socketsByDevice.values()) {
			for (const socket of sockets) {
				socket.terminate();
			}
		}
		const closed = Promise.all(this._servers.map(server => new Promise<void>(resolvePromise => server.close(() => resolvePromise()))));
		for (const socket of this._openSockets) {
			socket.destroy();
		}
		return closed.then(() => undefined);
	}

	// ---- HTTP ---------------------------------------------------------------

	private async _handleRequest(request: httpTypes.IncomingMessage, response: httpTypes.ServerResponse): Promise<void> {
		response.setHeader('X-Content-Type-Options', 'nosniff');
		response.setHeader('Referrer-Policy', 'no-referrer');
		// The web worker extension host runs in a same-origin iframe.
		response.setHeader('X-Frame-Options', 'SAMEORIGIN');

		const url = parseRequestUrl(request);
		if (!url) {
			sendJson(response, 400, { error: 'badRequest' });
			return;
		}
		const method = request.method ?? 'GET';
		const path = url.pathname;

		if (path === '/health' && (method === 'GET' || method === 'HEAD')) {
			const device = this._options.getHealthDetails && request.headers.authorization ? this._authenticateRequest(request) : undefined;
			sendJson(response, 200, {
				status: 'ok',
				product: this._options.product.name,
				version: this._options.product.version,
				commit: this._options.product.commit,
				publicMode: this._publicMode,
				webUi: await this._hasWebUi(),
				uptimeSeconds: Math.round((Date.now() - this._startedAt) / 1000),
				...(device && this._options.getHealthDetails ? { details: await this._options.getHealthDetails() } : {}),
			});
			return;
		}

		if ((path === '/' || path === '/index.html') && (method === 'GET' || method === 'HEAD')) {
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end(method === 'HEAD' ? undefined : renderRemoteAccessPage());
			return;
		}

		if (path === '/api/info' && method === 'GET') {
			sendJson(response, 200, {
				hostName: this._options.hostName,
				product: this._options.product.name,
				publicMode: this._publicMode,
				passwordRequired: this._publicMode,
				webUi: await this._hasWebUi(),
			});
			return;
		}

		if (path === '/api/pair' && method === 'POST') {
			await this._handlePair(request, response);
			return;
		}

		if (path === '/api/device' && method === 'GET') {
			const device = this._authenticateRequest(request);
			if (!device) {
				sendJson(response, 401, { error: 'unauthorized' });
				return;
			}
			sendJson(response, 200, { id: device.id, name: device.name });
			return;
		}

		if (path === '/api/sign-out' && method === 'POST') {
			const device = this._authenticateRequest(request);
			if (!device) {
				sendJson(response, 401, { error: 'unauthorized' });
				return;
			}
			await this._options.auth.revokeDevice(device.id);
			sendJson(response, 200, {});
			return;
		}

		const apiHandler = this._options.apiHandlers?.find(candidate => path.startsWith(candidate.prefix));
		if (apiHandler) {
			const device = this._authenticateRequest(request);
			if (!device) {
				sendJson(response, 401, { error: 'unauthorized' });
				return;
			}
			await apiHandler.handle(request, response, path.slice(apiHandler.prefix.length), url, device);
			return;
		}

		if (path.startsWith(REMOTE_ACCESS_STATIC_PATH) && (method === 'GET' || method === 'HEAD')) {
			await this._serveStatic(request, response, path.slice(REMOTE_ACCESS_STATIC_PATH.length));
			return;
		}

		sendJson(response, 404, { error: 'notFound' });
	}

	private async _handlePair(request: httpTypes.IncomingMessage, response: httpTypes.ServerResponse): Promise<void> {
		const client = getClientAddress(request);
		let body: unknown;
		try {
			body = JSON.parse(await readBody(request));
		} catch {
			sendJson(response, 400, { error: 'badRequest' });
			return;
		}
		const { code, deviceName, password } = (body ?? {}) as { code?: unknown; deviceName?: unknown; password?: unknown };
		if (typeof code !== 'string' || (deviceName !== undefined && typeof deviceName !== 'string') || (password !== undefined && typeof password !== 'string')) {
			sendJson(response, 400, { error: 'badRequest' });
			return;
		}
		const result = await this._options.auth.pair({
			code,
			deviceName: deviceName ?? '',
			password,
			requirePassword: this._publicMode,
			client,
		});
		if (result.ok) {
			this._options.logService.info(`[RemoteAccess] Device "${result.device.name}" paired from ${client}`);
			sendJson(response, 200, { deviceId: result.device.id, deviceName: result.device.name, deviceKey: result.deviceKey });
			return;
		}
		const status = result.reason === RemoteAccessAuthFailure.LockedOut ? 429 : 403;
		if (result.retryAfterMs) {
			response.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
		}
		sendJson(response, status, { error: result.reason, retryAfterSeconds: result.retryAfterMs ? Math.ceil(result.retryAfterMs / 1000) : undefined });
	}

	private _authenticateRequest(request: httpTypes.IncomingMessage): IRemoteAccessDevice | undefined {
		const header = request.headers.authorization;
		const key = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
		return this._options.auth.verifyDeviceKey(key, getClientAddress(request));
	}

	private async _hasWebUi(): Promise<boolean> {
		const root = this._options.webRoot;
		if (!root) {
			return false;
		}
		try {
			return (await fs.stat(join(root, 'vs', 'sessions', 'sessions.web.main.internal.js'))).isFile();
		} catch {
			return false;
		}
	}

	private async _serveStatic(request: httpTypes.IncomingMessage, response: httpTypes.ServerResponse, relativePath: string): Promise<void> {
		const root = this._options.webRoot;
		let decoded: string;
		try {
			decoded = decodeURIComponent(relativePath);
		} catch {
			sendJson(response, 400, { error: 'badRequest' });
			return;
		}
		if (!root || decoded.includes('\0')) {
			sendJson(response, 404, { error: 'notFound' });
			return;
		}
		const rootPath = resolve(root);
		const filePath = resolve(rootPath, decoded);
		if (!filePath.startsWith(rootPath + sep)) {
			sendJson(response, 404, { error: 'notFound' });
			return;
		}
		let stat;
		try {
			stat = await fs.stat(filePath);
		} catch {
			stat = undefined;
		}
		if (!stat?.isFile()) {
			sendJson(response, 404, { error: 'notFound' });
			return;
		}
		const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
		if (request.headers['if-none-match'] === etag) {
			response.writeHead(304, { ETag: etag });
			response.end();
			return;
		}
		response.writeHead(200, {
			'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
			'Content-Length': stat.size,
			'Cache-Control': 'no-cache',
			ETag: etag,
		});
		if (request.method === 'HEAD') {
			response.end();
			return;
		}
		const { createReadStream } = await import('fs');
		const stream = createReadStream(filePath);
		stream.on('error', () => response.destroy());
		stream.pipe(response);
	}

	// ---- WebSocket ----------------------------------------------------------

	private _handleUpgrade(request: httpTypes.IncomingMessage, socket: Socket, head: Buffer): void {
		const url = parseRequestUrl(request);
		if (!url || (url.pathname !== REMOTE_ACCESS_WEBSOCKET_PATH && url.pathname !== '/')) {
			rejectUpgrade(socket, 404, 'Not Found');
			return;
		}
		const tokens = url.searchParams.getAll(connectionTokenQueryName);
		const device = tokens.length === 1 ? this._options.auth.verifyDeviceKey(tokens[0], getClientAddress(request)) : undefined;
		if (!device) {
			this._options.logService.warn(`[RemoteAccess] Rejected a connection from ${getClientAddress(request)}: invalid device key`);
			rejectUpgrade(socket, 403, 'Forbidden');
			return;
		}
		this._wss.handleUpgrade(request, socket, head, webSocket => this._onAuthenticated(webSocket, device));
	}

	private _onAuthenticated(webSocket: wsTypes.WebSocket, device: IRemoteAccessDevice): void {
		if (this._closed) {
			webSocket.terminate();
			return;
		}
		let sockets = this._socketsByDevice.get(device.id);
		if (!sockets) {
			sockets = new Set();
			this._socketsByDevice.set(device.id, sockets);
		}
		sockets.add(webSocket);
		this._setConnectionCount(this._connectionCount + 1);
		webSocket.once('close', () => {
			sockets.delete(webSocket);
			if (sockets.size === 0) {
				this._socketsByDevice.delete(device.id);
			}
			this._setConnectionCount(this._connectionCount - 1);
		});
		this._options.logService.info(`[RemoteAccess] Device "${device.name}" connected`);
		this._options.connector.handleConnection(webSocket, device);
	}

	private _setConnectionCount(count: number): void {
		this._connectionCount = count;
		this._onDidChangeConnectionCount.fire(count);
	}
}

/**
 * A {@link IRemoteAccessConnector} that is also an {@link IProtocolServer}: hand it to a
 * `ProtocolServerHandler` in the process that runs the agent host (as the headless server does)
 * so remote devices share the sessions of every other client.
 */
export class RemoteAccessProtocolServer extends Disposable implements IProtocolServer, IRemoteAccessConnector {

	private readonly _onConnection = this._register(new Emitter<IProtocolTransport>());
	readonly onConnection = this._onConnection.event;

	readonly address = undefined;

	private readonly _connections = new Set<IDisposable>();

	static async create(): Promise<RemoteAccessProtocolServer> {
		const ws = await import('ws');
		return new RemoteAccessProtocolServer(ws.WebSocket);
	}

	private constructor(private readonly _WebSocket: typeof wsTypes.WebSocket) {
		super();
	}

	handleConnection(socket: wsTypes.WebSocket): void {
		if (this._store.isDisposed) {
			socket.terminate();
			return;
		}
		const transport = new WebSocketProtocolTransport(socket, this._WebSocket);
		const store = new DisposableStore();
		store.add(transport);
		store.add(transport.onClose(() => {
			this._connections.delete(store);
			store.dispose();
		}));
		this._connections.add(store);
		this._onConnection.fire(transport);
	}

	override dispose(): void {
		for (const connection of this._connections) {
			connection.dispose();
		}
		this._connections.clear();
		super.dispose();
	}
}

/**
 * A {@link IRemoteAccessConnector} that relays each connection to an agent host WebSocket listening
 * on a Unix socket or named pipe (such as the one `IAgentHostManagementService.startWebSocketServer`
 * starts). `resolveSocketPath(true)` is called again when the last path did not answer.
 */
export function createSocketRelayConnector(resolveSocketPath: (refresh: boolean) => Promise<string>, logService: ILogService): IRemoteAccessConnector {
	let wsModule: Promise<typeof wsTypes> | undefined;
	const connect = async (refresh: boolean): Promise<wsTypes.WebSocket> => {
		const ws = await (wsModule ??= import('ws'));
		const socketPath = await resolveSocketPath(refresh);
		const upstream = new ws.WebSocket(`ws+unix://${socketPath}:/`);
		await new Promise<void>((resolvePromise, reject) => {
			upstream.once('open', () => resolvePromise());
			upstream.once('error', reject);
		});
		return upstream;
	};

	return {
		handleConnection(socket: wsTypes.WebSocket): void {
			const pending: { data: wsTypes.RawData; isBinary: boolean }[] = [];
			let upstream: wsTypes.WebSocket | undefined;
			let closed = false;
			socket.on('message', (data, isBinary) => {
				if (upstream) {
					upstream.send(data, { binary: isBinary });
				} else {
					pending.push({ data, isBinary });
				}
			});
			socket.once('close', () => {
				closed = true;
				upstream?.close();
			});
			socket.on('error', () => socket.terminate());

			void (async () => {
				let connected: wsTypes.WebSocket;
				try {
					connected = await connect(false).catch(() => connect(true));
				} catch (error) {
					logService.error('[RemoteAccess] Could not reach the agent host', error);
					socket.close(1011, 'Agent host unavailable');
					return;
				}
				if (closed) {
					connected.close();
					return;
				}
				upstream = connected;
				connected.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
				connected.once('close', () => socket.close(1012, 'Agent host restarted'));
				connected.on('error', () => connected.terminate());
				for (const message of pending.splice(0)) {
					connected.send(message.data, { binary: message.isBinary });
				}
			})();
		},
	};
}

function parseRequestUrl(request: httpTypes.IncomingMessage): URL | undefined {
	try {
		return new URL(request.url ?? '/', 'http://localhost');
	} catch {
		return undefined;
	}
}

/**
 * The client's address for rate limiting. Behind a local proxy (Tailscale Funnel connects from
 * loopback) the first `X-Forwarded-For` address is used.
 */
function getClientAddress(request: httpTypes.IncomingMessage): string {
	const remote = request.socket.remoteAddress ?? 'unknown';
	const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
	const forwarded = request.headers['x-forwarded-for'];
	if (isLoopback && typeof forwarded === 'string' && forwarded.trim()) {
		return forwarded.split(',')[0].trim();
	}
	return remote;
}

function readBody(request: httpTypes.IncomingMessage): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('Request body too large'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}

function sendJson(response: httpTypes.ServerResponse, status: number, body: object): void {
	const text = JSON.stringify(body);
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(text);
}

function rejectUpgrade(socket: Socket, status: number, message: string): void {
	socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}
