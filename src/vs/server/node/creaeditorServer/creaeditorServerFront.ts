/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the basic front of the CreaEditor Server, used until the remote access module (web Agents
// window, pairing, device keys, password, rate limiting) is wired in: `/health`, and the agent host
// WebSocket for clients that present the server's access token (`?tkn=`), proxied to the agent host on
// 127.0.0.1 with its private token.
// TODO(CreaEditor remote access): replace with `src/vs/platform/agentHost/node/remoteAccess/` once it lands.

import { timingSafeEqual } from 'crypto';
import * as http from 'http';
import * as net from 'net';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { CREAEDITOR_SERVER_HEALTH_PATH, ICreaEditorServerHealth } from '../../../platform/agentHost/common/creaeditorServer.js';
import { ICreaEditorAgentHostEndpoint } from './creaeditorServerAgentHost.js';

export interface ICreaEditorServerFrontOptions {
	readonly host: string;
	readonly port: number;
	/** The token a client must present as `?tkn=`. */
	readonly accessToken: string;
	readonly getHealth: (front: ICreaEditorServerFront) => ICreaEditorServerHealth;
	readonly getAgentHost: () => ICreaEditorAgentHostEndpoint | undefined;
	readonly log: (message: string) => void;
}

export interface ICreaEditorServerFront extends IDisposable {
	/** The port it listens on (the given one, or the one the system chose for port 0). */
	readonly port: number;
	readonly connectedClients: number;
}

function tokenMatches(given: string | null, expected: string): boolean {
	if (!given) {
		return false;
	}
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Starts the basic front; resolves once it listens. */
export function startBasicFront(options: ICreaEditorServerFrontOptions): Promise<ICreaEditorServerFront> {
	const sockets = new Set<net.Socket>();
	let connectedClients = 0;

	const server = http.createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		if (request.method === 'GET' && url.pathname === CREAEDITOR_SERVER_HEALTH_PATH) {
			const health = options.getHealth(front);
			response.writeHead(health.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			response.end(JSON.stringify(health));
			return;
		}
		if (request.method === 'GET' && url.pathname === '/') {
			response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end('CreaEditor Server is running. Add it in CreaEditor with Add CreaEditor Server.\n');
			return;
		}
		response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
		response.end('Not found\n');
	});

	server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
		const url = new URL(request.url ?? '/', 'http://localhost');
		const agentHost = options.getAgentHost();
		if (!tokenMatches(url.searchParams.get('tkn'), options.accessToken)) {
			options.log(`Refused a connection from ${request.socket.remoteAddress}: wrong or missing access token.`);
			socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
			return;
		}
		if (!agentHost) {
			socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
			return;
		}
		url.searchParams.set('tkn', agentHost.connectionToken);
		const upstream = net.connect(agentHost.port, agentHost.host);
		sockets.add(socket);
		sockets.add(upstream);
		connectedClients++;
		let closed = false;
		const close = () => {
			if (closed) {
				return;
			}
			closed = true;
			connectedClients--;
			sockets.delete(socket);
			sockets.delete(upstream);
			socket.destroy();
			upstream.destroy();
		};
		upstream.once('connect', () => {
			const headers: string[] = [];
			for (let index = 0; index < request.rawHeaders.length; index += 2) {
				const name = request.rawHeaders[index];
				headers.push(`${name}: ${name.toLowerCase() === 'host' ? `${agentHost.host}:${agentHost.port}` : request.rawHeaders[index + 1]}`);
			}
			upstream.write(`${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
			if (head.length) {
				upstream.write(head);
			}
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
		upstream.on('error', close);
		upstream.on('close', close);
		socket.on('error', close);
		socket.on('close', close);
	});

	const front: ICreaEditorServerFront = {
		get port() {
			const address = server.address();
			return address && typeof address !== 'string' ? address.port : options.port;
		},
		get connectedClients() {
			return connectedClients;
		},
		dispose() {
			for (const socket of sockets) {
				socket.destroy();
			}
			server.close();
		},
	};

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, options.host, () => {
			server.off('error', reject);
			resolve(front);
		});
	});
}
