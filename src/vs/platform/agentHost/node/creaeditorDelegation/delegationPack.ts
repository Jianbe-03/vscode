/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: packs the code of a chat for Delegate to Server into one git bundle.
//
// The bundle carries two refs: `head` (the current commit, with the history the server lacks) and
// `snapshot`, a commit on top of `head` whose tree is the working tree as it is now: uncommitted
// changes of tracked files plus untracked files that are not ignored (`.gitignore` is respected).
// The snapshot is built in a temporary index, so the user's index, working tree and branches are
// never touched; only two temporary refs exist while the bundle is written. Untracked files that
// look like secrets (`.env*`, keys) stay behind unless the user includes them.
//
// Incremental: the server tells which commits it has; those become `^<commit>` prerequisites, so
// only the difference is sent.

import { createHash } from 'crypto';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { generateUuid } from '../../../../base/common/uuid.js';
import { basename, dirname, join } from '../../../../base/common/path.js';
import { delegationCommitIdentity, git, gitSucceeds, IDelegationProcessRunner, nodeDelegationProcessRunner } from './delegationProcess.js';
import { CREAEDITOR_DELEGATION_BUNDLE_HEAD_REF, CREAEDITOR_DELEGATION_BUNDLE_SNAPSHOT_REF, CREAEDITOR_DELEGATION_SECRET_FILE_GLOBS, DelegationErrorCode } from '../../common/creaeditorDelegation.js';

/** An error the UI shows as is (with its code for tests and telemetry-free branching). */
export class DelegationError extends Error {
	constructor(readonly code: DelegationErrorCode, message: string) {
		super(message);
		this.name = 'DelegationError';
	}
}

export interface IDelegationRepositoryInfo {
	/** The top-level folder of the repository. */
	readonly root: string;
	/** The folder of the chat relative to {@link root} (`''` at the top). */
	readonly subPath: string;
	/** Stable id of the repository: the same project on any machine has the same id. */
	readonly repoId: string;
	readonly head: string;
	/** The branch checked out, undefined on a detached HEAD. */
	readonly branch?: string;
	/** The fetch URL of `origin` (or the first remote), for pull requests from the server. */
	readonly remoteUrl?: string;
	/** The default branch of `origin` (`main`), when git knows it. */
	readonly defaultBranch?: string;
	/** The repository's name: of `origin`'s URL, else the folder of its main working tree (not of a worktree). */
	readonly name: string;
}

/** Reads what Delegate to Server needs to know about the repository of `folder`. */
export async function readDelegationRepository(folder: string, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<IDelegationRepositoryInfo> {
	const topLevel = await runner.run('git', ['rev-parse', '--show-toplevel'], { cwd: folder });
	if (topLevel.code !== 0) {
		throw new DelegationError(DelegationErrorCode.NotARepository, `${folder} is not in a git repository. Delegate to Server sends code with git; run "git init" and commit first.`);
	}
	const root = topLevel.stdout.trim();
	const headResult = await runner.run('git', ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: root });
	if (headResult.code !== 0) {
		throw new DelegationError(DelegationErrorCode.NoCommits, 'The repository has no commits yet. Commit once, then delegate.');
	}
	const head = headResult.stdout.trim();
	const branchResult = await runner.run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root });
	const branch = branchResult.code === 0 ? branchResult.stdout.trim() || undefined : undefined;
	const roots = (await git(runner, root, ['rev-list', '--max-parents=0', 'HEAD'])).split('\n').map(line => line.trim()).filter(Boolean).sort();
	const repoId = createHash('sha256').update(`creaeditor-repo:${roots[0]}`).digest('hex').slice(0, 16);
	const remotes = (await git(runner, root, ['remote'])).split('\n').map(line => line.trim()).filter(Boolean);
	const remote = remotes.includes('origin') ? 'origin' : remotes[0];
	let remoteUrl: string | undefined;
	let defaultBranch: string | undefined;
	if (remote) {
		const url = await runner.run('git', ['remote', 'get-url', remote], { cwd: root });
		remoteUrl = url.code === 0 ? url.stdout.trim() || undefined : undefined;
		const remoteHead = await runner.run('git', ['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`], { cwd: root });
		defaultBranch = remoteHead.code === 0 ? remoteHead.stdout.trim().replace(`${remote}/`, '') || undefined : undefined;
	}
	const relative = fs.realpathSync(folder).slice(fs.realpathSync(root).length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
	const name = await readRepositoryName(root, remoteUrl, runner);
	return { root, subPath: relative, repoId, head, name, ...(branch ? { branch } : {}), ...(remoteUrl ? { remoteUrl } : {}), ...(defaultBranch ? { defaultBranch } : {}) };
}

/** The name of a repository: the last part of its remote URL, else the folder of its main working tree (`.git`'s parent). */
async function readRepositoryName(root: string, remoteUrl: string | undefined, runner: IDelegationProcessRunner): Promise<string> {
	const fromRemote = remoteUrl?.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop();
	if (fromRemote) {
		return fromRemote;
	}
	const commonDir = await runner.run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root });
	const gitDir = commonDir.code === 0 ? commonDir.stdout.trim() : '';
	return gitDir && basename(gitDir) === '.git' ? basename(dirname(gitDir)) : basename(root);
}

/** Pathspecs that keep secret-looking files out. */
function secretExcludePathspecs(): string[] {
	return CREAEDITOR_DELEGATION_SECRET_FILE_GLOBS.map(glob => `:(exclude,glob)${glob}`);
}

/**
 * Untracked, not ignored files that look like secrets (`.env.local`, `id_rsa`); they are left out
 * unless the user includes them.
 */
export async function listUntrackedSecretFiles(root: string, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<string[]> {
	const output = await git(runner, root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...CREAEDITOR_DELEGATION_SECRET_FILE_GLOBS.map(glob => `:(glob)${glob}`)]);
	return output.split('\0').filter(Boolean).sort();
}

/**
 * The tree the working tree of `root` has now (tracked changes and untracked, not ignored files;
 * secret-looking untracked ones only when asked), written through a temporary index, and the tree
 * of `HEAD`.
 */
export async function writeWorkingTreeTree(root: string, includeSecretFiles: boolean, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<{ readonly head: string; readonly tree: string; readonly headTree: string }> {
	const head = (await git(runner, root, ['rev-parse', 'HEAD'])).trim();
	const indexDir = fs.mkdtempSync(join(tmpdir(), 'creaeditor-index-'));
	const env = { GIT_INDEX_FILE: join(indexDir, 'index') };
	try {
		await git(runner, root, ['read-tree', 'HEAD'], env);
		// Changes and deletions of tracked files, secrets included: they are in the repository anyway.
		await git(runner, root, ['add', '-u', '--', '.'], env);
		// New files, without ignored ones (and without secret-looking ones unless asked).
		await git(runner, root, ['add', '-A', '--', '.', ...(includeSecretFiles ? [] : secretExcludePathspecs())], env);
		const tree = (await git(runner, root, ['write-tree'], env)).trim();
		const headTree = (await git(runner, root, ['rev-parse', 'HEAD^{tree}'])).trim();
		return { head, tree, headTree };
	} finally {
		fs.rmSync(indexDir, { recursive: true, force: true });
	}
}

/**
 * Commits the working tree of `root` as it is now (tracked changes and untracked, not ignored files)
 * on top of `HEAD`, through a temporary index. Answers `HEAD` itself when nothing changed.
 */
export async function snapshotWorkingTree(root: string, options: { readonly includeSecretFiles: boolean; readonly message: string; readonly authorName: string }, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<{ readonly commit: string; readonly tree: string; readonly changed: boolean }> {
	const { head, tree, headTree } = await writeWorkingTreeTree(root, options.includeSecretFiles, runner);
	if (tree === headTree) {
		return { commit: head, tree, changed: false };
	}
	const commit = (await git(runner, root, ['commit-tree', tree, '-p', head, '-m', options.message], delegationCommitIdentity(options.authorName))).trim();
	return { commit, tree, changed: true };
}

/** Answers the commits of `candidates` that exist in the repository at `cwd`. */
export async function filterExistingCommits(cwd: string, candidates: readonly string[], runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<string[]> {
	const existing: string[] = [];
	for (const candidate of new Set(candidates)) {
		if (/^[0-9a-f]{40,64}$/.test(candidate) && await gitSucceeds(runner, cwd, ['cat-file', '-e', `${candidate}^{commit}`])) {
			existing.push(candidate);
		}
	}
	return existing;
}

export interface IPackWorkspaceOptions {
	/** The chat's folder (anywhere in the repository). */
	readonly folder: string;
	/** Where to write the bundle. */
	readonly outFile: string;
	/** Commits the server already has (it answers them before the upload). */
	readonly knownCommits: readonly string[];
	/** Also send untracked files that look like secrets (`.env.local`). Off by default. */
	readonly includeSecretFiles: boolean;
	/** The largest bundle to send, in bytes. */
	readonly maxBytes: number;
}

export interface IPackedWorkspace extends IDelegationRepositoryInfo {
	/** The commit whose tree is the working tree (equal to {@link head} without local changes). */
	readonly snapshot: string;
	readonly hasLocalChanges: boolean;
	/** Size of the bundle; 0 when the server has everything already (no bundle written). */
	readonly bytes: number;
	/** The server had some of the history, so only the difference is in the bundle. */
	readonly incremental: boolean;
	/** Secret-looking untracked files that were left out. */
	readonly skippedSecretFiles: readonly string[];
}

/** Packs the code of `folder` into a git bundle at `outFile`, see the top of this file. */
export async function packWorkspace(options: IPackWorkspaceOptions, runner: IDelegationProcessRunner = nodeDelegationProcessRunner): Promise<IPackedWorkspace> {
	const info = await readDelegationRepository(options.folder, runner);
	const { root } = info;
	const snapshot = await snapshotWorkingTree(root, { includeSecretFiles: options.includeSecretFiles, message: 'CreaEditor: uncommitted changes', authorName: 'CreaEditor' }, runner);
	const skippedSecretFiles = options.includeSecretFiles ? [] : await listUntrackedSecretFiles(root, runner);
	const known = await filterExistingCommits(root, options.knownCommits, runner);
	const exclusions = known.map(commit => `^${commit}`);

	const missing = Number((await git(runner, root, ['rev-list', '--count', snapshot.commit, ...exclusions])).trim());
	if (missing === 0) {
		fs.rmSync(options.outFile, { force: true });
		return { ...info, snapshot: snapshot.commit, hasLocalChanges: snapshot.changed, bytes: 0, incremental: known.length > 0, skippedSecretFiles };
	}

	// `git bundle` only takes refs: point two temporary refs at the commits while it runs.
	const temp = `refs/creaeditor/tmp/${generateUuid()}`;
	const headRef = `${temp}/${CREAEDITOR_DELEGATION_BUNDLE_HEAD_REF}`;
	const snapshotRef = `${temp}/${CREAEDITOR_DELEGATION_BUNDLE_SNAPSHOT_REF}`;
	try {
		await git(runner, root, ['update-ref', headRef, info.head]);
		await git(runner, root, ['update-ref', snapshotRef, snapshot.commit]);
		fs.mkdirSync(join(options.outFile, '..'), { recursive: true });
		await git(runner, root, ['bundle', 'create', '-q', options.outFile, headRef, snapshotRef, ...exclusions]);
	} finally {
		await runner.run('git', ['update-ref', '-d', headRef], { cwd: root });
		await runner.run('git', ['update-ref', '-d', snapshotRef], { cwd: root });
	}
	const bytes = fs.statSync(options.outFile).size;
	if (bytes > options.maxBytes) {
		fs.rmSync(options.outFile, { force: true });
		const mb = (value: number) => Math.ceil(value / (1024 * 1024));
		throw new DelegationError(DelegationErrorCode.TooLarge, `The code to send is ${mb(bytes)} MB, more than the limit of ${mb(options.maxBytes)} MB. Add large generated files to .gitignore, or raise the limit in the setting creaeditor.delegation.maxUploadMB.`);
	}
	return { ...info, snapshot: snapshot.commit, hasLocalChanges: snapshot.changed, bytes, incremental: known.length > 0, skippedSecretFiles };
}

/** The refs of a delegation bundle as `git fetch` refspecs into `namespace` (`refs/creaeditor/incoming/<id>`). */
export function bundleFetchRefspecs(namespace: string): string[] {
	return [`+refs/creaeditor/tmp/*:${namespace}/*`];
}
