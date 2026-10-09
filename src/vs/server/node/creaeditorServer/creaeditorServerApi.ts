/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the CreaEditor Server's own API for paired laptops, under `/api/server/` (every route
// needs a device key; Remote Access answers 401 without one):
//
// - `POST pairing`: a new one-time pairing code and its link, so "Pair Phone" on the laptop shows a
//   QR code that pairs at once;
// - `GET costs?after=<cursor>`: new entries of the server's AI cost ledger;
// - `PUT costs/budgets`: the laptop's hard-stop budgets, with what it spent elsewhere.

import type * as http from 'http';
import { ILogService } from '../../../platform/log/common/log.js';
import { IRemoteAccessApiHandler } from '../../../platform/agentHost/node/remoteAccess/remoteAccessServer.js';
import { CREAEDITOR_SERVER_API_BUDGETS, CREAEDITOR_SERVER_API_COSTS, CREAEDITOR_SERVER_API_PAIRING, CREAEDITOR_SERVER_API_PREFIX, ICreaEditorServerPairingResponse, parseServerCostBudgets } from '../../../platform/agentHost/common/creaeditorCosts.js';
import { readServerCostEntries, writeServerCostBudgets } from '../../../platform/agentHost/node/shared/serverCostLedger.js';

const MAX_BODY_BYTES = 256 * 1024;

export interface ICreaEditorServerApiOptions {
	/** The cost ledger folder (shared with the agent host, which writes the ledger). */
	readonly costsDir: string;
	/** A new one-time pairing code. */
	readonly createPairing: () => ICreaEditorServerPairingResponse;
	readonly logService: ILogService;
}

/** Creates the `/api/server/` route group; see the top of this file. */
export function createCreaEditorServerApi(options: ICreaEditorServerApiOptions): IRemoteAccessApiHandler {
	return {
		prefix: CREAEDITOR_SERVER_API_PREFIX,
		async handle(request, response, path, url, device) {
			const method = request.method ?? 'GET';
			if (path === CREAEDITOR_SERVER_API_PAIRING && method === 'POST') {
				options.logService.info(`[CreaEditor Server] Device "${device.name}" created a pairing code`);
				sendJson(response, 200, options.createPairing());
				return;
			}
			if (path === CREAEDITOR_SERVER_API_COSTS && method === 'GET') {
				const after = Number(url.searchParams.get('after') ?? '0');
				sendJson(response, 200, readServerCostEntries(options.costsDir, Number.isFinite(after) ? after : 0));
				return;
			}
			if (path === CREAEDITOR_SERVER_API_BUDGETS && method === 'PUT') {
				let body: unknown;
				try {
					body = JSON.parse(await readBody(request));
				} catch {
					sendJson(response, 400, { error: 'badRequest' });
					return;
				}
				const budgets = parseServerCostBudgets(body);
				if (!budgets) {
					sendJson(response, 400, { error: 'badRequest' });
					return;
				}
				writeServerCostBudgets(options.costsDir, budgets);
				sendJson(response, 200, { budgets: budgets.budgets.length });
				return;
			}
			sendJson(response, 404, { error: 'notFound' });
		},
	};
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

function sendJson(response: http.ServerResponse, status: number, body: object): void {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(body));
}
