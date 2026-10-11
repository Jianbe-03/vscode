/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the server side of Delegate to Server's code. Every repository is a bare repository
// `<data>/repos/<repoId>.git`; every delegated chat works in its own worktree
// `<data>/worktrees/<repository name>-<shortId>` on the branch `creaeditor/delegated/<shortId>`, with the laptop's
// uncommitted changes applied as uncommitted changes. Results go back as a bundle of that branch
// (Bring Back Changes) or as a pull request (Open PR from the Server).

import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';
import { CREAEDITOR_DELEGATION_BRANCH_PREFIX, DelegationErrorCode, slugifyDelegationName } from '../../common/creaeditorDelegation.js';
import { bundleFetchRefspecs, DelegationError, filterExistingCommits, snapshotWorkingTree } from './delegationPack.js';
import { delegationCommitIdentity, git, gitSucceeds, IDelegationProcessRunner, nodeDelegationProcessRunner } from './delegationProcess.js';
import { readDelegationRepositoryName, writeDelegationRepositoryName } from './delegationRepositoryName.js';

/** How many known commits the server reports at most (the newest refs). */
const MAX_KNOWN_COMMITS = 64;

/** The ref of a result bundle (the worktrees of a repository share refs: one bundle at a time per repository). */
const RESULT_BUNDLE_REF = 'refs/creaeditor/result';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;

/** Throws unless `value` is a safe id (used in paths and ref names). */
export function assertDelegationId(value: string, what: string): void {
	if (!ID_PATTERN.test(value)) {
		throw new DelegationError(DelegationErrorCode.InvalidRequest, `Invalid ${what}.`);
	}
}

function assertCommit(value: string, what: string): void {
	if (!COMMIT_PATTERN.test(value)) {
		throw new DelegationError(DelegationErrorCode.InvalidRequest, `Invalid ${what}.`);
	}
}

export interface IDelegationStoreLayout {
	/** Bare repositories. */
	readonly repos: string;
	/** Worktrees of delegated chats. */
	readonly worktrees: string;
}

export function getBareRepositoryPath(layout: IDelegationStoreLayout, repoId: string): string {
	assertDelegationId(repoId, 'repository id');
	return join(layout.repos, `${repoId}.git`);
}

/**
 * The worktree of a delegated chat: `<worktrees>/<repository name>-<shortId>` (the Agents window shows
 * the folder's name), or `<worktrees>/<delegationId>` without a usable name.
 */
export function getDelegationWorktreePath(layout: IDelegationStoreLayout, delegation: { readonly delegationId: string; readonly shortId: string; readonly repoName?: string }): string {
	assertDelegationId(delegation.delegationId, 'delegation id');
	assertDelegationId(delegation.shortId, 'short id');
	const name = delegation.repoName ? slugifyDelegationName(delegation.repoName) : undefined;
	return join(layout.worktrees, name ? `${name}-${delegation.shortId}` : delegation.delegationId);
}

/** The branch of a delegated chat. */
export function getDelegationBranch(shortId: string): string {
	assertDelegationId(shortId, 'short id');
	return `${CREAEDITOR_DELEGATION_BRANCH_PREFIX}${shortId}`;
}

async function ensureBareRepository(path: string, runner: IDelegationProcessRunner): Promise<void> {
	if (fs.existsSync(join(path, 'HEAD'))) {
		return;
	}
	fs.mkdirSync(path, { recursive: true, mode: 0o700 });
	await git(runner, path, ['init', '-q', '--bare']);
}

/** The commits the server has of `repoId` (tips of its branches and bases), newest first; empty when it has none. */
export async function listKnownCommits(layout: IDelegationStoreLayout, repoId: string, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<string[]> {
	const path = getBareRepositoryPath(layout, repoId);
	if (!fs.existsSync(join(path, 'HEAD'))) {
		return [];
	}
	const output = await git(runner, path, ['for-each-ref', '--sort=-committerdate', '--format=%(objectname)', 'refs/heads', 'refs/creaeditor/base']);
	return [...new Set(output.split('\n').map(line => line.trim()).filter(Boolean))].slice(0, MAX_KNOWN_COMMITS);
}

export interface IPrepareWorktreeRequest {
	readonly repoId: string;
	readonly delegationId: string;
	readonly shortId: string;
	/** The laptop's commit; the worktree's branch starts here. */
	readonly head: string;
	/** The commit whose tree is the laptop's working tree. */
	readonly snapshot: string;
	/** The bundle the laptop uploaded; undefined when the server had everything. */
	readonly bundleFile?: string;
	/** The laptop's `origin` URL, kept as the bare repository's `origin` for pull requests. */
	readonly remoteUrl?: string;
	/** The chat's folder in the repository (`''` at the top). */
	readonly subPath: string;
	/** The repository's name, for the worktree's folder. */
	readonly repoName?: string;
}

export interface IPreparedWorktree {
	readonly worktree: string;
	/** The chat's folder in the worktree. */
	readonly workingDirectory: string;
	readonly branch: string;
}

/** Unpacks an uploaded bundle into the bare repository and creates the chat's worktree. */
export async function prepareDelegationWorktree(layout: IDelegationStoreLayout, request: IPrepareWorktreeRequest, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<IPreparedWorktree> {
	assertCommit(request.head, 'head commit');
	assertCommit(request.snapshot, 'snapshot commit');
	if (request.subPath.split('/').some(part => part === '..')) {
		throw new DelegationError(DelegationErrorCode.InvalidRequest, 'Invalid folder.');
	}
	const bare = getBareRepositoryPath(layout, request.repoId);
	const worktree = getDelegationWorktreePath(layout, request);
	const branch = getDelegationBranch(request.shortId);
	await ensureBareRepository(bare, runner);
	if (request.repoName) {
		// The Agents window shows the bare repository (the worktrees' common dir) by this name.
		writeDelegationRepositoryName(bare, request.repoName);
	}

	if (request.bundleFile) {
		const verify = await runner.run('git', ['bundle', 'verify', '-q', request.bundleFile], { cwd: bare });
		if (verify.code !== 0) {
			throw new DelegationError(DelegationErrorCode.MissingHistory, `The uploaded code does not fit the server's copy of the repository: ${verify.stderr.trim()}`);
		}
		const incoming = `refs/creaeditor/incoming/${request.delegationId}`;
		await git(runner, bare, ['fetch', '-q', request.bundleFile, ...bundleFetchRefspecs(incoming)]);
		// The objects stay reachable through the base and the worktree's branch below.
		const refs = (await git(runner, bare, ['for-each-ref', '--format=%(refname)', incoming])).split('\n').filter(Boolean);
		for (const ref of refs) {
			await git(runner, bare, ['update-ref', '-d', ref]);
		}
	}
	const needed = [...new Set([request.head, request.snapshot])];
	if ((await filterExistingCommits(bare, needed, runner)).length !== needed.length) {
		throw new DelegationError(DelegationErrorCode.MissingHistory, 'The server is missing commits of this chat. Delegate again to send the full history.');
	}

	if (request.remoteUrl) {
		const hasOrigin = await gitSucceeds(runner, bare, ['remote', 'get-url', 'origin']);
		await git(runner, bare, hasOrigin ? ['remote', 'set-url', 'origin', request.remoteUrl] : ['remote', 'add', 'origin', request.remoteUrl]);
	}
	// Keep the base so its history counts as known for the next upload.
	await git(runner, bare, ['update-ref', `refs/creaeditor/base/${request.delegationId}`, request.head]);
	// The snapshot commit must stay reachable until the worktree has its files.
	const snapshotRef = `refs/creaeditor/snapshot/${request.delegationId}`;
	await git(runner, bare, ['update-ref', snapshotRef, request.snapshot]);

	fs.mkdirSync(layout.worktrees, { recursive: true, mode: 0o700 });
	if (fs.existsSync(worktree)) {
		throw new DelegationError(DelegationErrorCode.InvalidRequest, 'This chat was already delegated to the server.');
	}
	let added = false;
	try {
		await git(runner, bare, ['worktree', 'add', '-q', '-b', branch, worktree, request.head]);
		added = true;
		if (request.snapshot !== request.head) {
			// Make the files the snapshot's, then put the index back on the branch: the laptop's
			// uncommitted changes are uncommitted changes here too, untracked files stay untracked.
			await git(runner, worktree, ['read-tree', '-u', '--reset', request.snapshot]);
			await git(runner, worktree, ['reset', '-q']);
		}
		const workingDirectory = request.subPath ? join(worktree, ...request.subPath.split('/')) : worktree;
		fs.mkdirSync(workingDirectory, { recursive: true });
		return { worktree, workingDirectory, branch };
	} catch (error) {
		// A failed delegation leaves nothing behind it created: the worktree and its branch (only when
		// this call added them; the branch may be another chat's when adding failed), the base ref.
		if (added) {
			await removeDelegationWorktree(layout, request.repoId, request.delegationId, request.shortId, worktree, runner);
		} else {
			await runner.run('git', ['update-ref', '-d', `refs/creaeditor/base/${request.delegationId}`], { cwd: bare });
		}
		throw error;
	} finally {
		await runner.run('git', ['update-ref', '-d', snapshotRef], { cwd: bare });
	}
}

/**
 * Names bare repositories that were created before they kept their repository's name, from the
 * worktree folders of their delegated chats (`<repository name>-<shortId>`).
 */
export function nameExistingDelegationRepositories(layout: IDelegationStoreLayout, records: readonly { readonly repoId: string; readonly shortId: string; readonly worktree: string }[]): void {
	for (const record of records) {
		let bare: string;
		try {
			bare = getBareRepositoryPath(layout, record.repoId);
		} catch {
			continue;
		}
		const folder = record.worktree.split(/[\\/]/).pop() ?? '';
		const suffix = `-${record.shortId}`;
		if (!folder.endsWith(suffix) || folder.length === suffix.length || !fs.existsSync(join(bare, 'HEAD')) || readDelegationRepositoryName(bare)) {
			continue;
		}
		try {
			writeDelegationRepositoryName(bare, folder.slice(0, -suffix.length));
		} catch {
			// Best effort: the Agents window then shows the folder's id.
		}
	}
}

/** Removes the worktree of a delegated chat and its branch (when the user deletes the chat on the server). */
export async function removeDelegationWorktree(layout: IDelegationStoreLayout, repoId: string, delegationId: string, shortId: string, worktree: string, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<void> {
	const bare = getBareRepositoryPath(layout, repoId);
	await runner.run('git', ['worktree', 'remove', '--force', worktree], { cwd: bare });
	await runner.run('git', ['branch', '-D', getDelegationBranch(shortId)], { cwd: bare });
	await runner.run('git', ['update-ref', '-d', `refs/creaeditor/base/${delegationId}`], { cwd: bare });
	fs.rmSync(worktree, { recursive: true, force: true });
}

export interface IResultBundle {
	/** The commit the laptop's branch should point at (includes uncommitted work as a last commit). */
	readonly commit: string;
	/** Undefined when the laptop already has {@link commit}. */
	readonly bundleFile?: string;
	readonly bytes: number;
	/** The worktree had uncommitted changes; they are in a commit "Uncommitted changes from <server>". */
	readonly includesUncommitted: boolean;
}

/**
 * Bundles the delegated chat's work for Bring Back Changes: the branch, plus its uncommitted changes
 * as one more commit. `knownCommits` are commits the laptop has (the base it sent, its HEAD).
 */
export async function createResultBundle(worktree: string, options: { readonly knownCommits: readonly string[]; readonly outFile: string; readonly serverName: string }, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<IResultBundle> {
	if (!fs.existsSync(worktree)) {
		throw new DelegationError(DelegationErrorCode.NotFound, 'The server no longer has this chat\'s worktree.');
	}
	const snapshot = await snapshotWorkingTree(worktree, { includeSecretFiles: false, message: `Uncommitted changes from ${options.serverName}`, authorName: 'CreaEditor Server' }, runner);
	const known = await filterExistingCommits(worktree, options.knownCommits, runner);
	const exclusions = known.map(commit => `^${commit}`);
	const missing = Number((await git(runner, worktree, ['rev-list', '--count', snapshot.commit, ...exclusions])).trim());
	if (missing === 0) {
		return { commit: snapshot.commit, bytes: 0, includesUncommitted: snapshot.changed };
	}
	const ref = RESULT_BUNDLE_REF;
	try {
		await git(runner, worktree, ['update-ref', ref, snapshot.commit]);
		await git(runner, worktree, ['bundle', 'create', '-q', options.outFile, ref, ...exclusions]);
	} finally {
		await runner.run('git', ['update-ref', '-d', ref], { cwd: worktree });
	}
	return { commit: snapshot.commit, bundleFile: options.outFile, bytes: fs.statSync(options.outFile).size, includesUncommitted: snapshot.changed };
}

/**
 * Brings a result bundle into the laptop's repository as the branch `branch`
 * (`creaeditor/from-<server>/<shortId>`), without touching the working tree, the index or the
 * current branch.
 */
export async function importResultBundle(root: string, options: { readonly bundleFile?: string; readonly commit: string; readonly branch: string }, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<void> {
	assertCommit(options.commit, 'result commit');
	if (!await gitSucceeds(runner, root, ['check-ref-format', '--branch', options.branch])) {
		throw new DelegationError(DelegationErrorCode.InvalidRequest, `Invalid branch name ${options.branch}.`);
	}
	const current = await runner.run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root });
	if (current.code === 0 && current.stdout.trim() === options.branch) {
		throw new DelegationError(DelegationErrorCode.BranchCheckedOut, `${options.branch} is checked out. Switch to another branch first, so the changes do not overwrite your files.`);
	}
	if (options.bundleFile) {
		const verify = await runner.run('git', ['bundle', 'verify', '-q', options.bundleFile], { cwd: root });
		if (verify.code !== 0) {
			throw new DelegationError(DelegationErrorCode.MissingHistory, `The changes do not fit this repository: ${verify.stderr.trim()}`);
		}
		// Only into FETCH_HEAD: no ref of the repository changes but the branch below.
		await git(runner, root, ['fetch', '-q', '--no-tags', options.bundleFile, RESULT_BUNDLE_REF]);
	}
	if (!await gitSucceeds(runner, root, ['cat-file', '-e', `${options.commit}^{commit}`])) {
		throw new DelegationError(DelegationErrorCode.MissingHistory, 'The changes from the server are incomplete. Try again.');
	}
	await git(runner, root, ['branch', '-f', options.branch, options.commit]);
}

/** A GitHub repository read from a remote URL. */
export function parseGitHubRemote(remoteUrl: string): { readonly owner: string; readonly repo: string } | undefined {
	const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
	return match?.groups ? { owner: match.groups.owner, repo: match.groups.repo } : undefined;
}

export interface IOpenPullRequestOptions {
	readonly worktree: string;
	readonly branch: string;
	/** The repository's `origin` URL. */
	readonly remoteUrl: string | undefined;
	/** The branch to merge into; the repository's default branch when undefined. */
	readonly base?: string;
	readonly title: string;
	readonly body: string;
	/** The server's GitHub token (from its secret store). */
	readonly token: string;
	readonly serverName: string;
}

/**
 * Commits uncommitted work in the worktree, pushes the branch to GitHub with the server's token and
 * opens a pull request with `gh`. Answers the pull request's URL. The token only travels in the
 * environment of `git` and `gh`, never in arguments or logs.
 */
export async function openPullRequestFromServer(options: IOpenPullRequestOptions, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<string> {
	const github = options.remoteUrl ? parseGitHubRemote(options.remoteUrl) : undefined;
	if (!github) {
		throw new DelegationError(DelegationErrorCode.NotGitHub, 'Open PR from the Server works with GitHub repositories only. Use Bring Back Changes instead.');
	}
	const status = await git(runner, options.worktree, ['status', '--porcelain']);
	if (status.trim()) {
		await git(runner, options.worktree, ['add', '-A']);
		await git(runner, options.worktree, ['commit', '-q', '-m', `Changes from ${options.serverName}`], delegationCommitIdentity('CreaEditor Server'));
	}
	const basic = Buffer.from(`x-access-token:${options.token}`, 'utf8').toString('base64');
	const pushEnv = {
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
	};
	const pushUrl = `https://github.com/${github.owner}/${github.repo}.git`;
	const push = await runner.run('git', ['push', '-q', pushUrl, `HEAD:refs/heads/${options.branch}`], { cwd: options.worktree, env: pushEnv });
	if (push.code !== 0) {
		throw new DelegationError(DelegationErrorCode.PushFailed, `The server could not push ${options.branch} to GitHub. Check the server's GitHub token (it needs access to ${github.owner}/${github.repo}).`);
	}
	const args = ['pr', 'create', '--repo', `${github.owner}/${github.repo}`, '--head', options.branch, '--title', options.title, '--body', options.body, ...(options.base ? ['--base', options.base] : [])];
	const created = await runner.run('gh', args, { cwd: options.worktree, env: { GH_TOKEN: options.token, GH_PROMPT_DISABLED: '1' } });
	if (created.code === -1) {
		throw new DelegationError(DelegationErrorCode.GhMissing, 'The GitHub CLI (gh) is not installed on the server. Install it there, or use Bring Back Changes.');
	}
	const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(`${created.stdout}\n${created.stderr}`)?.[0];
	if (!url) {
		throw new DelegationError(DelegationErrorCode.PullRequestFailed, `The server pushed ${options.branch} but could not open the pull request: ${created.stderr.trim().split('\n')[0] ?? ''}`);
	}
	// `gh` also answers the URL of a pull request that exists already.
	return url;
}
