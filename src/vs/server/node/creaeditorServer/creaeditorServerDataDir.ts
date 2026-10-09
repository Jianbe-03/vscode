/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: what the CreaEditor Server keeps in its data folder. Back up the whole folder (with the
// server stopped) to keep chats, accounts and paired devices; `secrets/master.key` is needed to read
// `secrets/secrets.json`, so keep them together and private.

import * as fs from 'fs';
import { join } from '../../../base/common/path.js';

export interface ICreaEditorServerDataLayout {
	readonly root: string;
	/** The agent host's user data folder: chats (session database), agent settings, accounts and logs. */
	readonly agentHost: string;
	/** The encrypted secret store (setup-tokens, gateway keys) and its master key. */
	readonly secrets: string;
	/** Paired devices, the password and other state of the remote access front. */
	readonly remoteAccess: string;
	/** Repositories the server works in; chat worktrees go next to them (`<repo>.worktrees`). */
	readonly repos: string;
	/** The server's own log files. */
	readonly logs: string;
	/** The latest one-time pairing code and link, readable by the owner only. */
	readonly pairingFile: string;
	/** Where a running server writes its pid, address and version, for `creaeditor-server status`. */
	readonly runtimeFile: string;
	/** The unix socket of the agent host (in the private `agent-host` folder). */
	readonly agentHostSocket: string;
	/** The token of the server's admin endpoint on 127.0.0.1, for `creaeditor-server pair` and `password`. */
	readonly adminTokenFile: string;
	/** The AI cost ledger of requests the server makes itself, and the budgets laptops push. */
	readonly costs: string;
	/** How many chats run and wait (written by the agent host, read for `/health`). */
	readonly chatsStatusFile: string;
}

export function getCreaEditorServerDataLayout(root: string): ICreaEditorServerDataLayout {
	return {
		root,
		agentHost: join(root, 'agent-host'),
		secrets: join(root, 'secrets'),
		remoteAccess: join(root, 'remote-access'),
		repos: join(root, 'repos'),
		logs: join(root, 'logs'),
		pairingFile: join(root, 'pairing.txt'),
		runtimeFile: join(root, 'server.json'),
		agentHostSocket: join(root, 'agent-host', 'agent-host.sock'),
		adminTokenFile: join(root, 'remote-access', 'admin-token'),
		costs: join(root, 'costs'),
		chatsStatusFile: join(root, 'agent-host', 'chats.json'),
	};
}

/** Creates the data folder and its subfolders, private to the user running the server. */
export function ensureCreaEditorServerDataDir(layout: ICreaEditorServerDataLayout): void {
	for (const dir of [layout.root, layout.agentHost, layout.secrets, layout.remoteAccess, layout.repos, layout.logs, layout.costs]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	// An existing folder keeps its mode with `mkdir`: make the root private anyway.
	if (process.platform !== 'win32') {
		fs.chmodSync(layout.root, 0o700);
	}
}

/** What a running server writes to {@link ICreaEditorServerDataLayout.runtimeFile}. */
export interface ICreaEditorServerRuntimeInfo {
	readonly pid: number;
	readonly host: string;
	readonly port: number;
	readonly version: string;
	readonly startedAt: number;
	readonly publicUrl?: string;
	/** The port of the admin endpoint on 127.0.0.1. */
	readonly adminPort: number;
}

export function readCreaEditorServerRuntimeInfo(layout: ICreaEditorServerDataLayout): ICreaEditorServerRuntimeInfo | undefined {
	try {
		const value = JSON.parse(fs.readFileSync(layout.runtimeFile, 'utf8')) as Partial<ICreaEditorServerRuntimeInfo>;
		if (typeof value.pid === 'number' && typeof value.port === 'number' && typeof value.host === 'string' && typeof value.adminPort === 'number') {
			return value as ICreaEditorServerRuntimeInfo;
		}
	} catch {
		// Not running, or never ran.
	}
	return undefined;
}

/** Writes a file only the owner can read, replacing it atomically. */
export function writePrivateFile(path: string, content: string): void {
	const temp = `${path}.${process.pid}.tmp`;
	fs.writeFileSync(temp, content, { mode: 0o600 });
	fs.renameSync(temp, path);
}
