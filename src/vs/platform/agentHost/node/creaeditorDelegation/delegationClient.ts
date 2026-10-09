/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the laptop side of Delegate to Server: talks to a CreaEditor Server's `/api/delegation/`
// routes with this device's key, and runs the delegate and Bring Back Changes steps.

import * as fs from 'fs';
import type * as http from 'http';
import { tmpdir } from 'os';
import { pipeline } from 'stream';
import { generateUuid } from '../../../../base/common/uuid.js';
import { join } from '../../../../base/common/path.js';
import { CREAEDITOR_DELEGATION_API_PREFIX, CREAEDITOR_DELEGATION_CHUNK_BYTES, DelegationAgentKind, DelegationErrorCode, DelegationProgressStage, IBringBackRequest, IBringBackResult, IDelegateRequest, IDelegateResult, IDelegationCreateRequest, IDelegationKnownCommitsResponse, IDelegationPullRequestResponse, IDelegationRecord, IDelegationResultsResponse, IDelegationServerKeyResponse, IDelegationServerTarget, IDelegationSessionRequest, IDelegationUploadResponse } from '../../common/creaeditorDelegation.js';
import { sealDelegationPayload } from './delegationCrypto.js';
import { DelegationError, packWorkspace, readDelegationRepository } from './delegationPack.js';
import { IDelegationProcessRunner, nodeDelegationProcessRunner } from './delegationProcess.js';
import { exportClaudeSession, getClaudeConfigDir } from './delegationSessionFiles.js';
import { importResultBundle } from './delegationWorktrees.js';

/** How often a request that failed on the network is tried again. */
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 120_000;

export interface IDelegationProgressReport {
	readonly stage: DelegationProgressStage;
	readonly bytesDone?: number;
	readonly bytesTotal?: number;
}

/** Sends one HTTP request and answers the response (whose body is not read yet). */
export type DelegationHttpTransport = (url: URL, options: { readonly method: string; readonly headers: Record<string, string>; readonly body?: Uint8Array | string }) => Promise<http.IncomingMessage>;

/** The transport over Node's `http`/`https` (the main process and the tests). */
export const nodeDelegationHttpTransport: DelegationHttpTransport = async (url, options) => {
	const module = url.protocol === 'https:' ? await import('https') : await import('http');
	return sendRequest(module.request, url, options);
};

function sendRequest(requestFn: typeof http.request, url: URL, options: { readonly method: string; readonly headers: Record<string, string>; readonly body?: Uint8Array | string }): Promise<http.IncomingMessage> {
	return new Promise((resolve, reject) => {
		const request = requestFn(url, { method: options.method, headers: options.headers, timeout: REQUEST_TIMEOUT_MS }, resolve);
		request.on('timeout', () => request.destroy(new Error('The request timed out.')));
		request.on('error', reject);
		request.end(options.body);
	});
}

function readResponse(response: http.IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		response.on('data', (chunk: Buffer) => chunks.push(chunk));
		response.on('end', () => resolve(Buffer.concat(chunks)));
		response.on('error', reject);
	});
}

async function readJsonResponse<T>(response: http.IncomingMessage): Promise<T | undefined> {
	try {
		return JSON.parse((await readResponse(response)).toString('utf8')) as T;
	} catch {
		return undefined;
	}
}

/** The `/api/delegation/` routes of one server. */
export class DelegationHttpClient {

	constructor(
		private readonly _server: Pick<IDelegationServerTarget, 'serverUrl' | 'deviceKey' | 'name'>,
		private readonly _transport: DelegationHttpTransport = nodeDelegationHttpTransport,
		private readonly _retryDelayMs = 1000,
	) { }

	private _url(path: string): URL {
		return new URL(`${this._server.serverUrl.replace(/\/+$/, '')}${CREAEDITOR_DELEGATION_API_PREFIX}${path}`);
	}

	/** Sends a request; retries network failures (the server may restart or the network may drop). */
	private async _request(method: string, path: string, body?: Uint8Array | string, retry = true): Promise<http.IncomingMessage> {
		let lastError: unknown;
		const attempts = retry ? MAX_ATTEMPTS : 1;
		for (let attempt = 1; attempt <= attempts; attempt++) {
			let response: http.IncomingMessage;
			try {
				response = await this._transport(this._url(path), {
					method,
					headers: {
						'Authorization': `Bearer ${this._server.deviceKey}`,
						...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : body ? { 'Content-Type': 'application/octet-stream' } : {}),
						...(body !== undefined ? { 'Content-Length': String(typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength) } : {}),
					},
					...(body !== undefined ? { body } : {}),
				});
			} catch (error) {
				lastError = error;
				if (attempt < attempts) {
					await new Promise(resolve => setTimeout(resolve, this._retryDelayMs * 2 ** (attempt - 1)));
				}
				continue;
			}
			const status = response.statusCode ?? 0;
			if (status === 401) {
				response.resume();
				throw new DelegationError(DelegationErrorCode.Unauthorized, `${this._server.name} does not accept this computer's key any more. Pair with it again.`);
			}
			if (status < 200 || status >= 300) {
				const answer = await readJsonResponse<{ error?: string; message?: string }>(response);
				if (status === 404 && !answer?.message) {
					// A server without the code receiver (an older version, or a desktop's Remote Access).
					throw new DelegationError(DelegationErrorCode.NotSupported, `${this._server.name} cannot receive delegated chats. Update CreaEditor Server there.`);
				}
				throw new DelegationError((answer?.error as DelegationErrorCode | undefined) ?? DelegationErrorCode.Unexpected, answer?.message ?? `${this._server.name} answered ${status}.`);
			}
			return response;
		}
		throw new DelegationError(DelegationErrorCode.Offline, `Cannot reach ${this._server.name} (${this._server.serverUrl}): ${lastError instanceof Error ? lastError.message : String(lastError)}. Check that the server runs and that this computer is online (Tailscale connected).`);
	}

	private async _json<T>(method: string, path: string, body?: object, retry = true): Promise<T> {
		const response = await this._request(method, path, body ? JSON.stringify(body) : undefined, retry);
		const value = await readJsonResponse<T>(response);
		if (value === undefined) {
			throw new DelegationError(DelegationErrorCode.Unexpected, `${this._server.name} answered something unexpected.`);
		}
		return value;
	}

	getKey(): Promise<IDelegationServerKeyResponse> {
		return this._json('GET', 'key');
	}

	async knownCommits(repoId: string): Promise<readonly string[]> {
		return (await this._json<IDelegationKnownCommitsResponse>('GET', `repos/${repoId}/known`)).commits;
	}

	/** Uploads a file in chunks; after a dropped connection it continues where the server stopped. */
	async upload(file: string, onProgress: (done: number, total: number) => void): Promise<string> {
		const uploadId = generateUuid().replace(/-/g, '');
		const total = fs.statSync(file).size;
		const handle = await fs.promises.open(file, 'r');
		try {
			let offset = 0;
			onProgress(0, total);
			let failures = 0;
			while (offset < total) {
				const length = Math.min(CREAEDITOR_DELEGATION_CHUNK_BYTES, total - offset);
				const chunk = new Uint8Array(length);
				await handle.read(chunk, 0, length, offset);
				try {
					const response = await this._request('PUT', `uploads/${uploadId}?offset=${offset}`, chunk, false);
					offset = (await readJsonResponse<IDelegationUploadResponse>(response))?.received ?? offset;
				} catch (error) {
					// A dropped connection, or a chunk the server already had: go on from what it has.
					const recoverable = error instanceof DelegationError && (error.code === DelegationErrorCode.Offline || error.code === DelegationErrorCode.InvalidRequest);
					if (!recoverable || ++failures >= MAX_ATTEMPTS) {
						throw error;
					}
					await new Promise(resolve => setTimeout(resolve, this._retryDelayMs * 2 ** (failures - 1)));
					offset = (await this._json<IDelegationUploadResponse>('GET', `uploads/${uploadId}`)).received;
					continue;
				}
				onProgress(offset, total);
			}
		} finally {
			await handle.close();
		}
		return uploadId;
	}

	create(request: IDelegationCreateRequest): Promise<IDelegationRecord> {
		// Retrying is safe: the server answers the same record for the same delegation id.
		return this._json('POST', 'delegations', request);
	}

	getDelegation(delegationId: string): Promise<IDelegationRecord> {
		return this._json('GET', `delegations/${delegationId}`);
	}

	installSession(delegationId: string, request: IDelegationSessionRequest): Promise<IDelegationRecord> {
		return this._json('POST', `delegations/${delegationId}/session`, request);
	}

	results(delegationId: string, knownCommits: readonly string[]): Promise<IDelegationResultsResponse> {
		return this._json('POST', `delegations/${delegationId}/results`, { knownCommits });
	}

	/** Downloads a result bundle to `outFile`. */
	async download(downloadId: string, outFile: string, onProgress: (done: number, total: number) => void): Promise<void> {
		const response = await this._request('GET', `downloads/${downloadId}`, undefined, false);
		const total = Number(response.headers['content-length'] ?? 0);
		let done = 0;
		response.on('data', (chunk: Buffer) => {
			done += chunk.length;
			onProgress(done, total);
		});
		await new Promise<void>((resolve, reject) => pipeline(response, fs.createWriteStream(outFile, { mode: 0o600 }), error => error ? reject(error) : resolve()));
		if (total && done !== total) {
			throw new DelegationError(DelegationErrorCode.Offline, `The download from ${this._server.name} stopped early. Try again.`);
		}
	}

	async pullRequest(delegationId: string, title?: string, body?: string): Promise<string> {
		return (await this._json<IDelegationPullRequestResponse>('POST', `delegations/${delegationId}/pull-request`, { ...(title ? { title } : {}), ...(body ? { body } : {}) }, false)).url;
	}

	async setGitHubToken(token: string): Promise<void> {
		await this._json('PUT', 'github-token', { token });
	}
}

export interface IDelegateChatOptions {
	readonly runner?: IDelegationProcessRunner;
	readonly transport?: DelegationHttpTransport;
	/** The Claude config folder of this machine (default `CLAUDE_CONFIG_DIR` or `~/.claude`). */
	readonly claudeConfigDir?: string;
	readonly onProgress?: (progress: IDelegationProgressReport) => void;
	readonly retryDelayMs?: number;
}

/**
 * Delegates a chat: packs and sends the code (only what the server lacks), lets the server create
 * the worktree, sends the agent's session files (Claude) and seals the accounts for the server.
 */
export async function delegateChat(request: IDelegateRequest, options: IDelegateChatOptions = {}): Promise<IDelegateResult> {
	const runner = options.runner ?? nodeDelegationProcessRunner;
	const client = new DelegationHttpClient(request.server, options.transport, options.retryDelayMs);
	const report = options.onProgress ?? (() => { });

	report({ stage: DelegationProgressStage.Packing });
	const serverKey = await client.getKey();
	const repository = await readDelegationRepository(request.folder, runner);
	const knownCommits = await client.knownCommits(repository.repoId);
	const workDir = fs.mkdtempSync(join(tmpdir(), 'creaeditor-delegate-'));
	try {
		const bundleFile = join(workDir, 'code.bundle');
		const packed = await packWorkspace({ folder: request.folder, outFile: bundleFile, knownCommits, includeSecretFiles: request.includeSecretFiles, maxBytes: request.maxUploadBytes }, runner);

		let uploadId: string | undefined;
		if (packed.bytes > 0) {
			uploadId = await client.upload(bundleFile, (done, total) => report({ stage: DelegationProgressStage.Uploading, bytesDone: done, bytesTotal: total }));
		}

		report({ stage: DelegationProgressStage.Preparing });
		const delegationId = generateUuid().replace(/-/g, '');
		const shortId = delegationId.slice(0, 8);
		let record = await client.create({
			delegationId,
			shortId,
			repoId: packed.repoId,
			head: packed.head,
			snapshot: packed.snapshot,
			subPath: packed.subPath,
			title: request.title,
			resultsMode: request.resultsMode,
			agent: request.agent,
			sourceName: request.sourceName,
			...(uploadId ? { uploadId } : {}),
			...(packed.remoteUrl ? { remoteUrl: packed.remoteUrl } : {}),
			...(packed.defaultBranch ? { defaultBranch: packed.defaultBranch } : {}),
			...(packed.branch ? { sourceBranch: packed.branch } : {}),
		});

		let sessionFilesSent = false;
		if (request.agent === DelegationAgentKind.Claude && request.agentSessionId) {
			const exported = exportClaudeSession({
				configDir: options.claudeConfigDir ?? getClaudeConfigDir(),
				sessionId: request.agentSessionId,
				fromCwd: fs.realpathSync(request.folder),
				toCwd: record.workingDirectory,
				fromRoot: fs.realpathSync(packed.root),
				toRoot: record.worktree,
			});
			if (exported) {
				record = await client.installSession(delegationId, { agent: DelegationAgentKind.Claude, sessionId: exported.sessionId, files: exported.files });
				sessionFilesSent = true;
			}
		}

		const accountsEnvelope = request.accounts && (request.accounts.claudeTokens?.length || request.accounts.gatewayKey)
			? sealDelegationPayload(JSON.stringify(request.accounts), serverKey.publicKey, delegationId)
			: undefined;

		report({ stage: DelegationProgressStage.Done });
		return {
			record,
			bytesSent: packed.bytes,
			incremental: packed.incremental,
			hasLocalChanges: packed.hasLocalChanges,
			skippedSecretFiles: packed.skippedSecretFiles,
			sessionFilesSent,
			...(accountsEnvelope ? { accountsEnvelope } : {}),
		};
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}

/**
 * Bring Back Changes: asks the server for a bundle of the chat's branch (with its uncommitted work as
 * a last commit) and stores it as a local branch, leaving the working tree as it is.
 */
export async function bringBackChanges(request: IBringBackRequest, options: IDelegateChatOptions = {}): Promise<IBringBackResult> {
	const runner = options.runner ?? nodeDelegationProcessRunner;
	const client = new DelegationHttpClient(request.server, options.transport, options.retryDelayMs);
	const report = options.onProgress ?? (() => { });
	const repository = await readDelegationRepository(request.folder, runner);
	const results = await client.results(request.delegationId, [request.baseCommit, repository.head]);
	const workDir = fs.mkdtempSync(join(tmpdir(), 'creaeditor-bring-back-'));
	try {
		let bundleFile: string | undefined;
		if (results.downloadId) {
			bundleFile = join(workDir, 'results.bundle');
			await client.download(results.downloadId, bundleFile, (done, total) => report({ stage: DelegationProgressStage.Downloading, bytesDone: done, bytesTotal: total }));
		}
		report({ stage: DelegationProgressStage.Importing });
		await importResultBundle(repository.root, { ...(bundleFile ? { bundleFile } : {}), commit: results.commit, branch: request.branch }, runner);
		report({ stage: DelegationProgressStage.Done });
		return { branch: request.branch, commit: results.commit, includesUncommitted: results.includesUncommitted, unchanged: results.commit === request.baseCommit };
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}
