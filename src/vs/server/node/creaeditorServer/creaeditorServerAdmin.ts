/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the admin endpoint of a running CreaEditor Server, on 127.0.0.1 only, for the
// `creaeditor-server pair | password | status` commands (pairing codes and the password live in the
// running server's memory). Requests need the token in `remote-access/admin-token` (0600), so only the
// user running the server (or root) can use it.

import { randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import type * as http from 'http';
import * as os from 'os';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { CreaEditorAgentHostState } from './creaeditorServerAgentHost.js';
import { writePrivateFile } from './creaeditorServerDataDir.js';

/** What `creaeditor-server status` shows: more than the public `/health`. */
export interface ICreaEditorServerStatus {
	readonly version: string;
	readonly commit?: string;
	readonly platform: string;
	readonly arch: string;
	readonly uptimeSeconds: number;
	readonly agentHost: CreaEditorAgentHostState;
	readonly publicMode: boolean;
	readonly hasPassword: boolean;
	readonly pairedDevices: number;
	readonly connections: number;
	/** The 1-minute load average divided by the number of cores, 0-100 (capped). */
	readonly cpuPercent: number;
	readonly cores: number;
	readonly memoryTotalBytes: number;
	readonly memoryFreeBytes: number;
}

/** What the machine reports, separate so tests can pass fixed numbers. */
export interface ICreaEditorServerMachine {
	readonly platform: string;
	readonly arch: string;
	readonly cores: number;
	readonly loadAverage: number;
	readonly totalBytes: number;
	readonly freeBytes: number;
	readonly now: number;
}

export function readMachine(): ICreaEditorServerMachine {
	return {
		platform: process.platform,
		arch: process.arch,
		cores: os.availableParallelism?.() ?? os.cpus().length,
		loadAverage: os.loadavg()[0],
		totalBytes: os.totalmem(),
		freeBytes: os.freemem(),
		now: Date.now(),
	};
}

export function createCreaEditorServerStatus(server: Omit<ICreaEditorServerStatus, 'platform' | 'arch' | 'uptimeSeconds' | 'cpuPercent' | 'cores' | 'memoryTotalBytes' | 'memoryFreeBytes'> & { readonly startedAt: number }, machine: ICreaEditorServerMachine): ICreaEditorServerStatus {
	const cores = Math.max(1, machine.cores);
	const { startedAt, ...rest } = server;
	return {
		...rest,
		platform: machine.platform,
		arch: machine.arch,
		uptimeSeconds: Math.max(0, Math.round((machine.now - startedAt) / 1000)),
		cpuPercent: Math.min(100, Math.round(machine.loadAverage / cores * 100)),
		cores,
		memoryTotalBytes: machine.totalBytes,
		memoryFreeBytes: machine.freeBytes,
	};
}

/** What the admin endpoint does; implemented by the server main. */
export interface ICreaEditorServerAdminHandler {
	/** A new one-time pairing code, and the link with it. */
	createPairing(): { readonly code: string; readonly expiresAt: number; readonly link: string };
	/** Sets the password, or removes it when `undefined`. Rejects a password that is too short. */
	setPassword(password: string | undefined): Promise<void>;
	getStatus(): ICreaEditorServerStatus;
}

export interface ICreaEditorServerAdmin extends IDisposable {
	readonly port: number;
}

const MAX_BODY_BYTES = 4096;

/** Reads (or creates) the admin token. */
export function readOrCreateAdminToken(file: string): string {
	try {
		const token = fs.readFileSync(file, 'utf8').trim();
		if (token) {
			return token;
		}
	} catch {
		// First run.
	}
	const token = randomBytes(32).toString('base64url');
	writePrivateFile(file, `${token}\n`);
	return token;
}

/** Starts the admin endpoint on 127.0.0.1 (a free port). */
export async function startCreaEditorServerAdmin(token: string, handler: ICreaEditorServerAdminHandler): Promise<ICreaEditorServerAdmin> {
	const { createServer } = await import('http');
	const expected = Buffer.from(`Bearer ${token}`);
	const server = createServer((request, response) => {
		const given = Buffer.from(request.headers.authorization ?? '');
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
			send(response, 401, { error: 'unauthorized' });
			return;
		}
		void handle(request, response).catch(error => send(response, 500, { error: error instanceof Error ? error.message : String(error) }));
	});

	const handle = async (request: http.IncomingMessage, response: http.ServerResponse) => {
		const path = new URL(request.url ?? '/', 'http://localhost').pathname;
		if (request.method === 'POST' && path === '/pair') {
			send(response, 200, handler.createPairing());
		} else if (request.method === 'POST' && path === '/password') {
			const body = JSON.parse(await readBody(request) || '{}') as { password?: unknown };
			if (body.password !== undefined && typeof body.password !== 'string') {
				send(response, 400, { error: 'badRequest' });
				return;
			}
			await handler.setPassword(body.password || undefined);
			send(response, 200, {});
		} else if (request.method === 'GET' && path === '/status') {
			send(response, 200, handler.getStatus());
		} else {
			send(response, 404, { error: 'notFound' });
		}
	};

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			const address = server.address();
			resolve({
				port: address && typeof address !== 'string' ? address.port : 0,
				dispose: () => server.close(),
			});
		});
	});
}

/** Calls the admin endpoint of the server running on this machine. */
export async function callCreaEditorServerAdmin<T>(port: number, token: string, method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method,
		headers: { 'Authorization': `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(10_000),
	});
	const value = await response.json() as T & { error?: string };
	if (!response.ok) {
		throw new Error(value.error ?? `HTTP ${response.status}`);
	}
	return value;
}

function send(response: http.ServerResponse, status: number, body: object): void {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(body));
}

function readBody(request: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
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
		request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		request.on('error', reject);
	});
}
