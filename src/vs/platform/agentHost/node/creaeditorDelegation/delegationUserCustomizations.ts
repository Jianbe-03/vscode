/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: Delegate to Server also sends the user's personal agents, skills and instructions, so a
// delegated chat behaves on the server as it did on the laptop. Repository customizations already go
// along with the code; these are the user-level ones:
//
// - Claude: `~/.claude/agents/**`, `skills/**`, `commands/**` and `CLAUDE.md` (the user memory).
// - Copilot CLI: `~/.copilot/agents/**`, `skills/**` and `copilot-instructions.md`.
// - Codex: `~/.codex/AGENTS.md`. (Codex reads prompts and skills only from its home folder, which the
//   server shares between chats, so those stay on the laptop.)
//
// Never anything with credentials or state: settings, `.credentials*`, `auth.json`, `config.toml`,
// MCP configurations, `.env*` and keys, caches, `projects/`, `sessions/`, `todos/`; no file over 1 MB
// and at most 10 MB in all.
//
// The laptop seals them for the server like the accounts (`delegationCrypto.ts`) and sends them to the
// code receiver, which keeps them per delegation in `<data>/user-customizations/<delegationId>/`
// (removed with the delegation's worktree). Only the server's agent for THAT chat uses them: the agents
// look them up by the chat's working directory (inside the delegation's worktree):
//
// - Claude: `claude/` is a Claude Code plugin (`.claude-plugin/plugin.json`) passed as a local plugin
//   of that session, and `CLAUDE.md` is appended to its system prompt. The server's own `~/.claude`
//   stays as it is.
// - Copilot CLI: `copilot/` is an Open Plugins folder (`.plugin/plugin.json`) passed in the session's
//   `pluginDirectories`, and `copilot-instructions.md` is appended to its system message.
// - Codex: `codex/AGENTS.md` is added to the thread's developer instructions.

import * as fs from 'fs';
import { isEqualOrParent } from '../../../../base/common/extpath.js';
import { dirname, join } from '../../../../base/common/path.js';
import { CREAEDITOR_DELEGATION_SECRET_FILE_GLOBS } from '../../common/creaeditorDelegation.js';

/** Set by the CreaEditor Server for its agent host: where the personal customizations of delegated chats are. */
export const AGENT_HOST_USER_CUSTOMIZATIONS_DIR_ENV_VAR = 'CREAEDITOR_AGENT_HOST_USER_CUSTOMIZATIONS_DIR';

/** The largest file that is sent. */
export const USER_CUSTOMIZATION_MAX_FILE_BYTES = 1024 * 1024;
/** The most that is sent in all. */
export const USER_CUSTOMIZATION_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export type UserCustomizationAgent = 'claude' | 'copilot' | 'codex';

/** A personal customization file (`relativePath` is relative to the agent's home folder). */
export interface IUserCustomizationFile {
	readonly agent: UserCustomizationAgent;
	readonly relativePath: string;
	/** Base64 content. */
	readonly content: string;
}

/** What `POST delegations/<id>/customizations` carries, sealed (see {@link USER_CUSTOMIZATIONS_SEAL_CONTEXT}). */
export interface IUserCustomizationsPayload {
	readonly files: readonly IUserCustomizationFile[];
}

/** The sealing context of the customizations of `delegationId` (another than the accounts', so one envelope cannot pass for the other). */
export function getUserCustomizationsSealContext(delegationId: string): string {
	return `user-customizations:${delegationId}`;
}

/** The folders and files of each agent's home that are sent. */
const SOURCES: Readonly<Record<UserCustomizationAgent, { readonly folders: readonly string[]; readonly files: readonly string[] }>> = {
	claude: { folders: ['agents', 'skills', 'commands'], files: ['CLAUDE.md'] },
	copilot: { folders: ['agents', 'skills'], files: ['copilot-instructions.md'] },
	codex: { folders: [], files: ['AGENTS.md'] },
};

/** Folders inside agents and skills that are never sent. */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', '__pycache__', '.cache', 'cache', '.venv', 'venv', 'projects', 'sessions', 'todos']);

/** File names that may hold credentials or configuration with secrets. */
const CREDENTIAL_FILE_PATTERNS: readonly RegExp[] = [
	/^settings(\.local)?\.json$/i,
	/^\.credentials/i,
	/^auth\.json$/i,
	/^config\.toml$/i,
	/^\.?mcp(\.json|\.ya?ml|-config\.json)$/i,
	/^mcp[-_]?servers?\.json$/i,
	...CREAEDITOR_DELEGATION_SECRET_FILE_GLOBS.map(glob => globToRegExp(glob.replace(/^\*\*\//, ''))),
];

function globToRegExp(glob: string): RegExp {
	return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
}

/** Whether a file name looks like credentials or a secret (it stays on the laptop). */
export function isCredentialFileName(name: string): boolean {
	return CREDENTIAL_FILE_PATTERNS.some(pattern => pattern.test(name));
}

export interface ICollectUserCustomizationsOptions {
	readonly claudeConfigDir: string;
	readonly copilotHome: string;
	readonly codexHome: string;
	readonly maxFileBytes?: number;
	readonly maxTotalBytes?: number;
}

export interface ICollectedUserCustomizations {
	readonly files: readonly IUserCustomizationFile[];
	/** `<agent>/<path>` of files left out (too large, over the total, credentials). */
	readonly skipped: readonly string[];
}

/** Reads the personal customizations of this machine (see the top of this file). */
export function collectUserCustomizations(options: ICollectUserCustomizationsOptions): ICollectedUserCustomizations {
	const maxFileBytes = options.maxFileBytes ?? USER_CUSTOMIZATION_MAX_FILE_BYTES;
	const maxTotalBytes = options.maxTotalBytes ?? USER_CUSTOMIZATION_MAX_TOTAL_BYTES;
	const homes: Record<UserCustomizationAgent, string> = { claude: options.claudeConfigDir, copilot: options.copilotHome, codex: options.codexHome };
	const files: IUserCustomizationFile[] = [];
	const skipped: string[] = [];
	let total = 0;
	/** Over the total: nothing more goes (rather than a skill without its SKILL.md). */
	let full = false;
	const add = (agent: UserCustomizationAgent, relativePath: string, path: string, size: number) => {
		if (isCredentialFileName(relativePath.split('/').pop() ?? '') || size > maxFileBytes || full) {
			skipped.push(`${agent}/${relativePath}`);
			return;
		}
		if (total + size > maxTotalBytes) {
			full = true;
			skipped.push(`${agent}/${relativePath}`);
			return;
		}
		try {
			const content = fs.readFileSync(path);
			total += content.length;
			files.push({ agent, relativePath, content: content.toString('base64') });
		} catch {
			// Gone or unreadable.
		}
	};
	for (const agent of Object.keys(SOURCES) as UserCustomizationAgent[]) {
		const home = homes[agent];
		for (const name of SOURCES[agent].files) {
			const stat = statOrUndefined(join(home, name));
			if (stat?.isFile()) {
				add(agent, name, join(home, name), stat.size);
			}
		}
		for (const folder of SOURCES[agent].folders) {
			const visited = new Set<string>();
			const walk = (dir: string, relative: string, depth: number) => {
				let real: string;
				try {
					real = fs.realpathSync(dir);
				} catch {
					return;
				}
				if (depth > 8 || visited.has(real)) {
					return;
				}
				visited.add(real);
				let entries: string[];
				try {
					entries = fs.readdirSync(dir).sort();
				} catch {
					return;
				}
				for (const entry of entries) {
					const path = join(dir, entry);
					const relativePath = `${relative}/${entry}`;
					// Followed: skills are often links to a folder elsewhere.
					const stat = statOrUndefined(path);
					if (stat?.isDirectory()) {
						if (!SKIPPED_FOLDERS.has(entry)) {
							walk(path, relativePath, depth + 1);
						}
					} else if (stat?.isFile()) {
						add(agent, relativePath, path, stat.size);
					}
				}
			};
			walk(join(home, folder), folder, 0);
		}
	}
	return { files, skipped };
}

function statOrUndefined(path: string): fs.Stats | undefined {
	try {
		return fs.statSync(path);
	} catch {
		return undefined;
	}
}

/** What the server's agents read of a delegation's personal customizations. */
export interface IDelegatedUserCustomizations {
	/** A Claude Code plugin folder with the agents, skills and commands. */
	readonly claudePluginDir?: string;
	/** The user's `CLAUDE.md`. */
	readonly claudeMemory?: string;
	/** An Open Plugins folder with the Copilot CLI agents and skills. */
	readonly copilotPluginDir?: string;
	/** The user's `copilot-instructions.md`. */
	readonly copilotInstructions?: string;
	/** The user's Codex `AGENTS.md`. */
	readonly codexInstructions?: string;
}

interface IUserCustomizationsManifest {
	readonly delegationId: string;
	/** The delegation's worktree (and its real path): chats working in it use these customizations. */
	readonly worktrees: readonly string[];
	readonly sourceName: string;
	readonly createdAt: number;
}

const MANIFEST_FILE = 'manifest.json';

/** Whether `relativePath` stays inside its folder and is one of the files of {@link SOURCES}. */
function isAllowedRelativePath(agent: UserCustomizationAgent, relativePath: string): boolean {
	const parts = relativePath.split('/');
	if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\')) || relativePath.startsWith('/')) {
		return false;
	}
	const source = SOURCES[agent];
	if (!source) {
		return false;
	}
	return parts.length === 1 ? source.files.includes(parts[0]) : source.folders.includes(parts[0]) && !isCredentialFileName(parts.at(-1)!);
}

/**
 * Writes a delegation's personal customizations on the server (replacing any earlier ones of it):
 * `<root>/<delegationId>/{claude,copilot,codex}/...` with the plugin manifests and a manifest of the
 * worktrees that use them. Returns how many files it wrote.
 */
export function installUserCustomizations(root: string, delegationId: string, worktrees: readonly string[], sourceName: string, files: readonly IUserCustomizationFile[], now = Date.now()): number {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(delegationId)) {
		throw new Error('Invalid delegation id.');
	}
	const dir = join(root, delegationId);
	const temp = `${dir}.tmp`;
	fs.rmSync(temp, { recursive: true, force: true });
	fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
	let written = 0;
	let total = 0;
	const agents = new Set<UserCustomizationAgent>();
	for (const file of files) {
		if ((file.agent !== 'claude' && file.agent !== 'copilot' && file.agent !== 'codex') || typeof file.relativePath !== 'string' || typeof file.content !== 'string' || !isAllowedRelativePath(file.agent, file.relativePath)) {
			continue;
		}
		const content = Buffer.from(file.content, 'base64');
		if (content.length > USER_CUSTOMIZATION_MAX_FILE_BYTES || total + content.length > USER_CUSTOMIZATION_MAX_TOTAL_BYTES) {
			continue;
		}
		total += content.length;
		const target = join(temp, file.agent, ...file.relativePath.split('/'));
		fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		fs.writeFileSync(target, content, { mode: 0o600 });
		agents.add(file.agent);
		written++;
	}
	const pluginDescription = `Personal agents, skills and instructions from ${sourceName}`;
	if (agents.has('claude')) {
		fs.mkdirSync(join(temp, 'claude', '.claude-plugin'), { recursive: true, mode: 0o700 });
		fs.writeFileSync(join(temp, 'claude', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'personal', description: pluginDescription }, undefined, '\t'), { mode: 0o600 });
	}
	if (agents.has('copilot')) {
		fs.mkdirSync(join(temp, 'copilot', '.plugin'), { recursive: true, mode: 0o700 });
		fs.writeFileSync(join(temp, 'copilot', '.plugin', 'plugin.json'), JSON.stringify({ name: 'personal', description: pluginDescription }, undefined, '\t'), { mode: 0o600 });
	}
	const manifest: IUserCustomizationsManifest = { delegationId, worktrees: [...worktrees], sourceName, createdAt: now };
	fs.writeFileSync(join(temp, MANIFEST_FILE), JSON.stringify(manifest, undefined, '\t'), { mode: 0o600 });
	fs.rmSync(dir, { recursive: true, force: true });
	fs.renameSync(temp, dir);
	return written;
}

/** Removes a delegation's personal customizations on the server. */
export function removeUserCustomizations(root: string, delegationId: string): void {
	if (/^[A-Za-z0-9_-]{1,64}$/.test(delegationId)) {
		fs.rmSync(join(root, delegationId), { recursive: true, force: true });
	}
}

function readText(path: string): string | undefined {
	try {
		const text = fs.readFileSync(path, 'utf8').trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

function hasPlugin(dir: string, manifest: string): boolean {
	return fs.existsSync(join(dir, manifest));
}

/**
 * The personal customizations a chat on this server uses: those of the delegation whose worktree its
 * working directory is in; undefined outside a CreaEditor Server and for other chats.
 */
export function findDelegatedUserCustomizations(workingDirectory: string | undefined, env: NodeJS.ProcessEnv = process.env): IDelegatedUserCustomizations | undefined {
	const root = env[AGENT_HOST_USER_CUSTOMIZATIONS_DIR_ENV_VAR];
	if (!root || !workingDirectory) {
		return undefined;
	}
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const dir = join(root, entry);
		let manifest: IUserCustomizationsManifest;
		try {
			manifest = JSON.parse(fs.readFileSync(join(dir, MANIFEST_FILE), 'utf8')) as IUserCustomizationsManifest;
		} catch {
			continue;
		}
		if (!Array.isArray(manifest?.worktrees) || !manifest.worktrees.some(worktree => typeof worktree === 'string' && isEqualOrParent(workingDirectory, worktree))) {
			continue;
		}
		const claudePluginDir = join(dir, 'claude');
		const copilotPluginDir = join(dir, 'copilot');
		const claudeMemory = readText(join(claudePluginDir, 'CLAUDE.md'));
		const copilotInstructions = readText(join(copilotPluginDir, 'copilot-instructions.md'));
		const codexInstructions = readText(join(dir, 'codex', 'AGENTS.md'));
		return {
			...(hasPlugin(claudePluginDir, join('.claude-plugin', 'plugin.json')) && ['agents', 'skills', 'commands'].some(folder => fs.existsSync(join(claudePluginDir, folder))) ? { claudePluginDir } : {}),
			...(claudeMemory ? { claudeMemory } : {}),
			...(hasPlugin(copilotPluginDir, join('.plugin', 'plugin.json')) && ['agents', 'skills'].some(folder => fs.existsSync(join(copilotPluginDir, folder))) ? { copilotPluginDir } : {}),
			...(copilotInstructions ? { copilotInstructions } : {}),
			...(codexInstructions ? { codexInstructions } : {}),
		};
	}
	return undefined;
}

/** How the user's memory or instructions read at the end of a system prompt. */
export function formatDelegatedUserInstructions(text: string): string {
	return `# The user's personal instructions\n\n${text}`;
}
