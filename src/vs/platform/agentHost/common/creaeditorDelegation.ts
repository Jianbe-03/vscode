/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: Delegate to Server moves a chat from this machine to a CreaEditor Server: its code (a git
// bundle), its conversation (the agent's own session files, so it resumes as the same session) and the
// accounts it needs (encrypted for the server). The chat then runs on the server in its own worktree;
// its results come back as a local branch (Bring Back Changes) or a pull request the server opens.
//
// Transport: the server's Remote Access HTTP API, authenticated with this device's key (`Authorization:
// Bearer <deviceKey>`), under `CREAEDITOR_DELEGATION_API_PREFIX`. Bundles go up in chunks so progress is
// visible and a dropped connection resumes where it stopped. See `node/creaeditorDelegation/README.md`.

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const CREAEDITOR_DELEGATION_CHANNEL_NAME = 'creaeditorDelegation';

/** The HTTP API of a CreaEditor Server for delegated chats. */
export const CREAEDITOR_DELEGATION_API_PREFIX = '/api/delegation/';

/** Branches of delegated chats on the server: `creaeditor/delegated/<shortId>`. */
export const CREAEDITOR_DELEGATION_BRANCH_PREFIX = 'creaeditor/delegated/';

/** The ref names inside a delegation bundle (under a temporary namespace). */
export const CREAEDITOR_DELEGATION_BUNDLE_HEAD_REF = 'head';
export const CREAEDITOR_DELEGATION_BUNDLE_SNAPSHOT_REF = 'snapshot';

/** Upload chunk size. */
export const CREAEDITOR_DELEGATION_CHUNK_BYTES = 4 * 1024 * 1024;

/** The default largest code upload, in MB (setting {@link DelegationMaxUploadSettingId}). */
export const CREAEDITOR_DELEGATION_DEFAULT_MAX_UPLOAD_MB = 500;
export const DelegationMaxUploadSettingId = 'creaeditor.delegation.maxUploadMB';

/** Untracked files that match one of these stay on this machine unless the user includes them. */
export const CREAEDITOR_DELEGATION_SECRET_FILE_GLOBS: readonly string[] = [
	'**/.env',
	'**/.env.*',
	'**/*.pem',
	'**/*.key',
	'**/*.p12',
	'**/*.pfx',
	'**/id_rsa*',
	'**/id_ed25519*',
	'**/id_ecdsa*',
	'**/.netrc',
	'**/.npmrc',
	'**/.pypirc',
	'**/credentials.json',
	'**/secrets.json',
];

/** The command that starts Delegate to Server (from the chat panel's Continue Chat in... and the Agents window). */
export const CREAEDITOR_DELEGATE_TO_SERVER_COMMAND_ID = 'creaeditor.delegation.delegateToServer';
/**
 * Delegate to Server in the editor window: opens the Agents window (where the servers are), which
 * delegates the chat named in {@link CREAEDITOR_DELEGATE_REQUEST_KEY}.
 */
export const CREAEDITOR_OPEN_DELEGATE_TO_SERVER_COMMAND_ID = 'creaeditor.delegation.openDelegateToServer';
/** Application storage key the editor window sets to `{ sessionResource, requestedAt }` for the Agents window. */
export const CREAEDITOR_DELEGATE_REQUEST_KEY = 'creaeditor.delegation.delegateRequested';

/** A request of the editor window to delegate one of its chats. */
export interface IDelegateToServerRequest {
	readonly sessionResource: string;
	readonly requestedAt: number;
}

/** Bring Back Changes of a delegated chat. */
export const CREAEDITOR_BRING_BACK_CHANGES_COMMAND_ID = 'creaeditor.delegation.bringBackChanges';
/** Open PR from the Server for a delegated chat. */
export const CREAEDITOR_OPEN_PR_FROM_SERVER_COMMAND_ID = 'creaeditor.delegation.openPullRequestFromServer';
/** Clean Up Server...: lists a server's worktrees of delegated chats and removes the chosen ones (argument: the server id). */
export const CREAEDITOR_CLEAN_UP_SERVER_COMMAND_ID = 'creaeditor.delegation.cleanUpServer';
/** Set GitHub Token on Server. */
export const CREAEDITOR_SET_SERVER_GITHUB_TOKEN_COMMAND_ID = 'creaeditor.delegation.setServerGitHubToken';

/**
 * A name as one part of a git ref or a folder name: lower case, runs of other characters than
 * letters, digits, `.`, `_` and `-` as one `-` ("Office Server" is `office-server`); undefined when
 * nothing is left.
 */
export function slugifyDelegationName(name: string): string | undefined {
	return name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60).replace(/[-.]+$/, '') || undefined;
}

/** The local branch Bring Back Changes creates: `creaeditor/from-<server>/<shortId>`. */
export function getBroughtBackBranchName(serverName: string, shortId: string): string {
	return `${getBroughtBackBranchPrefix(serverName)}${shortId}`;
}

/** The start of the branches Bring Back Changes creates for a server: `creaeditor/from-<server>/`. */
export function getBroughtBackBranchPrefix(serverName: string): string {
	return `creaeditor/from-${slugifyDelegationName(serverName) ?? 'server'}/`;
}

export const enum DelegationErrorCode {
	NotARepository = 'notARepository',
	NoCommits = 'noCommits',
	TooLarge = 'tooLarge',
	InvalidRequest = 'invalidRequest',
	MissingHistory = 'missingHistory',
	NotFound = 'notFound',
	BranchCheckedOut = 'branchCheckedOut',
	NotGitHub = 'notGitHub',
	PushFailed = 'pushFailed',
	PullRequestFailed = 'pullRequestFailed',
	GhMissing = 'ghMissing',
	NoGitHubToken = 'noGitHubToken',
	Unauthorized = 'unauthorized',
	Offline = 'offline',
	NotSupported = 'notSupported',
	Unexpected = 'unexpected',
}

/** How the results of a delegated chat come back. */
export const enum DelegationResultsMode {
	/** The laptop fetches the server's branch into `creaeditor/from-<server>/<shortId>`. */
	BringBack = 'bringBack',
	/** The server pushes its branch and opens a pull request with its own GitHub token. */
	PullRequest = 'pullRequest',
}

/** Which agent's session files are sent so the chat resumes as the same session. */
export const enum DelegationAgentKind {
	Claude = 'claude',
	Codex = 'codex',
	CopilotCli = 'copilotcli',
	/** No session files: the conversation goes along as a transcript attachment. */
	Transcript = 'transcript',
}

/** A session file of an agent, sent to the server. */
export interface IDelegationSessionFile {
	/** Path relative to the agent's own folder on the server (validated there: no `..`, no absolute paths). */
	readonly relativePath: string;
	/** Base64 content (already rewritten for the server's folder where needed). */
	readonly content: string;
}

/** The accounts and keys a delegated chat needs; sent encrypted (see `delegationCrypto.ts`). */
export interface IDelegationAccountsPayload {
	/** Claude setup-token accounts (`CLAUDE_CODE_OAUTH_TOKEN`), added on the server as token accounts. */
	readonly claudeTokens?: readonly { readonly accountId: string; readonly label: string; readonly token: string }[];
	/**
	 * The OpenRouter/LiteLLM key of the chat's model; the chat on the server only uses this key. The
	 * server's agent host keeps it (encrypted, by `<providerId>/<label>`) and calls the gateway itself,
	 * so the chat runs while this computer is off.
	 */
	readonly gatewayKey?: IDelegationGatewayKey;
	/** What the server's cost ledger records for the chat's requests; added when the accounts are sealed. */
	readonly workContext?: IDelegationWorkContext;
}

/** A gateway key (provider group) of a delegated chat. */
export interface IDelegationGatewayKey {
	/** The language model vendor: `openrouter` or `litellm`. */
	readonly providerId: string;
	/** The provider group's name (the key's name, e.g. "Work"). */
	readonly label: string;
	/** LiteLLM: the proxy's URL. OpenRouter: absent (`https://openrouter.ai/api/v1`). */
	readonly baseUrl?: string;
	readonly key: string;
	/** The models of this key the chat may use, as the gateway names them. */
	readonly models?: readonly IDelegationGatewayModel[];
}

export interface IDelegationGatewayModel {
	readonly id: string;
	readonly name?: string;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly supportsVision?: boolean;
}

/** The repository and branch of a delegated chat, for the server's cost ledger and budgets. */
export interface IDelegationWorkContext {
	/** The chat's worktree on the server: requests of sessions in it belong to this chat. */
	readonly worktree: string;
	readonly title?: string;
	/** `owner/repo`. */
	readonly repo?: string;
	/** The laptop's branch (the issue is read from it, like on the laptop). */
	readonly branch?: string;
}

/** An encrypted payload (X25519 + HKDF-SHA256 + AES-256-GCM, see `node/creaeditorDelegation/delegationCrypto.ts`). */
export interface IDelegationEnvelope {
	readonly version: 1;
	/** The sender's ephemeral X25519 public key (SPKI DER, base64). */
	readonly ephemeralPublicKey: string;
	readonly iv: string;
	readonly tag: string;
	readonly data: string;
}

/**
 * The AHP `authenticate` resource that carries the encrypted {@link IDelegationAccountsPayload} of a
 * delegated chat to the server's agent host: `creaeditor-delegation-accounts:<delegationId>`, with the
 * JSON {@link IDelegationEnvelope} as the token. Only the server's agent host can open it.
 */
export const CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX = 'creaeditor-delegation-accounts:';

/** The name of the server's X25519 key pair (JSON) in its file secret store. */
export const CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME = 'delegation-key-pair';

/** The name of the server's GitHub token in its file secret store. */
export const CREAEDITOR_DELEGATION_GITHUB_TOKEN_SECRET_NAME = 'github-token';

// --- HTTP API (paths relative to CREAEDITOR_DELEGATION_API_PREFIX) ---

/** `GET key` */
export interface IDelegationServerKeyResponse {
	/** X25519 public key (SPKI DER, base64) to encrypt accounts for this server. */
	readonly publicKey: string;
	/** Whether a GitHub token is set on the server (for Open PR from the Server). */
	readonly hasGitHubToken: boolean;
	/** Whether `gh` is installed on the server. */
	readonly hasGh: boolean;
	/** The server's data folder layout: where worktrees go (to show the user). */
	readonly worktreesDir: string;
	/** Where the server keeps the bare repositories of delegated code (new chats there work in them). Older servers omit it. */
	readonly repositoriesDir?: string;
	/** The home folder of the agent host's user, where agents keep their sessions. */
	readonly agentHome: string;
}

/** `GET repos/<repoId>/known` */
export interface IDelegationKnownCommitsResponse {
	readonly commits: readonly string[];
}

/** `PUT uploads/<uploadId>?offset=<n>` body: raw bytes. Answer: */
export interface IDelegationUploadResponse {
	/** Bytes the server has of this upload; the next chunk starts here. */
	readonly received: number;
}

/** `POST delegations` */
export interface IDelegationCreateRequest {
	readonly delegationId: string;
	readonly shortId: string;
	readonly repoId: string;
	readonly head: string;
	readonly snapshot: string;
	/** The finished upload with the bundle; absent when the server had everything. */
	readonly uploadId?: string;
	readonly remoteUrl?: string;
	readonly defaultBranch?: string;
	readonly subPath: string;
	/** The laptop's branch, for the pull request title. */
	readonly sourceBranch?: string;
	/** The repository's name: the worktree's folder is `<name>-<shortId>`, which the Agents window shows. */
	readonly repoName?: string;
	readonly title: string;
	readonly resultsMode: DelegationResultsMode;
	readonly agent: DelegationAgentKind;
	/** The name of the laptop (shown on the server). */
	readonly sourceName: string;
}

/**
 * `POST delegations/<id>/session`: the agent's session files, already placed and rewritten for the
 * worktree (see `delegationSessionFiles.ts`). The server installs them so the agent resumes `sessionId`.
 */
export interface IDelegationSessionRequest {
	readonly agent: DelegationAgentKind;
	readonly sessionId: string;
	readonly files: readonly IDelegationSessionFile[];
}

/** What the server keeps about a delegated chat; answered by `POST delegations` and `GET delegations/<id>`. */
export interface IDelegationRecord {
	readonly delegationId: string;
	readonly shortId: string;
	readonly repoId: string;
	readonly branch: string;
	readonly worktree: string;
	readonly workingDirectory: string;
	readonly baseCommit: string;
	readonly resultsMode: DelegationResultsMode;
	readonly agent: DelegationAgentKind;
	/** The session files were installed, so the agent resumes this id on the server. */
	readonly resumeSessionId?: string;
	/**
	 * The laptop's session id, when the server installed the session under another one
	 * ({@link resumeSessionId}): the chat was delegated before and its first copy is still there.
	 */
	readonly sourceSessionId?: string;
	/** The paired device that delegated the chat; only it may abandon a delegation that failed half-way. */
	readonly deviceId?: string;
	readonly remoteUrl?: string;
	readonly defaultBranch?: string;
	readonly title: string;
	readonly sourceName: string;
	readonly createdAt: number;
	readonly pullRequestUrl?: string;
	/** The worktree's tree when the chat arrived (the laptop's code with its uncommitted changes). */
	readonly initialTree?: string;
	/** The commit Bring Back Changes last fetched (the server's work with its uncommitted changes as a last commit). */
	readonly broughtBackCommit?: string;
	/** The tree of {@link broughtBackCommit}: the worktree is safe to remove while it still has this tree. */
	readonly broughtBackTree?: string;
	readonly broughtBackAt?: number;
	/** The commit Open PR from the Server last pushed, and its tree (see {@link broughtBackTree}). */
	readonly pushedCommit?: string;
	readonly pushedTree?: string;
	readonly pushedAt?: number;
	/** When the server's cleanup first saw this chat on its agent host. */
	readonly chatSeenAt?: number;
	/** When the server's cleanup first saw this chat archived; cleared when it is unarchived. */
	readonly archivedSeenAt?: number;
}

/** `POST delegations/<id>/results` `{ knownCommits }`: the result bundle, if any, is then downloaded from `GET downloads/<downloadId>`. */
export interface IDelegationResultsResponse {
	readonly commit: string;
	readonly downloadId?: string;
	readonly bytes: number;
	readonly includesUncommitted: boolean;
}

/** The state of a delegated chat's conversation on the server's agent host. */
export const enum DelegationChatState {
	/** A chat works in the worktree and is not archived. */
	Running = 'running',
	/** Every chat in the worktree is archived (Take Back Here archives it, and the server archives idle chats). */
	Archived = 'archived',
	/** No chat on the server works in the worktree any more (deleted, or the server's chat data is gone). */
	Deleted = 'deleted',
	/** The server cannot tell (its agent host does not answer). */
	Unknown = 'unknown',
}

/** A delegated chat's worktree, as `GET worktrees` lists it (Clean Up Server...). */
export interface IDelegationWorktreeInfo {
	readonly delegationId: string;
	readonly shortId: string;
	readonly title: string;
	readonly sourceName: string;
	readonly createdAt: number;
	readonly worktree: string;
	readonly branch: string;
	/** Disk use of the worktree; undefined when unknown. */
	readonly bytes?: number;
	readonly chatState: DelegationChatState;
	/** Since when the chat is archived (as the server noticed it). */
	readonly archivedSince?: number;
	readonly broughtBackAt?: number;
	readonly pullRequestUrl?: string;
	/**
	 * The worktree holds nothing that is not on the laptop or in the pushed branch: its current state
	 * (with uncommitted changes) is what Bring Back Changes last fetched or Open PR from the Server last
	 * pushed, or it never changed.
	 */
	readonly workSafe: boolean;
	/** When the server removes it on its own (while its work stays safe); undefined when it keeps it. */
	readonly removeAfter?: number;
}

/** `GET worktrees` */
export interface IDelegationWorktreesResponse {
	readonly worktrees: readonly IDelegationWorktreeInfo[];
}

/** `POST delegations/<id>/pull-request` `{ title?, body? }` */
export interface IDelegationPullRequestResponse {
	readonly url: string;
}

/** `PUT github-token` `{ token }` (empty removes it). */
export interface IDelegationGitHubTokenRequest {
	readonly token: string;
}

/** An error answer: `{ error: <code>, message }`. */
export interface IDelegationErrorResponse {
	readonly error: DelegationErrorCode;
	readonly message: string;
}

// --- The laptop side (main process service, used by windows over IPC) ---

/** A server to delegate to, with this device's key (from the CreaEditor Servers list). */
export interface IDelegationServerTarget {
	readonly serverId: string;
	readonly name: string;
	/** `http(s)://host[:port]` */
	readonly serverUrl: string;
	readonly deviceKey: string;
}

export interface IDelegateRequest {
	readonly server: IDelegationServerTarget;
	/** The chat's folder on this machine. */
	readonly folder: string;
	readonly title: string;
	readonly resultsMode: DelegationResultsMode;
	readonly includeSecretFiles: boolean;
	readonly maxUploadBytes: number;
	readonly agent: DelegationAgentKind;
	/** The agent's session id here (Claude SDK session id, Codex thread id, Copilot CLI session id). */
	readonly agentSessionId?: string;
	/** The accounts to send; sealed for the server, answered as {@link IDelegateResult.accountsEnvelope}. */
	readonly accounts?: IDelegationAccountsPayload;
	/** Name of this machine, shown on the server. */
	readonly sourceName: string;
}

export interface IDelegateResult {
	readonly record: IDelegationRecord;
	readonly bytesSent: number;
	readonly incremental: boolean;
	readonly hasLocalChanges: boolean;
	readonly skippedSecretFiles: readonly string[];
	/** Session files were sent: the agent resumes the same session. False: use the transcript fallback. */
	readonly sessionFilesSent: boolean;
	/**
	 * The accounts and the chat's work context, encrypted for the server's agent host (see
	 * {@link CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX}). Always sent: it also tells the server's
	 * agents that session files arrived.
	 */
	readonly accountsEnvelope?: IDelegationEnvelope;
}

export const enum DelegationProgressStage {
	Packing = 'packing',
	Uploading = 'uploading',
	Preparing = 'preparing',
	Downloading = 'downloading',
	Importing = 'importing',
	Done = 'done',
}

export interface IDelegationProgress {
	/** The operation this progress belongs to (as passed by the caller). */
	readonly operationId: string;
	readonly stage: DelegationProgressStage;
	readonly bytesDone?: number;
	readonly bytesTotal?: number;
}

/** Errors reach windows as `Error` with the name `<{@link DELEGATION_ERROR_NAME}>:<code>`. */
export const DELEGATION_ERROR_NAME = 'CreaEditorDelegationError';

export interface IBringBackRequest {
	readonly server: IDelegationServerTarget;
	readonly delegationId: string;
	/** The local repository folder. */
	readonly folder: string;
	/** The commit the chat started from (it is on this machine). */
	readonly baseCommit: string;
	readonly branch: string;
}

export interface IBringBackResult {
	readonly branch: string;
	readonly commit: string;
	readonly includesUncommitted: boolean;
	/** Nothing new since the chat started. */
	readonly unchanged: boolean;
}

export const ICreaEditorDelegationService = createDecorator<ICreaEditorDelegationService>('creaeditorDelegationService');

/** Delegate to Server on this machine; runs in the main process (git, files, HTTP to the server). */
export interface ICreaEditorDelegationService {
	readonly _serviceBrand: undefined;

	readonly onDidProgress: Event<IDelegationProgress>;

	/** Information about the repository of `folder` and the secret-looking untracked files that would stay here. */
	inspectFolder(folder: string): Promise<{ readonly repoRoot: string; readonly branch?: string; readonly remoteUrl?: string; readonly skippedSecretFiles: readonly string[] }>;

	/** Reads the server's public key and capabilities. */
	getServerInfo(server: IDelegationServerTarget): Promise<IDelegationServerKeyResponse>;

	/** Sends the code, the session and the accounts; the server prepares the worktree. */
	delegate(operationId: string, request: IDelegateRequest): Promise<IDelegateResult>;

	/** Reads the server's record of a delegated chat. */
	getDelegation(server: IDelegationServerTarget, delegationId: string): Promise<IDelegationRecord>;

	/** Fetches the delegated chat's work into a local branch. */
	bringBackChanges(operationId: string, request: IBringBackRequest): Promise<IBringBackResult>;

	/** Asks the server to push the branch and open a pull request. */
	openPullRequest(server: IDelegationServerTarget, delegationId: string): Promise<string>;

	/** Lists the server's worktrees of delegated chats (Clean Up Server...). */
	listServerWorktrees(server: IDelegationServerTarget): Promise<readonly IDelegationWorktreeInfo[]>;

	/** Removes a delegated chat's worktree, branch and record on the server, whatever its state. */
	removeServerDelegation(server: IDelegationServerTarget, delegationId: string): Promise<void>;

	/** Sets (or with an empty token removes) the server's GitHub token. */
	setServerGitHubToken(server: IDelegationServerTarget, token: string): Promise<void>;

	/** Checks out, or merges into the current branch, a branch brought back (refuses when there are local changes). */
	applyBroughtBackBranch(folder: string, branch: string, how: 'checkout' | 'merge'): Promise<void>;

	/** Files changed between the current HEAD and `branch`, for Compare. */
	listBranchChanges(folder: string, branch: string): Promise<readonly { readonly path: string; readonly status: 'A' | 'M' | 'D' }[]>;
}

/** The agent of a chat (by its session type or resource scheme), for its session files. */
export function getDelegationAgentKind(sessionType: string, resourceScheme: string): DelegationAgentKind {
	const kinds: readonly [string, DelegationAgentKind][] = [['claude', DelegationAgentKind.Claude], ['codex', DelegationAgentKind.Codex], ['copilotcli', DelegationAgentKind.CopilotCli]];
	for (const [id, kind] of kinds) {
		if (sessionType === id || resourceScheme === `agent-host-${id}`) {
			return kind;
		}
	}
	return DelegationAgentKind.Transcript;
}

/**
 * The agent's own session id from its state file (`getSessionStateFile`): Claude
 * `<config>/projects/<project>/<id>.jsonl`, Copilot CLI `<home>/session-state/<id>/events.jsonl`,
 * Codex `<home>/sessions/.../rollout-<time>-<threadId>.jsonl`.
 */
export function getAgentSessionIdFromStateFile(agent: DelegationAgentKind, path: string): string | undefined {
	const parts = path.split(/[\\/]/);
	const name = parts.at(-1) ?? '';
	let id: string | undefined;
	switch (agent) {
		case DelegationAgentKind.Claude:
			id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : undefined;
			break;
		case DelegationAgentKind.CopilotCli:
			id = name === 'events.jsonl' && parts.at(-3) === 'session-state' ? parts.at(-2) : undefined;
			break;
		case DelegationAgentKind.Codex:
			id = /^rollout-.*-(?<id>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.groups?.id;
			break;
	}
	return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

/** The provider (session URI scheme on the agent host) of an agent whose session resumes on the server. */
export function getDelegationAgentProvider(agent: DelegationAgentKind): string | undefined {
	switch (agent) {
		case DelegationAgentKind.Claude: return 'claude';
		case DelegationAgentKind.Codex: return 'codex';
		case DelegationAgentKind.CopilotCli: return 'copilotcli';
		default: return undefined;
	}
}

/**
 * The provider group (gateway key) of a BYOK model id as a chat holds it: `[<scheme>:]<vendor>/<group>/<model>`
 * for OpenRouter and LiteLLM; undefined for other models.
 */
export function parseDelegationGatewayModel(modelId: string | undefined, groupNames: readonly { readonly vendor: string; readonly name: string }[]): { readonly vendor: string; readonly group: string; readonly model: string } | undefined {
	if (!modelId) {
		return undefined;
	}
	const colon = modelId.indexOf(':');
	const id = colon >= 0 && colon < modelId.indexOf('/') ? modelId.slice(colon + 1) : modelId;
	let best: { vendor: string; group: string; model: string } | undefined;
	for (const { vendor, name } of groupNames) {
		const prefix = `${vendor}/${name}/`;
		if ((vendor === 'openrouter' || vendor === 'litellm') && id.startsWith(prefix) && id.length > prefix.length && (!best || name.length > best.group.length)) {
			best = { vendor, group: name, model: id.slice(prefix.length) };
		}
	}
	return best;
}
