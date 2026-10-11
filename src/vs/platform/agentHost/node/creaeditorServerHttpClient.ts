/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: sends CreaEditor Server API requests and ntfy test notifications over Node's http/https
// (no CORS or CSP), for the main process, see `common/creaeditorServerHttp.ts`.

import type * as http from 'http';
import { ICreaEditorNotificationTarget } from '../common/creaeditorNotifications.js';
import { CREAEDITOR_SERVER_HTTP_MAX_RESPONSE_BYTES, createNtfyTestRequest, ICreaEditorServerHttpRequest, ICreaEditorServerHttpResponse, ICreaEditorServerHttpService, validateCreaEditorServerHttpRequest } from '../common/creaeditorServerHttp.js';

const NTFY_TIMEOUT_MS = 10_000;

/** Sends one request and reads its whole answer (at most {@link CREAEDITOR_SERVER_HTTP_MAX_RESPONSE_BYTES}). */
async function send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<ICreaEditorServerHttpResponse> {
	const module = url.protocol === 'https:' ? await import('https') : await import('http');
	return new Promise<ICreaEditorServerHttpResponse>((resolve, reject) => {
		const request = module.request(url, { method, headers, timeout: timeoutMs }, (response: http.IncomingMessage) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > CREAEDITOR_SERVER_HTTP_MAX_RESPONSE_BYTES) {
					request.destroy(new Error('The answer is too large.'));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', reject);
		});
		request.on('timeout', () => request.destroy(new Error('The request timed out.')));
		request.on('error', reject);
		request.end(body);
	});
}

/** {@link ICreaEditorServerHttpService} over Node's http/https. */
export class NodeCreaEditorServerHttpService implements ICreaEditorServerHttpService {
	declare readonly _serviceBrand: undefined;

	async request(request: ICreaEditorServerHttpRequest): Promise<ICreaEditorServerHttpResponse> {
		const valid = validateCreaEditorServerHttpRequest(request);
		if ('error' in valid) {
			throw new Error(valid.error);
		}
		return send(valid.url, valid.method, valid.headers, valid.body, valid.timeoutMs);
	}

	async sendNtfyTestNotification(target: ICreaEditorNotificationTarget, title: string, message: string): Promise<number> {
		const request = createNtfyTestRequest(target, title, message);
		if ('error' in request) {
			throw new Error(request.error);
		}
		return (await send(new URL(request.url), 'POST', request.headers, request.body, NTFY_TIMEOUT_MS)).status;
	}
}
