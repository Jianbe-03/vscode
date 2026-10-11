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
import { CREAEDITOR_DELEGATION_API_PREFIX, CREAEDITOR_DELEGATION_CHUNK_BYTES, CREAEDITOR_DELEGATION_GITHUB_TOKEN_SECRET_NAME, CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME, DelegationAgentKind, DelegationErrorCode, DelegationResultsMode, IDelegationCreateRequest, IDelegationEnvelope, IDelegationKnownCommitsResponse, IDelegationPullRequestResponse, IDelegationRecord, IDelegationResultsResponse, IDelegationServerKeyResponse, IDelegationSessionFile, IDelegationSessionRequest, IDelegationUploadResponse, IDelegationWorktreeInfo, IDelegationWorktreesResponse } from '../../../platform/agentHost/common/creaeditorDelegation.js';
import { getDelegationSecretsDir } from '../../../platform/agentHost/node/creaeditorDelegation/delegationAccounts.js';
import { generateDelegationKeyPair, IDelegationKeyPair, openDelegationPayload } from '../../../platform/agentHost/node/creaeditorDelegation/delegationCrypto.js';
import { getUserCustomizationsSealContext, installUserCustomizations, IUserCustomizationsPayload, removeUserCustomizations } from '../../../platform/agentHost/node/creaeditorDelegation/delegationUserCustomizations.js';
import { DelegationError } from '../../../platform/agentHost/node/creaeditorDelegation/delegationPack.js';
import { IDelegationProcessRunner, nodeDelegationProcessRunner } from '../../../platform/agentHost/node/creaeditorDelegation/delegationProcess.js';
import { getClaudeConfigDir, getCopilotCliHome, hasInstalledSession, installSessionFiles, renameSessionFiles } from '../../../platform/agentHost/node/creaeditorDelegation/delegationSessionFiles.js';
import { resolveDefaultCodexHome } from '../../../platform/agentHost/node/codex/codexAccountHomes.js';
import { AgentHostCodexAgentCodexHomeEnvVar } from '../../../platform/agentHost/common/agentService.js';
import { assertDelegationId, createResultBundle, getBareRepositoryPath, IDelegationStoreLayout, listKnownCommits, nameExistingDelegationRepositories, openPullRequestFromServer, prepareDelegationWorktree, readCommitTree, readDelegationWorktreeTree, removeDelegationWorktree } from '../../../platform/agentHost/node/creaeditorDelegation/delegationWorktrees.js';
import { FileSecretStore } from '../../../platform/agentHost/node/shared/fileSecretStore.js';
import type { IRemoteAccessApiHandler } from '../../../platform/agentHost/node/remoteAccess/remoteAccessServer.js';
import type { IRemoteAccessDevice } from '../../../platform/agentHost/node/remoteAccess/remoteAccessAuth.js';
import type { ICreaEditorServerSessionsSource } from './creaeditorServerSessions.js';
import { findDelegationChats, getDelegationChatState, IDelegationCleanupHost, isDelegationWorkSafe, planDelegationCleanup } from './creaeditorServerWorktreeCleanup.js';

/** The largest upload (one bundle). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
/** The largest JSON request (session files are in it, base64). */
const MAX_JSON_BYTES = 96 * 1024 * 1024;
/** How long after delegating a chat its device may still abandon it (a later step failed). */
const ABANDON_WINDOW_MS = 30 * 60 * 1000;
/** Unfinished uploads and unfetched result bundles are removed after this long. */
const STALE_TRANSFER_MS = 24 * 60 * 60 * 1000;

/** Where the code receiver keeps its files, in the server's data folder. */
export interface ICreaEditorDelegationLayout extends IDelegationStoreLayout {
	/** Records of delegated chats (`<id>.json`), uploads and downloads. */
	readonly delegations: string;
	/** The receiver's own secret store (key pair, GitHub token); the agent host reads the key pair. */
	readonly secrets: string;
	/** The personal agents, skills and instructions of delegated chats, per delegation (the agent host reads them). */
	readonly userCustomizations: string;
}

/** The receiver's folders under the server's data folder; `secretsDir` is the server's secret store folder. */
export function getCreaEditorDelegationLayout(dataRoot: string, secretsDir: string): ICreaEditorDelegationLayout {
	return {
		repos: join(dataRoot, 'repos'),
		worktrees: join(dataRoot, 'worktrees'),
		delegations: join(dataRoot, 'delegations'),
		secrets: getDelegationSecretsDir(secretsDir),
		userCustomizations: join(dataRoot, 'user-customizations'),
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
	/** The chats of the agent host, for the state of delegated chats (Clean Up Server...). */
	readonly sessions?: ICreaEditorServerSessionsSource;
	/** Replaces the clock, for tests. */
	readonly now?: () => number;
}

class HttpError extends Error {
	constructor(readonly status: number, readonly code: DelegationErrorCode, message: string) {
		super(message);
	}
}

/** The `/api/delegation/` routes of a CreaEditor Server. */
export class CreaEditorDelegationApi implements IRemoteAccessApiHandler, IDelegationCleanupHost {

	readonly prefix = CREAEDITOR_DELEGATION_API_PREFIX;

	private readonly _runner: IDelegationProcessRunner;
	private readonly _store: FileSecretStore;
	private readonly _uploads: string;
	private readonly _downloads: string;
	/** One git operation per repository at a time. */
	private readonly _repoQueues = new Map<string, Promise<unknown>>();
	private _keyPair: Promise<IDelegationKeyPair> | undefined;
	private _hasGh: Promise<boolean> | undefined;
	/** Result bundles not downloaded yet: what the laptop has once it downloaded one. */
	private readonly _pendingDownloads = new Map<string, { readonly delegationId: string; readonly commit: string; readonly tree: string }>();

	constructor(private readonly _options: ICreaEditorDelegationApiOptions) {
		this._runner = _options.runner ?? nodeDelegationProcessRunner;
		const { layout } = _options;
		for (const dir of [layout.repos, layout.worktrees, layout.delegations, layout.userCustomizations]) {
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
		nameExistingDelegationRepositories(this._options.layout, this.listRecords());
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
			if (method === 'GET' && path === 'worktrees') {
				return sendJson(response, 200, { worktrees: await this._listWorktrees() } satisfies IDelegationWorktreesResponse);
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
				if (method === 'DELETE' && parts.length === 2) {
					if (url.searchParams.get('force') === '1') {
						// Clean Up Server...: any paired device may remove any delegated chat's worktree, not
						// only the one that delegated it. A CreaEditor Server belongs to one person: every
						// paired device is that person's (pairing takes the server's pairing code, and its
						// password when public), so a chat delegated from the laptop can be cleaned up from
						// the desktop or the phone. The laptop asks first and warns when work would be lost.
						await this.removeDelegation(record, `removed by device "${device.name}" (Clean Up Server)`);
					} else {
						await this._abandon(record, device);
					}
					return sendJson(response, 200, {});
				}
				if (method === 'POST' && parts[2] === 'session' && parts.length === 3) {
					return sendJson(response, 200, await this._installSession(record, await readJson<IDelegationSessionRequest>(request)));
				}
				if (method === 'POST' && parts[2] === 'customizations' && parts.length === 3) {
					const body = await readJson<{ envelope?: IDelegationEnvelope }>(request);
					return sendJson(response, 200, { files: await this._installUserCustomizations(record, body.envelope) });
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
			// Real paths: git reports a chat's folders resolved (e.g. macOS `/tmp` is `/private/tmp`),
			// and the laptop trusts these folders by path.
			worktreesDir: realPath(this._options.layout.worktrees),
			repositoriesDir: realPath(this._options.layout.repos),
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
		// What the worktree held when the chat arrived: removing it while it still holds that loses nothing.
		const initialTree = await this._inRepo(body.repoId, () => readDelegationWorktreeTree(prepared.worktree, this._runner));
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
			createdAt: this._now(),
			deviceId: device.id,
			...(initialTree ? { initialTree } : {}),
			...(typeof body.remoteUrl === 'string' && body.remoteUrl ? { remoteUrl: body.remoteUrl } : {}),
			...(typeof body.defaultBranch === 'string' && body.defaultBranch ? { defaultBranch: body.defaultBranch } : {}),
		};
		try {
			this._writeRecord(record);
		} catch (error) {
			await this._inRepo(record.repoId, () => removeDelegationWorktree(this._options.layout, record.repoId, record.delegationId, record.shortId, record.worktree, this._runner));
			throw error;
		}
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
		if (record.resumeSessionId === sessionId || record.sourceSessionId === sessionId) {
			// The laptop retried after the server answered.
			return record;
		}
		for (const file of body.files) {
			if (typeof file?.relativePath !== 'string' || typeof file.content !== 'string' || !isOwnFile(file.relativePath)) {
				throw new HttpError(400, DelegationErrorCode.InvalidRequest, 'Invalid session file.');
			}
		}
		// A chat delegated again after Take Back Here: its first copy is still here (archived, or even
		// running a turn). It stays as it is; this copy, with the laptop's full history, resumes as a
		// session of its own, so the agent host never serves the first copy's state for it.
		let resumeSessionId = sessionId;
		let files: readonly IDelegationSessionFile[] = body.files;
		if (hasInstalledSession(body.agent, agentDir, sessionId, files)) {
			resumeSessionId = generateUuid();
			files = renameSessionFiles(files, sessionId, resumeSessionId);
			this._options.logService.info(`[Delegation] Session ${sessionId} was delegated before; this copy resumes as ${resumeSessionId}`);
		}
		installSessionFiles(agentDir, files);
		const updated: IDelegationRecord = { ...record, resumeSessionId, ...(resumeSessionId !== sessionId ? { sourceSessionId: sessionId } : {}) };
		this._writeRecord(updated);
		return updated;
	}

	/**
	 * Keeps the user's personal agents, skills and instructions for this delegated chat (replacing what
	 * it brought before). Sealed by the laptop for this server's key, bound to the delegation.
	 */
	private async _installUserCustomizations(record: IDelegationRecord, envelope: IDelegationEnvelope | undefined): Promise<number> {
		if (!envelope || typeof envelope !== 'object') {
			throw new HttpError(400, DelegationErrorCode.InvalidRequest, 'Missing envelope.');
		}
		let payload: IUserCustomizationsPayload;
		try {
			payload = JSON.parse(openDelegationPayload(envelope, await this.getKeyPair(), getUserCustomizationsSealContext(record.delegationId))) as IUserCustomizationsPayload;
		} catch {
			throw new HttpError(400, DelegationErrorCode.InvalidRequest, 'The customizations are not sealed for this server.');
		}
		const files = installUserCustomizations(this._options.layout.userCustomizations, record.delegationId, this.getWorktreePaths(record), record.sourceName, Array.isArray(payload?.files) ? payload.files : [], this._now());
		this._options.logService.info(`[Delegation] "${record.title}" brought ${files} personal customization files (agents, skills, instructions) from ${record.sourceName}`);
		return files;
	}

	/**
	 * Removes a delegation whose later steps failed on the laptop (sending the session files): its
	 * worktree, branch and record. Only the device that delegated it, only shortly after and before its
	 * session files arrived: no chat has started in it (the laptop starts it after a delegation succeeded).
	 */
	private async _abandon(record: IDelegationRecord, device: IRemoteAccessDevice): Promise<void> {
		// Installed session files mean the chat may be imported here already: then it stays.
		if (record.deviceId !== device.id || this._now() - record.createdAt > ABANDON_WINDOW_MS || record.resumeSessionId || record.pullRequestUrl) {
			throw new HttpError(409, DelegationErrorCode.InvalidRequest, 'This delegated chat can no longer be removed this way.');
		}
		await this._inRepo(record.repoId, () => removeDelegationWorktree(this._options.layout, record.repoId, record.delegationId, record.shortId, record.worktree, this._runner));
		fs.rmSync(this._recordFile(record.delegationId), { force: true });
		removeUserCustomizations(this._options.layout.userCustomizations, record.delegationId);
		this._options.logService.info(`[Delegation] Device "${device.name}" abandoned the delegation into ${record.worktree} after a failed step`);
	}

	private async _createResults(record: IDelegationRecord, knownCommits: readonly string[]): Promise<IDelegationResultsResponse> {
		const downloadId = generateUuid().replace(/-/g, '');
		const outFile = join(this._downloads, `${downloadId}.bundle`);
		const result = await this._inRepo(record.repoId, () => createResultBundle(record.worktree, { knownCommits: [record.baseCommit, ...knownCommits], outFile, serverName: this._options.serverName }, this._runner));
		if (result.bundleFile) {
			this._pendingDownloads.set(downloadId, { delegationId: record.delegationId, commit: result.commit, tree: result.tree });
		} else {
			// The laptop has this commit already.
			this._noteBroughtBack(record.delegationId, result.commit, result.tree);
		}
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
		// The whole bundle went out: the laptop has the work as it was then.
		response.on('finish', () => {
			const pending = this._pendingDownloads.get(downloadId);
			this._pendingDownloads.delete(downloadId);
			if (pending) {
				this._noteBroughtBack(pending.delegationId, pending.commit, pending.tree);
			}
		});
	}

	private _noteBroughtBack(delegationId: string, commit: string, tree: string): void {
		this._updateRecord(delegationId, { broughtBackCommit: commit, broughtBackTree: tree, broughtBackAt: this._now() });
	}

	private _now(): number {
		return (this._options.now ?? Date.now)();
	}

	/** Changes a record (read again first: another request may have changed it); nothing when it is gone. */
	private _updateRecord(delegationId: string, changes: Partial<IDelegationRecord>): void {
		let record: IDelegationRecord;
		try {
			record = this._readRecord(delegationId);
		} catch {
			return;
		}
		const updated: Record<string, unknown> = { ...record, ...changes };
		for (const key of Object.keys(changes)) {
			if (updated[key] === undefined) {
				delete updated[key];
			}
		}
		this._writeRecord(updated as unknown as IDelegationRecord);
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
		// The pushed branch has the worktree's whole state now (open PR committed its uncommitted changes).
		const pushed = await this._inRepo(record.repoId, async () => {
			const tree = await readDelegationWorktreeTree(record.worktree, this._runner);
			const head = await this._runner.run('git', ['rev-parse', 'HEAD'], { cwd: record.worktree });
			return { tree, commit: head.code === 0 ? head.stdout.trim() : undefined };
		});
		this._updateRecord(record.delegationId, { pullRequestUrl: url, ...(pushed.tree && pushed.commit ? { pushedCommit: pushed.commit, pushedTree: pushed.tree, pushedAt: this._now() } : {}) });
		return { url };
	}

	// --- Cleanup of worktrees (see creaeditorServerWorktreeCleanup.ts) ---

	listRecords(): readonly IDelegationRecord[] {
		const records: IDelegationRecord[] = [];
		for (const name of fs.readdirSync(this._options.layout.delegations)) {
			if (!name.endsWith('.json')) {
				continue;
			}
			try {
				const record = JSON.parse(fs.readFileSync(join(this._options.layout.delegations, name), 'utf8')) as IDelegationRecord;
				if (typeof record?.delegationId === 'string' && typeof record.worktree === 'string' && typeof record.repoId === 'string' && typeof record.shortId === 'string') {
					records.push(record);
				}
			} catch {
				// Not a record.
			}
		}
		return records;
	}

	getWorktreePaths(record: IDelegationRecord): readonly string[] {
		const real = realPath(record.worktree);
		return real !== record.worktree ? [record.worktree, real] : [record.worktree];
	}

	async isWorkSafe(record: IDelegationRecord): Promise<boolean> {
		return this._inRepo(record.repoId, async () => {
			const bare = getBareRepositoryPath(this._options.layout, record.repoId);
			// Records from before the server noted the first state: the laptop's commit (only right when
			// no uncommitted changes came along, so a chat that brought some counts as changed).
			const initialTree = record.initialTree ?? await readCommitTree(bare, record.baseCommit, this._runner);
			const withInitial = { ...record, ...(initialTree ? { initialTree } : {}) };
			if (fs.existsSync(record.worktree)) {
				const tree = await readDelegationWorktreeTree(record.worktree, this._runner);
				return tree !== undefined && isDelegationWorkSafe(withInitial, tree);
			}
			// The worktree folder is gone; its branch may still have commits.
			const branch = await this._runner.run('git', ['rev-parse', '-q', '--verify', `refs/heads/${record.branch}^{tree}`], { cwd: bare });
			return isDelegationWorkSafe(withInitial, branch.code === 0 ? branch.stdout.trim() : undefined);
		});
	}

	updateNotes(delegationId: string, notes: Pick<IDelegationRecord, 'chatSeenAt' | 'archivedSeenAt'>): void {
		this._updateRecord(delegationId, notes);
	}

	async removeDelegation(record: IDelegationRecord, reason: string): Promise<void> {
		await this._inRepo(record.repoId, () => removeDelegationWorktree(this._options.layout, record.repoId, record.delegationId, record.shortId, record.worktree, this._runner));
		fs.rmSync(this._recordFile(record.delegationId), { force: true });
		removeUserCustomizations(this._options.layout.userCustomizations, record.delegationId);
		this._options.logService.info(`[Delegation] Removed the worktree ${record.worktree} (${record.branch}) of "${record.title}" from ${record.sourceName}: ${reason}`);
	}

	private async _listWorktrees(): Promise<IDelegationWorktreeInfo[]> {
		const sessions = await this._options.sessions?.listSessions();
		const now = this._now();
		const worktrees: IDelegationWorktreeInfo[] = [];
		for (const record of [...this.listRecords()].sort((a, b) => b.createdAt - a.createdAt)) {
			const chatState = getDelegationChatState(sessions && findDelegationChats(record, this.getWorktreePaths(record), sessions));
			const workSafe = await this.isWorkSafe(record).catch(() => false);
			const plan = planDelegationCleanup(record, chatState, workSafe, now);
			const bytes = await this._diskUse(record.worktree);
			worktrees.push({
				delegationId: record.delegationId,
				shortId: record.shortId,
				title: record.title,
				sourceName: record.sourceName,
				createdAt: record.createdAt,
				worktree: record.worktree,
				branch: record.branch,
				chatState,
				workSafe,
				...(bytes !== undefined ? { bytes } : {}),
				...(plan.notes?.archivedSeenAt ?? record.archivedSeenAt ? { archivedSince: plan.notes?.archivedSeenAt ?? record.archivedSeenAt } : {}),
				...(record.broughtBackAt ? { broughtBackAt: record.broughtBackAt } : {}),
				...(record.pullRequestUrl ? { pullRequestUrl: record.pullRequestUrl } : {}),
				...(plan.removeAfter !== undefined ? { removeAfter: plan.removeAfter } : {}),
			});
		}
		return worktrees;
	}

	/** The disk use of a folder (`du -sk`); undefined when unknown. */
	private async _diskUse(folder: string): Promise<number | undefined> {
		if (!fs.existsSync(folder)) {
			return 0;
		}
		const result = await this._runner.run('du', ['-sk', folder], { cwd: this._options.layout.delegations });
		const kilobytes = result.code === 0 ? Number(/^\d+/.exec(result.stdout.trim())?.[0]) : NaN;
		return Number.isFinite(kilobytes) ? kilobytes * 1024 : undefined;
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

/** The real path of a folder (symbolic links resolved); the path as it is when it does not exist. */
function realPath(path: string): string {
	try {
		return fs.realpathSync(path);
	} catch {
		return path;
	}
}
