/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: moves an agent's own session files to a CreaEditor Server, so a delegated chat resumes as
// the same session there instead of starting over with a transcript.
//
// Claude: the Agent SDK keeps a session as `<config>/projects/<project>/<sessionId>.jsonl` (plus a
// `<sessionId>/` folder with subagent transcripts), where `<config>` is `CLAUDE_CONFIG_DIR` or
// `~/.claude` and `<project>` is the session's working directory with every character other than
// a-z, A-Z and 0-9 replaced by `-` (cut at 200 characters plus a hash). On the server the files go
// into the project folder of the worktree, and the laptop's folder is replaced by the worktree in
// them, so the SDK finds the session (by id) and runs it in the worktree.

import * as fs from 'fs';
import { homedir } from 'os';
import { join, relative, sep } from '../../../../base/common/path.js';
import { DelegationErrorCode, IDelegationSessionFile } from '../../common/creaeditorDelegation.js';
import { DelegationError } from './delegationPack.js';

/** The largest session (all files together) that is sent; larger chats use the transcript instead. */
export const MAX_SESSION_FILES_BYTES = 64 * 1024 * 1024;

const CLAUDE_MAX_PROJECT_DIR_LENGTH = 200;

/** The Claude config folder of a process environment. */
export function getClaudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	return env['CLAUDE_CONFIG_DIR'] || join(home, '.claude');
}

function claudePathHash(value: string): string {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (hash << 5) - hash + value.charCodeAt(i) | 0;
	}
	return Math.abs(hash).toString(36);
}

/** The folder name the Claude Agent SDK uses for sessions with working directory `cwd`. */
export function getClaudeProjectDirName(cwd: string): string {
	const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
	return name.length <= CLAUDE_MAX_PROJECT_DIR_LENGTH ? name : `${name.slice(0, CLAUDE_MAX_PROJECT_DIR_LENGTH)}-${claudePathHash(cwd)}`;
}

/** Finds `<sessionId>.jsonl` in any project folder of `configDir`. */
export function findClaudeSessionTranscript(configDir: string, sessionId: string): string | undefined {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
		return undefined;
	}
	const projects = join(configDir, 'projects');
	let entries: string[];
	try {
		entries = fs.readdirSync(projects);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const candidate = join(projects, entry, `${sessionId}.jsonl`);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function listFiles(dir: string): string[] {
	const result: string[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return result;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			result.push(...listFiles(path));
		} else if (entry.isFile()) {
			result.push(path);
		}
	}
	return result;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the laptop's folder `from` by the server's folder `to` in a JSON lines file: wherever it is
 * a whole JSON string or the start of a path in one (`"<from>"`, `"<from>/src/a.ts"`).
 */
export function rewriteSessionPaths(content: string, from: string, to: string): string {
	if (!from || from === to) {
		return content;
	}
	const fromJson = JSON.stringify(from).slice(1, -1);
	const toJson = JSON.stringify(to).slice(1, -1);
	const separator = JSON.stringify(sep).slice(1, -1);
	const pattern = new RegExp(`"${escapeRegExp(fromJson)}(?=["/]|${escapeRegExp(separator)})`, 'g');
	return content.replace(pattern, `"${toJson}`);
}

export interface IClaudeSessionExport {
	readonly sessionId: string;
	readonly files: readonly IDelegationSessionFile[];
	readonly bytes: number;
}

/**
 * Reads a Claude session for the server: the transcript and its folder, rewritten from `fromCwd` to
 * `toCwd` and placed (relative to the server's Claude config folder) in the project folder of `toCwd`.
 * `fromRoot`/`toRoot` (the repository and the worktree) are rewritten too, for paths in tool calls.
 */
export function exportClaudeSession(options: { readonly configDir: string; readonly sessionId: string; readonly fromCwd: string; readonly toCwd: string; readonly fromRoot?: string; readonly toRoot?: string; readonly maxBytes?: number }): IClaudeSessionExport | undefined {
	const transcript = findClaudeSessionTranscript(options.configDir, options.sessionId);
	if (!transcript) {
		return undefined;
	}
	const projectDir = join(transcript, '..');
	const sessionDir = join(projectDir, options.sessionId);
	const targetProject = `projects/${getClaudeProjectDirName(options.toCwd)}`;
	const sources = [transcript, ...listFiles(sessionDir)];
	const maxBytes = options.maxBytes ?? MAX_SESSION_FILES_BYTES;
	let bytes = 0;
	const files: IDelegationSessionFile[] = [];
	for (const source of sources) {
		bytes += fs.statSync(source).size;
		if (bytes > maxBytes) {
			throw new DelegationError(DelegationErrorCode.TooLarge, 'This chat\'s session files are too large to send; it continues with a transcript instead.');
		}
		let content = fs.readFileSync(source);
		if (source.endsWith('.jsonl') || source.endsWith('.json')) {
			let text = rewriteSessionPaths(content.toString('utf8'), options.fromCwd, options.toCwd);
			if (options.fromRoot && options.toRoot) {
				text = rewriteSessionPaths(text, options.fromRoot, options.toRoot);
			}
			content = Buffer.from(text, 'utf8');
		}
		const relativePath = relative(projectDir, source).split(sep).join('/');
		files.push({ relativePath: `${targetProject}/${relativePath}`, content: content.toString('base64') });
	}
	return { sessionId: options.sessionId, files, bytes };
}

/** Throws unless `relativePath` stays inside its folder. */
function assertRelativePath(relativePath: string): void {
	const parts = relativePath.split('/');
	if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0') || parts.some(part => part === '..' || part === '.' || part === '')) {
		throw new DelegationError(DelegationErrorCode.InvalidRequest, 'Invalid session file path.');
	}
}

/**
 * Writes session files into an agent's folder on the server (`~/.claude` for Claude). Refuses paths
 * that leave the folder, and files that exist already (another chat's session).
 */
export function installSessionFiles(agentDir: string, files: readonly IDelegationSessionFile[]): void {
	let bytes = 0;
	for (const file of files) {
		assertRelativePath(file.relativePath);
		bytes += Math.floor(file.content.length * 3 / 4);
	}
	if (bytes > MAX_SESSION_FILES_BYTES) {
		throw new DelegationError(DelegationErrorCode.TooLarge, 'The session files are too large.');
	}
	for (const file of files) {
		const target = join(agentDir, ...file.relativePath.split('/'));
		if (fs.existsSync(target)) {
			throw new DelegationError(DelegationErrorCode.InvalidRequest, 'This session exists on the server already.');
		}
	}
	for (const file of files) {
		const target = join(agentDir, ...file.relativePath.split('/'));
		fs.mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
		fs.writeFileSync(target, Buffer.from(file.content, 'base64'), { mode: 0o600, flag: 'wx' });
	}
}
