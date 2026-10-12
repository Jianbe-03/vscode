/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the branch and repository of a session's working directory, for the cost ledger. Read from
// the git files directly (no git process per model request); a worktree's `.git` file is followed to its
// git dir, and its remotes come from the main repository's config.

import { promises as fs } from 'fs';
import { dirname, join, resolve } from '../../../../base/common/path.js';

/** The branch and repository a session works in. A missing field means the folder has none. */
export interface IGitWorkLocation {
	readonly branch?: string;
	/** `owner/repo` of the folder's remote (`origin` first). */
	readonly repo?: string;
}

/** How long a read location is reused: a model request comes every few seconds while a chat runs. */
const CACHE_MILLISECONDS = 5_000;
const MAX_CACHED_FOLDERS = 200;

/** The branch of a `HEAD` file, `undefined` when it is detached. */
export function parseGitHeadBranch(head: string): string | undefined {
	return /^ref:\s*refs\/heads\/(?<branch>\S.*?)\s*$/m.exec(head)?.groups?.branch;
}

/** The url of the `origin` remote in a git config, else of its first remote with a url. */
export function parseGitRemoteUrl(config: string): string | undefined {
	let remote: string | undefined;
	let first: string | undefined;
	for (const line of config.split(/\r?\n/)) {
		const section = /^\s*\[(?<header>[^\]]*)\]/.exec(line);
		if (section?.groups) {
			remote = /^\s*remote\s+"(?<name>[^"]+)"\s*$/.exec(section.groups.header)?.groups?.name;
			continue;
		}
		const url = remote !== undefined ? /^\s*url\s*=\s*(?<url>\S.*?)\s*$/.exec(line)?.groups?.url : undefined;
		if (url) {
			if (remote === 'origin') {
				return url;
			}
			first ??= url;
		}
	}
	return first;
}

/** `owner/repo` of a git remote url (https or ssh), like the copilot extension's `repoFromRemoteUrl`. */
export function repoFromGitRemoteUrl(remoteUrl: string | undefined): string | undefined {
	return remoteUrl ? /[/:](?<repo>[\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())?.groups?.repo : undefined;
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

/** The git dir of a folder or one of its parents: a `.git` folder, or the `gitdir:` of a worktree's `.git` file. */
async function findGitDir(folder: string): Promise<string | undefined> {
	let current = resolve(folder);
	while (true) {
		const candidate = join(current, '.git');
		try {
			if ((await fs.stat(candidate)).isDirectory()) {
				return candidate;
			}
			const gitDir = /^gitdir:\s*(?<path>\S.*?)\s*$/m.exec(await fs.readFile(candidate, 'utf8'))?.groups?.path;
			return gitDir ? resolve(current, gitDir) : undefined;
		} catch {
			// No `.git` here.
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/** Reads the branch and repository of a folder; an empty location when it is not in a git repository. */
export async function readGitWorkLocation(folder: string): Promise<IGitWorkLocation> {
	const gitDir = await findGitDir(folder);
	if (!gitDir) {
		return {};
	}
	const head = await readText(join(gitDir, 'HEAD'));
	// A linked worktree's git dir names the main repository's git dir, which holds the config.
	const commonDir = (await readText(join(gitDir, 'commondir')))?.trim();
	const config = await readText(join(commonDir ? resolve(gitDir, commonDir) : gitDir, 'config'));
	const branch = head !== undefined ? parseGitHeadBranch(head) : undefined;
	const repo = config !== undefined ? repoFromGitRemoteUrl(parseGitRemoteUrl(config)) : undefined;
	return { ...(branch ? { branch } : {}), ...(repo ? { repo } : {}) };
}

/** Reads work locations, reusing a folder's for a few seconds. */
export class GitWorkLocationCache {

	private readonly _cache = new Map<string, { readonly time: number; readonly location: Promise<IGitWorkLocation> }>();

	constructor(
		private readonly _read: (folder: string) => Promise<IGitWorkLocation> = readGitWorkLocation,
		private readonly _now: () => number = Date.now,
	) { }

	get(folder: string): Promise<IGitWorkLocation> {
		const now = this._now();
		const cached = this._cache.get(folder);
		if (cached && now - cached.time < CACHE_MILLISECONDS) {
			return cached.location;
		}
		const location = this._read(folder).catch(() => ({}));
		this._cache.delete(folder);
		this._cache.set(folder, { time: now, location });
		if (this._cache.size > MAX_CACHED_FOLDERS) {
			this._cache.delete(this._cache.keys().next().value!);
		}
		return location;
	}
}
