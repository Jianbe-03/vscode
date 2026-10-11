/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the code receiver of a CreaEditor Server, for Delegate to Server. Paired devices reach it
// through the Remote Access front under `/api/delegation/` with their device key. It keeps bare
// repositories, one worktree per delegated chat, the agents' session files of delegated chats, and
// answers Bring Back Changes and Open PR from the Server. See
// `src/vs/platform/agentHost/node/creaeditorDelegation/README.md` for the protocol.

import * as fs from 'fs';
import type * as httpTypes from 'http';
import { homedir } from 'os';
import { generateUuid } from '../../../base/common/uuid.js';
import { join } from '../../../base/common/path.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { CREAEDITOR_DELEGATION_API_PREFIX, CREAEDITOR_DELEGATION_CHUNK_BYTES, CREAEDITOR_DELEGATION_GITHUB_TOKEN_SECRET_NAME, CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME, DelegationAgentKind, DelegationErrorCode, DelegationResultsMode, IDelegationCreateRequest, IDelegationKnownCommitsResponse, IDelegationPullRequestResponse, IDelegationRecord, IDelegationResultsResponse, IDelegationServerKeyResponse, IDelegationSessionRequest, IDelegationUploadResponse } from '../../../platform/agentHost/common/creaeditorDelegation.js';
import { getDelegationSecretsDir } from '../../../platform/agentHost/node/creaeditorDelegation/delegationAccounts.js';
import { generateDelegationKeyPair, IDelegationKeyPair } from '../../../platform/agentHost/node/creaeditorDelegation/delegationCrypto.js';
import { DelegationError } from '../../../platform/agentHost/node/creaeditorDelegation/delegationPack.js';
import { IDelegationProcessRunner, nodeDelegationProcessRunner } from '../../../platform/agentHost/node/creaeditorDelegation/delegationProcess.js';
import { getClaudeConfigDir, getCopilotCliHome, installSessionFiles } from '../../../platform/agentHost/node/creaeditorDelegation/delegationSessionFiles.js';
import { resolveDefaultCodexHome } from '../../../platform/agentHost/node/codex/codexAccountHomes.js';
import { AgentHostCodexAgentCodexHomeEnvVar } from '../../../platform/agentHost/common/agentService.js';
import { assertDelegationId, createResultBundle, IDelegationStoreLayout, listKnownCommits, nameExistingDelegationRepositories, openPullRequestFromServer, prepareDelegationWorktree } from '../../../platform/agentHost/node/creaeditorDelegation/delegationWorktrees.js';
import { FileSecretStore } from '../../../platform/agentHost/node/shared/fileSecretStore.js';
import type { IRemoteAccessApiHandler } from '../../../platform/agentHost/node/remoteAccess/remoteAccessServer.js';
import type { IRemoteAccessDevice } from '../../../platform/agentHost/node/remoteAccess/remoteAccessAuth.js';

/** The largest upload (one bundle). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
/** The largest JSON request (session files are in it, base64). */
const MAX_JSON_BYTES = 96 * 1024 * 1024;
/** Unfinished uploads and unfetched result bundles are removed after this long. */
const STALE_TRANSFER_MS = 24 * 60 * 60 * 1000;

/** Where the code receiver keeps its files, in the server's data folder. */
export interface ICreaEditorDelegationLayout extends IDelegationStoreLayout {
	/** Records of delegated chats (`<id>.json`), uploads and downloads. */
	readonly delegations: string;
	/** The receiver's own secret store (key pair, GitHub token); the agent host reads the key pair. */
	readonly secrets: string;
}

/** The receiver's folders under the server's data folder; `secretsDir` is the server's secret store folder. */
export function getCreaEditorDelegationLayout(dataRoot: string, secretsDir: string): ICreaEditorDelegationLayout {
	return {
		repos: join(dataRoot, 'repos'),
		worktrees: join(dataRoot, 'worktrees'),
		delegations: join(dataRoot, 'delegations'),
		secrets: getDelegationSecretsDir(secretsDir),
	};
}

/** Reads the server's key pair from the receiver's secret store, creating it on first use. */
export async function readOrCreateDelegationKeyPair(store: FileSecretStore): Promise<IDelegationKeyPair> {
	const stored = store.get(CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME);
	if (stored) {
		return JSON.parse(stored) as IDelegationKeyPair;
	}
	const keyPair = generateDelegationKeyPair();
	await store.set(CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME, JSON.stringify(keyPair));
	return keyPair;
}

export interface ICreaEditorDelegationApiOptions {
	readonly layout: ICreaEditorDelegationLayout;
	/** The server's name in commit messages ("Uncommitted changes from <name>"). */
	readonly serverName: string;
	readonly logService: ILogService;
	/** Replaces `git`/`gh`, for tests. */
	readonly runner?: IDelegationProcessRunner;
	/** The Claude config folder of the agent host (default: `CLAUDE_CONFIG_DIR` or `~/.claude`). */
	readonly claudeConfigDir?: string;
	/** The CODEX_HOME of the agent host (default: its Codex home setting, `CODEX_HOME` or `~/.codex`). */
	readonly codexHome?: string;
	/** The Copilot CLI home of the agent host (default: `COPILOT_HOME` or `~/.copilot`). */
	readonly copilotHome?: string;
}

class HttpError extends Error {
	constructor(readonly status: number, readonly code: DelegationErrorCode, message: string) {
		super(message);
	}
}

/** The `/api/delegation/` routes of a CreaEditor Server. */
export class CreaEditorDelegationApi implements IRemoteAccessApiHandler {

	readonly prefix = CREAEDITOR_DELEGATION_API_PREFIX;

	private readonly _runner: IDelegationProcessRunner;
	private readonly _store: FileSecretStore;
	private readonly _uploads: string;
	private readonly _downloads: string;
	/** One git operation per repository at a time. */
	private readonly _repoQueues = new Map<string, Promise<unknown>>();
	private _keyPair: Promise<IDelegationKeyPair> | undefined;
	private _hasGh: Promise<boolean> | undefined;

	constructor(private readonly _options: ICreaEditorDelegationApiOptions) {
		this._runner = _options.runner ?? nodeDelegationProcessRunner;
		const { layout } = _options;
		for (const dir of [layout.repos, layout.worktrees, layout.delegations]) {
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		this._uploads = join(layout.delegations, 'uploads');
		this._downloads = join(layout.delegations, 'downloads');
		fs.mkdirSync(this._uploads, { recursive: true, mode: 0o700 });
		fs.mkdirSync(this._downloads, { recursive: true, mode: 0o700 });
		this._store = new FileSecretStore(layout.secrets);
		this._removeStaleTransfers();
		this._nameExistingRepositories();
	}

	/** Bare repositories from before they kept their repository's name get it from their chats' worktree folders. */
	private _nameExistingRepositories(): void {
		const records: IDelegationRecord[] = [];
		for (const name of fs.readdirSync(this._options.layout.delegations)) {
			if (!name.endsWith('.json')) {
				continue;
			}
			try {
				records.push(JSON.parse(fs.readFileSync(join(this._options.layout.delegations, name), 'utf8')) as IDelegationRecord);
			} catch {
				// Not a record.
			}
		}
		nameExistingDelegationRepositories(this._options.layout, records.filter(record => typeof record?.repoId === 'string' && typeof record.shortId === 'string' && typeof record.worktree === 'string'));
	}

	/** The key pair (created on first use). Call once at startup so the agent host can read it. */
	getKeyPair(): Promise<IDelegationKeyPair> {
		this._keyPair ??= readOrCreateDelegationKeyPair(this._store);
		return this._keyPair;
	}

	async handle(request: httpTypes.IncomingMessage, response: httpTypes.ServerResponse, path: string, url: URL, device: IRemoteAccessDevice): Promise<void> {
		const method = request.method ?? 'GET';
		const parts = path.split('/').filter(Boolean);
		try {
			if (method === 'GET' && path === 'key') {
				return sendJson(response, 200, await this._getKey());
			}
			if (method === 'PUT' && path === 'github-token') {
				const body = await readJson<{ token?: unknown }>(request);
				if (typeof body.token !== 'string') {
					throw new HttpError(400, DelegationErrorCode.InvalidRequest, 'Missing token.');
				}
				if (body.token.trim()) {
					await this._store.set(CREAEDITOR_DELEGATION_GITHUB_TOKEN_SECRET_NAME, body.token.trim());
				} else {
					await this._store.delete(CREAEDITOR_DELEGATION_GITHUB_TOKEN_SECRET_NAME);
				}
				this._options.logService.info(`[Delegation] GitHub token ${body.token.trim() ? 'set' : 'removed'} by device "${device.name}"`);
				return sendJson(response, 200, {});
			}
			if (method === 'GET' && parts[0] === 'repos' && parts[2] === 'known' && parts.length === 3) {
				assertDelegationId(parts[1], 'repository id');
				const commits = await this._inRepo(parts[1], () => listKnownCommits(this._options.layout, parts[1], this._runner));
				return sendJson(response, 200, { commits } satisfies IDelegationKnownCommitsResponse);
			}
			if (parts[0] === 'uploads' && parts.length === 2) {
				assertDelegationId(parts[1], 'upload id');
				if (method === 'GET') {
					return sendJson(response, 200, { received: this._uploadSize(parts[1]) } satisfies IDelegationUploadResponse);
				}
				if (method === 'PUT') {
					return sendJson(response, 200, await this._receiveChunk(request, parts[1], Number(url.searchParams.get('offset') ?? 'NaN')));
				}
			}
			if (method === 'GET' && parts[0] === 'downloads' && parts.length === 2) {
				assertDelegationId(parts[1], 'download id');
				return this._sendDownload(response, parts[1]);
			}
			if (method === 'POST' && path === 'delegations') {
				const record = await this._create(await readJson<IDelegationCreateRequest>(request), device);
				return sendJson(response, 200, record);
			}
			if (parts[0] === 'delegations' && parts.length >= 2) {
				assertDelegationId(parts[1], 'delegation id');
				const record = this._readRecord(parts[1]);
				if (method === 'GET' && parts.length === 2) {
					return sendJson(response, 200, record);
				}
				if (method === 'POST' && parts[2] === 'session' && parts.length === 3) {
					return sendJson(response, 200, await this._installSession(record, await readJson<IDelegationSessionRequest>(request)));
				}
				if (method === 'POST' && parts[2] === 'results' && parts.length === 3) {
					const body = await readJson<{ knownCommits?: unknown }>(request);
					const knownCommits = Array.isArray(body.knownCommits) ? body.knownCommits.filter((value): value is string => typeof value === 'string').slice(0, 256) : [];
					return sendJson(response, 200, await this._createResults(record, knownCommits));
				}
				if (method === 'POST' && parts[2] === 'pull-request' && parts.length === 3) {
					const body = await readJson<{ title?: unknown; body?: unknown }>(request);
					return sendJson(response, 200, await this._openPullRequest(record, typeof body.title === 'string' ? body.title : undefined, typeof body.body === 'string' ? body.body : undefined));
				}
			}
			throw new HttpError(404, DelegationErrorCode.NotFound, 'Not found.');
		} catch (error) {
			if (error instanceof HttpError) {
				return sendJson(response, error.status, { error: error.code, message: error.message });
			}
			if (error instanceof DelegationError) {
				const status = error.code === DelegationErrorCode.NotFound ? 404 : error.code === DelegationErrorCode.InvalidRequest ? 400 : 409;
				return sendJson(response, status, { error: error.code, message: error.message });
			}
			this._options.logService.error('[Delegation] Request failed', error);
			return sendJson(response, 500, { error: DelegationErrorCode.Unexpected, message: error instanceof Error ? error.message : String(error) });
		}
	}

	private async _getKey(): Promise<IDelegationServerKeyResponse> {
		const keyPair = await this.getKeyPair();
		this._hasGh ??= this._runner.run('gh', ['--version'], { cwd: this._options.layout.delegations }).then(result => result.code === 0);
		return {
			publicKey: keyPair.publicKey,
			hasGitHubToken: this._store.has(CREAEDITOR_DELEGATION_GITHUB_TOKEN_SECRET_NAME),
			hasGh: await this._hasGh,
			worktreesDir: this._options.layout.worktrees,
			repositoriesDir: this._options.layout.repos,
			agentHome: homedir(),
		};
	}

	private _inRepo<T>(repoId: string, task: () => Promise<T>): Promise<T> {
		const previous = this._repoQueues.get(repoId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(task);
		this._repoQueues.set(repoId, next);
		void next.finally(() => {
			if (this._repoQueues.get(repoId) === next) {
				this._repoQueues.delete(repoId);
			}
		}).catch(() => undefined);
		return next;
	}

	private _uploadFile(uploadId: string): string {
		return join(this._uploads, `${uploadId}.bundle`);
	}

	private _uploadSize(uploadId: string): number {
		try {
			return fs.statSync(this._uploadFile(uploadId)).size;
		} catch {
			return 0;
		}
	}

	private async _receiveChunk(request: httpTypes.IncomingMessage, uploadId: string, offset: number): Promise<IDelegationUploadResponse> {
		const received = this._uploadSize(uploadId);
		if (!Number.isInteger(offset) || offset !== received) {
			// The client resumes from what the server has.
			request.resume();
			throw new HttpError(409, DelegationErrorCode.InvalidRequest, `Expected offset ${received}.`);
		}
		const chunk = await readRaw(request, CREAEDITOR_DELEGATION_CHUNK_BYTES * 2);
		if (received + chunk.length > MAX_UPLOAD_BYTES) {
			throw new HttpError(413, DelegationErrorCode.TooLarge, 'The upload is too large.');
		}
		await fs.promises.appendFile(this._uploadFile(uploadId), chunk, { mode: 0o600 });
		return { received: received + chunk.length };
	}

	private _recordFile(delegationId: string): string {
		return join(this._options.layout.delegations, `${delegationId}.json`);
	}

	private _readRecord(delegationId: string): IDelegationRecord {
		try {
			return JSON.parse(fs.readFileSync(this._recordFile(delegationId), 'utf8')) as IDelegationRecord;
		} catch {
			throw new HttpError(404, DelegationErrorCode.NotFound, 'The server does not know this delegated chat.');
		}
	}

	private _writeRecord(record: IDelegationRecord): void {
		const file = this._recordFile(record.delegationId);
		const temp = `${file}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(record, undefined, '\t'), { mode: 0o600 });
		fs.renameSync(temp, file);
	}

	private async _create(input: Partial<IDelegationCreateRequest>, device: IRemoteAccessDevice): Promise<IDelegationRecord> {
		for (const [name, value] of [['delegationId', input.delegationId], ['shortId', input.shortId], ['repoId', input.repoId], ['head', input.head], ['snapshot', input.snapshot], ['title', input.title], ['subPath', input.subPath]] as const) {
			if (typeof value !== 'string') {
				throw new HttpError(400, DelegationErrorCode.InvalidRequest, `Missing ${name}.`);
			}
		}
		const body = input as IDelegationCreateRequest;
		assertDelegationId(body.delegationId, 'delegation id');
		if (fs.existsSync(this._recordFile(body.delegationId))) {
			// The laptop retried after the server answered: answer the same record.
			return this._readRecord(body.delegationId);
		}
		let bundleFile: string | undefined;
		if (body.uploadId !== undefined) {
			assertDelegationId(body.uploadId, 'upload id');
			bundleFile = this._uploadFile(body.uploadId);
			if (!fs.existsSync(bundleFile)) {
				throw new HttpError(400, DelegationErrorCode.InvalidRequest, 'The upload is missing; send the code again.');
			}
		}
		const prepared = await this._inRepo(body.repoId, () => prepareDelegationWorktree(this._options.layout, {
			repoId: body.repoId,
			delegationId: body.delegationId,
			shortId: body.shortId,
			head: body.head,
			snapshot: body.snapshot,
			subPath: body.subPath,
			...(typeof body.repoName === 'string' && body.repoName ? { repoName: body.repoName.slice(0, 200) } : {}),
			...(bundleFile ? { bundleFile } : {}),
			...(typeof body.remoteUrl === 'string' && body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
		}, this._runner));
		if (bundleFile) {
			fs.rmSync(bundleFile, { force: true });
		}
		const record: IDelegationRecord = {
			delegationId: body.delegationId,
			shortId: body.shortId,
			repoId: body.repoId,
			branch: prepared.branch,
			worktree: prepared.worktree,
			workingDirectory: prepared.workingDirectory,
			baseCommit: body.head,
			resultsMode: body.resultsMode === DelegationResultsMode.PullRequest ? DelegationResultsMode.PullRequest : DelegationResultsMode.BringBack,
			agent: body.agent,
			title: String(body.title).slice(0, 200),
			sourceName: typeof body.sourceName === 'string' ? body.sourceName.slice(0, 100) : device.name,
			createdAt: Date.now(),
			...(typeof body.remoteUrl === 'string' && body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
			...(typeof body.defaultBranch === 'string' && body.defaultBranch ? { defaultBranch: body.defaultBranch } : {}),
		};
		this._writeRecord(record);
		this._options.logService.info(`[Delegation] Device "${device.name}" delegated a chat into ${prepared.worktree} (${prepared.branch})`);
		return record;
	}

	private async _installSession(record: IDelegationRecord, body: Partial<IDelegationSessionRequest>): Promise<IDelegationRecord> {
		if (typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.sessionId) || !Array.isArray(body.files)) {
			throw new HttpError(400, DelegationErrorCode.InvalidRequest, 'Invalid session.');
		}
		const sessionId = body.sessionId;
		// Where each agent keeps its sessions, and the only folder a session's files may go into.
		let agentDir: string;
		let isOwnFile: (relativePath: string) => boolean;
		switch (body.agent) {
			case DelegationAgentKind.Claude:
				agentDir = this._options.claudeConfigDir ?? getClaudeConfigDir();
				isOwnFile = path => path.startsWith('projects/') && path.includes(sessionId);
				break;
			case DelegationAgentKind.Codex:
				agentDir = this._options.codexHome ?? resolveDefaultCodexHome(process.env[AgentHostCodexAgentCodexHomeEnvVar], homedir());
				isOwnFile = path => path.startsWith('sessions/') && path.endsWith(`-${sessionId}.jsonl`);
				break;
			case DelegationAgentKind.CopilotCli:
				agentDir = this._options.copilotHome ?? getCopilotCliHome();
				isOwnFile = path => path.startsWith(`session-state/${sessionId}/`);
				break;
			default:
				throw new HttpError(400, DelegationErrorCode.NotSupported, 'This agent\'s sessions cannot resume on the server; the chat continues with a transcript.');
		}
		if (record.resumeSessionId === sessionId) {
			return record;
		}
		for (const file of body.files) {
			if (typeof file?.relativePath !== 'string' || typeof file.content !== 'string' || !isOwnFile(file.relativePath)) {
				throw new HttpError(400, DelegationErrorCode.InvalidRequest, 'Invalid session file.');
			}
		}
		installSessionFiles(agentDir, body.files);
		const updated: IDelegationRecord = { ...record, resumeSessionId: sessionId };
		this._writeRecord(updated);
		return updated;
	}

	private async _createResults(record: IDelegationRecord, knownCommits: readonly string[]): Promise<IDelegationResultsResponse> {
		const downloadId = generateUuid().replace(/-/g, '');
		const outFile = join(this._downloads, `${downloadId}.bundle`);
		const result = await this._inRepo(record.repoId, () => createResultBundle(record.worktree, { knownCommits: [record.baseCommit, ...knownCommits], outFile, serverName: this._options.serverName }, this._runner));
		return {
			commit: result.commit,
			bytes: result.bytes,
			includesUncommitted: result.includesUncommitted,
			...(result.bundleFile ? { downloadId } : {}),
		};
	}

	private _sendDownload(response: httpTypes.ServerResponse, downloadId: string): void {
		const file = join(this._downloads, `${downloadId}.bundle`);
		let size: number;
		try {
			size = fs.statSync(file).size;
		} catch {
			throw new HttpError(404, DelegationErrorCode.NotFound, 'The download expired; bring the changes back again.');
		}
		response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Cache-Control': 'no-store' });
		const stream = fs.createReadStream(file);
		stream.pipe(response);
		stream.on('close', () => fs.rmSync(file, { force: true }));
	}

	private async _openPullRequest(record: IDelegationRecord, title: string | undefined, body: string | undefined): Promise<IDelegationPullRequestResponse> {
		const token = this._store.get(CREAEDITOR_DELEGATION_GITHUB_TOKEN_SECRET_NAME);
		if (!token) {
			throw new HttpError(409, DelegationErrorCode.NoGitHubToken, 'The server has no GitHub token yet. Run Set GitHub Token on Server first.');
		}
		const url = await this._inRepo(record.repoId, () => openPullRequestFromServer({
			worktree: record.worktree,
			branch: record.branch,
			remoteUrl: record.remoteUrl,
			...(record.defaultBranch ? { base: record.defaultBranch } : {}),
			title: (title ?? record.title).slice(0, 250) || record.branch,
			body: (body ?? `Opened by ${this._options.serverName} for a chat delegated from ${record.sourceName}.`).slice(0, 60_000),
			token,
			serverName: this._options.serverName,
		}, this._runner));
		this._writeRecord({ ...this._readRecord(record.delegationId), pullRequestUrl: url });
		return { url };
	}

	private _removeStaleTransfers(): void {
		const now = Date.now();
		for (const dir of [this._uploads, this._downloads]) {
			for (const name of fs.readdirSync(dir)) {
				const file = join(dir, name);
				try {
					if (now - fs.statSync(file).mtimeMs > STALE_TRANSFER_MS) {
						fs.rmSync(file, { force: true });
					}
				} catch {
					// Gone already.
				}
			}
		}
	}
}

function sendJson(response: httpTypes.ServerResponse, status: number, body: object): void {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(body));
}

function readRaw(request: httpTypes.IncomingMessage, maxBytes: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxBytes) {
				reject(new HttpError(413, DelegationErrorCode.TooLarge, 'The request is too large.'));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

async function readJson<T>(request: httpTypes.IncomingMessage): Promise<Partial<T>> {
	const raw = await readRaw(request, MAX_JSON_BYTES);
	try {
		const value = JSON.parse(raw.toString('utf8') || '{}');
		return value && typeof value === 'object' ? value as Partial<T> : {};
	} catch {
		throw new HttpError(400, DelegationErrorCode.InvalidRequest, 'Invalid JSON.');
	}
}
