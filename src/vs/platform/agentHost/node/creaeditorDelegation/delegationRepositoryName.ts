/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the name the Agents window shows for a repository. A CreaEditor Server keeps delegated
// code in bare repositories `<data>/repos/<repoId>.git`, which are the primary worktree root (git
// common dir) of every delegated chat's worktree. Their folder name is an id, so the server writes
// the repository's own name into the bare repository, and sessions there group under that name.

import * as fs from 'fs';
import { basename, join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';

/** The file in a bare repository with the repository's name (one line). */
export const DELEGATION_REPOSITORY_NAME_FILE = 'creaeditor-repository-name';

const MAX_NAME_LENGTH = 100;

/** Writes the repository's name into a bare repository (see {@link getRepositoryDisplayName}). */
export function writeDelegationRepositoryName(bareRepository: string, name: string): void {
	const clean = sanitizeName(name);
	if (clean) {
		fs.writeFileSync(join(bareRepository, DELEGATION_REPOSITORY_NAME_FILE), `${clean}\n`, { mode: 0o600 });
	}
}

/** The name kept in a bare repository by {@link writeDelegationRepositoryName}, if any. */
export function readDelegationRepositoryName(bareRepository: string): string | undefined {
	try {
		return sanitizeName(fs.readFileSync(join(bareRepository, DELEGATION_REPOSITORY_NAME_FILE), 'utf8'));
	} catch {
		return undefined;
	}
}

/**
 * The display name of a repository root: its folder name, or for a bare repository (`*.git`) the name
 * a CreaEditor Server kept in it.
 */
export function getRepositoryDisplayName(repositoryRoot: URI): string {
	const folderName = basename(repositoryRoot.fsPath);
	if (repositoryRoot.scheme === 'file' && folderName.endsWith('.git')) {
		const name = readDelegationRepositoryName(repositoryRoot.fsPath);
		if (name) {
			return name;
		}
	}
	return folderName || repositoryRoot.toString();
}

function sanitizeName(name: string): string | undefined {
	const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
	return clean || undefined;
}
