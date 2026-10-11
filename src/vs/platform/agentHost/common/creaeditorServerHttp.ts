/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the desktop windows reach a CreaEditor Server's HTTP API (`/health`, `/api/...`) through
// the main process. From the renderer, `fetch` is blocked by CORS (the server sends no
// `Access-Control-Allow-Origin`) and by the window CSP (`connect-src` has no `http:`, so plain
// `http://100.x.y.z:31600` Tailscale addresses fail). The main process only forwards requests that
// look like CreaEditor Server API calls, see {@link validateCreaEditorServerHttpRequest}, and builds the
// ntfy test notification itself, see {@link createNtfyTestRequest}.

import { createDecorator } from '../../instantiation/common/instantiation.js';
import { createNtfyRequest, ICreaEditorNotificationTarget, INtfyRequest, parseNotificationTarget } from './creaeditorNotifications.js';

export const CREAEDITOR_SERVER_HTTP_CHANNEL_NAME = 'creaeditorServerHttp';

/** The longest a request may take, and the default. */
export const CREAEDITOR_SERVER_HTTP_MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;

/** The largest response body that is passed back (cost ledgers are the biggest answers). */
export const CREAEDITOR_SERVER_HTTP_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type CreaEditorServerHttpMethod = 'GET' | 'POST' | 'PUT';

/** One request to a CreaEditor Server's API. */
export interface ICreaEditorServerHttpRequest {
	/** `http(s)://host[:port]/health` or `http(s)://host[:port]/api/...`, optionally with a query. */
	readonly url: string;
	readonly method: CreaEditorServerHttpMethod;
	/** Only `Authorization` and `Content-Type` are sent. */
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	readonly timeoutMs?: number;
}

/** The server's answer: HTTP status and body text. */
export interface ICreaEditorServerHttpResponse {
	readonly status: number;
	readonly body: string;
}

/** A request that passed {@link validateCreaEditorServerHttpRequest}, ready to send. */
export interface IValidCreaEditorServerHttpRequest {
	readonly url: URL;
	readonly method: CreaEditorServerHttpMethod;
	readonly headers: Record<string, string>;
	readonly body?: string;
	readonly timeoutMs: number;
}

const ALLOWED_METHODS: readonly string[] = ['GET', 'POST', 'PUT'];
const ALLOWED_HEADERS: readonly string[] = ['authorization', 'content-type'];

/**
 * Checks that a request is a CreaEditor Server API call and not an arbitrary request: http or https,
 * no credentials in the URL, path `/health` or under `/api/` (without `.` or `..` segments), GET/POST/PUT
 * and only the `Authorization` and `Content-Type` headers. Answers the request to send, or why it is
 * refused.
 */
export function validateCreaEditorServerHttpRequest(request: ICreaEditorServerHttpRequest): IValidCreaEditorServerHttpRequest | { readonly error: string } {
	let url: URL;
	try {
		url = new URL(request.url);
	} catch {
		return { error: 'The URL is not valid.' };
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return { error: 'Only http and https URLs are allowed.' };
	}
	if (url.username || url.password) {
		return { error: 'URLs with credentials are not allowed.' };
	}
	// `new URL` already resolved `.` and `..`; also refuse their percent-encoded forms.
	const segments = url.pathname.split('/');
	if (segments.some(segment => /^(?:\.|%2e){1,2}$/i.test(segment)) || /%2f|%5c/i.test(url.pathname)) {
		return { error: 'The path is not allowed.' };
	}
	if (url.pathname !== '/health' && !url.pathname.startsWith('/api/')) {
		return { error: 'Only /health and /api/ paths are allowed.' };
	}
	if (!ALLOWED_METHODS.includes(request.method)) {
		return { error: 'The method is not allowed.' };
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(request.headers ?? {})) {
		if (!ALLOWED_HEADERS.includes(name.toLowerCase())) {
			return { error: `The header ${name} is not allowed.` };
		}
		if (typeof value !== 'string' || /[\r\n]/.test(value)) {
			return { error: `The header ${name} is not valid.` };
		}
		headers[name] = value;
	}
	if (request.body !== undefined && typeof request.body !== 'string') {
		return { error: 'The body must be text.' };
	}
	const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0
		? Math.min(request.timeoutMs, CREAEDITOR_SERVER_HTTP_MAX_TIMEOUT_MS)
		: DEFAULT_TIMEOUT_MS;
	return { url, method: request.method, headers, ...(request.body !== undefined ? { body: request.body } : {}), timeoutMs };
}

/** The longest title and message of a test notification. */
const NTFY_TEST_MAX_TEXT_LENGTH = 500;

/**
 * The ntfy publish request of a test notification to `target` (a valid ntfy topic URL), or why it is
 * refused. The payload is fixed apart from the (shortened) title and message, so this cannot be used
 * to send arbitrary requests.
 */
export function createNtfyTestRequest(target: ICreaEditorNotificationTarget, title: string, message: string): INtfyRequest | { readonly error: string } {
	const parsed = parseNotificationTarget(target);
	if (!parsed || typeof title !== 'string' || typeof message !== 'string') {
		return { error: 'The notification topic is not valid.' };
	}
	return createNtfyRequest(parsed, {
		title: title.slice(0, NTFY_TEST_MAX_TEXT_LENGTH),
		message: message.slice(0, NTFY_TEST_MAX_TEXT_LENGTH),
		priority: 3,
		tags: ['tada'],
	});
}

export const ICreaEditorServerHttpService = createDecorator<ICreaEditorServerHttpService>('creaeditorServerHttpService');

/** Sends CreaEditor Server API requests (in the desktop app from the main process). */
export interface ICreaEditorServerHttpService {
	readonly _serviceBrand: undefined;

	/** Sends the request; rejects when it is refused or the server cannot be reached. */
	request(request: ICreaEditorServerHttpRequest): Promise<ICreaEditorServerHttpResponse>;

	/** Publishes a test notification to an ntfy topic; resolves with the ntfy server's HTTP status. */
	sendNtfyTestNotification(target: ICreaEditorNotificationTarget, title: string, message: string): Promise<number>;
}
