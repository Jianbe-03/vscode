/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: every extra Codex (ChatGPT) account signs in inside its own CODEX_HOME. Only the account's
// `auth.json` lives there; everything else links to the default CODEX_HOME, so threads, settings, skills
// and the state database are shared and a chat can resume on another account.

import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';

/** The only entry of a CODEX_HOME that belongs to the account rather than to the user. */
const CODEX_ACCOUNT_OWN_ENTRIES = new Set(['auth.json']);

/**
 * Folders created in the default CODEX_HOME before linking, so a Codex that has never run there still
 * writes its threads to the shared folder instead of into the account's own home.
 */
const CODEX_SHARED_FOLDERS = ['sessions', 'archived_sessions'];

/** The CODEX_HOME the Codex CLI uses by itself: `$CODEX_HOME` or `~/.codex`. */
export function resolveDefaultCodexHome(configuredHome: string | undefined, userHome: string): string {
	return configuredHome || join(userHome, '.codex');
}

/** The CODEX_HOME of a user-added account. */
export function getCodexAccountHome(userHome: string, accountId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(accountId)) {
		throw new Error(`Invalid Codex account id: ${accountId}`);
	}
	return join(userHome, '.creaeditor', 'codex-accounts', accountId);
}

/**
 * Create the account's CODEX_HOME and link every entry of the default CODEX_HOME into it except the
 * account's own `auth.json`. Safe to run before every start: it only adds links for entries that appeared
 * in the default home since, and leaves anything the account home already has alone.
 */
export async function prepareCodexAccountHome(defaultHome: string, accountHome: string): Promise<void> {
	await fs.promises.mkdir(defaultHome, { recursive: true, mode: 0o700 });
	await fs.promises.mkdir(accountHome, { recursive: true, mode: 0o700 });
	for (const folder of CODEX_SHARED_FOLDERS) {
		await fs.promises.mkdir(join(defaultHome, folder), { recursive: true });
	}
	const [sharedEntries, ownEntries] = await Promise.all([
		fs.promises.readdir(defaultHome),
		fs.promises.readdir(accountHome),
	]);
	const existing = new Set(ownEntries);
	for (const entry of sharedEntries) {
		if (CODEX_ACCOUNT_OWN_ENTRIES.has(entry) || existing.has(entry)) {
			continue;
		}
		const target = join(defaultHome, entry);
		const stat = await fs.promises.stat(target).catch(() => undefined);
		if (!stat) {
			continue;
		}
		try {
			// Junctions need no extra privileges on Windows; elsewhere the type is ignored.
			await fs.promises.symlink(target, join(accountHome, entry), stat.isDirectory() ? 'junction' : 'file');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
		}
	}
}

/**
 * Forget the account's sign-in. The links stay: Codex records thread paths below the home it ran in, so
 * removing them would break resuming the threads the account started.
 */
export async function removeCodexAccountSignIn(accountHome: string): Promise<void> {
	await fs.promises.rm(join(accountHome, 'auth.json'), { force: true });
}
