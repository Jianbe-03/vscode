/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as os from 'os';
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { IFileSystemService } from '../../filesystem/common/fileSystemService';
import { FileType } from '../../filesystem/common/fileTypes';
import { IGitService } from '../../git/common/gitService';
import { ILogService } from '../../log/common/logService';
import { RunOnceScheduler, Sequencer } from '../../../util/vs/base/common/async';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { URI } from '../../../util/vs/base/common/uri';
import { BACKGROUND_CHAT_ID, detectIssueFromBranch, detectPromptIssue, IChatIssue, IChatWorkContext, IChatWorkLocation, isJiraIssue, repoFromRemoteUrl } from '../common/gatewayTracking';
import { GatewayCostEntryUpdate, getServerCostsFolderPath, IGatewayCostEntry, IGatewayTrackingService, parseServerCostsFile } from '../common/gatewayTrackingService';

const LEDGER_FILE = 'creaeditor-gateway-costs.jsonl';
/** When the ledger was last cleared, so every window drops the entries up to then. */
const CLEARED_FILE = 'creaeditor-gateway-costs-cleared.json';
/** Oldest entries are dropped beyond this many, to bound memory and file size. */
const MAX_ENTRIES = 50_000;
const MAX_TITLE_LENGTH = 120;

interface IChatState {
	title?: string;
	promptIssue?: IChatIssue;
	agentIssue?: IChatIssue;
	/** Set once an explicit `undefined` override cleared detection for this chat. */
	cleared?: boolean;
}

/**
 * CreaEditor: tracks the chat/issue context of gateway requests and persists their cost in
 * `<globalStorage>/creaeditor-gateway-costs.jsonl`. The ledger is shared with the copies of this
 * extension in other windows (see {@link GatewayTrackingService._sync}).
 */
export class GatewayTrackingService extends Disposable implements IGatewayTrackingService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	/** Every window's requests in the ledger, oldest first. */
	private _entries: IGatewayCostEntry[] = [];
	/** The requests this window recorded, in their latest version; written to the ledger when it lacks them. */
	private readonly _own = new Map<string, IGatewayCostEntry>();
	/** The ledger content last read or written, to skip a reload that brings nothing new. */
	private _lastContent: string | undefined;
	private _clearedAt = 0;
	/** Requests pulled from CreaEditor Servers, tagged with the server as `source`. */
	private _serverEntries: IGatewayCostEntry[] = [];
	private _merged: IGatewayCostEntry[] | undefined;
	private readonly _serverCostsScheduler = this._register(new RunOnceScheduler(() => this._loadServerCosts(), 500));
	private readonly _chats = new Map<string, IChatState>();
	/** One read-merge-write of the ledger at a time in this window. */
	private readonly _syncSequencer = new Sequencer();
	private readonly _saveScheduler = this._register(new RunOnceScheduler(() => this._queueSync(), 1000));
	private readonly _reloadScheduler = this._register(new RunOnceScheduler(() => this._queueSync(), 300));
	private readonly _user = getUserName();
	private readonly _backgroundTitle = l10n.t('Background requests (titles, summaries, commit messages)');

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IGitService private readonly _gitService: IGitService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._watchLedger();
		this._queueSync();
		this._watchServerCosts();
	}

	/** This computer's requests and the ones pulled from CreaEditor Servers, oldest first. */
	get entries(): readonly IGatewayCostEntry[] {
		if (!this._serverEntries.length) {
			return this._entries;
		}
		if (!this._merged) {
			// A request this computer made can also come back from a server's ledger.
			const local = new Set(this._entries.map(entry => entry.id));
			this._merged = [...this._entries, ...this._serverEntries.filter(entry => !local.has(entry.id))].sort((a, b) => a.time - b.time);
		}
		return this._merged;
	}

	getWorkContext(chatId: string, rootChatId: string, promptText: string | undefined, location?: IChatWorkLocation): IChatWorkContext {
		const root = this._getChat(rootChatId);
		const chat = chatId === rootChatId ? root : this._getChat(chatId);
		if (rootChatId === BACKGROUND_CHAT_ID) {
			root.title = this._backgroundTitle;
		} else if (!root.title && chatId === rootChatId && promptText?.trim()) {
			const firstLine = promptText.trim().split(/\r?\n/)[0];
			root.title = firstLine.length > MAX_TITLE_LENGTH ? firstLine.slice(0, MAX_TITLE_LENGTH - 1) + '…' : firstLine;
		}
		if (!root.promptIssue && !root.cleared && rootChatId !== BACKGROUND_CHAT_ID) {
			root.promptIssue = detectPromptIssue(promptText);
		}

		// An Agents window chat (a Director's worker in its own worktree) says where it works; other chats
		// work in this window's active repository.
		const repository = location ? undefined : this._gitService.activeRepository.get();
		const branch = location ? location.branch : repository?.headBranchName;
		const repo = location ? location.repo : repoFromRemoteUrl(repository?.remoteFetchUrls?.find(url => !!url));

		let issue: IChatIssue | undefined;
		let issueSource: IChatWorkContext['issueSource'];
		const agentIssue = chat.agentIssue ?? root.agentIssue;
		if (agentIssue) {
			issue = agentIssue;
			issueSource = 'agent';
		} else if (root.promptIssue) {
			issue = root.promptIssue;
			issueSource = 'prompt';
		} else if (!root.cleared) {
			issue = detectIssueFromBranch(branch);
			issueSource = issue ? 'branch' : undefined;
		}

		return {
			chatId,
			rootChatId,
			chatTitle: root.title,
			issue: issue && !isJiraIssue(issue) && !issue.repo && repo ? { ...issue, repo } : issue,
			issueSource,
			repo,
			branch,
			user: this._user,
		};
	}

	setIssue(chatId: string, issue: IChatIssue | undefined): void {
		const chat = this._getChat(chatId);
		chat.agentIssue = issue;
		chat.cleared = issue === undefined;
		if (issue === undefined) {
			chat.promptIssue = undefined;
		}
	}

	recordRequest(entry: Omit<IGatewayCostEntry, 'id' | 'time'>): string {
		const id = generateUuid();
		const recorded: IGatewayCostEntry = { ...entry, id, time: Date.now() };
		this._entries.push(recorded);
		this._own.set(id, recorded);
		if (this._entries.length > MAX_ENTRIES) {
			this._entries.splice(0, this._entries.length - MAX_ENTRIES);
		}
		this._changed();
		return id;
	}

	updateRequest(id: string, update: GatewayCostEntryUpdate): void {
		const index = this._entries.findIndex(entry => entry.id === id);
		if (index === -1) {
			return;
		}
		const defined = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
		const updated = { ...this._entries[index], ...defined };
		this._entries[index] = updated;
		this._own.set(id, updated);
		this._changed();
	}

	clear(): void {
		// Every window drops what was recorded up to now: the marker tells the others (and a window that
		// saves an older copy afterwards) that those entries are gone.
		this._clearedAt = Date.now();
		this._entries = [];
		this._own.clear();
		this._merged = undefined;
		this._onDidChangeEntries.fire();
		this._saveScheduler.cancel();
		this._syncSequencer.queue(() => this._writeClear()).catch(error => this._logService.warn(`[GatewayTracking] Could not clear the cost ledger: ${error}`));
	}

	private _getChat(chatId: string): IChatState {
		let chat = this._chats.get(chatId);
		if (!chat) {
			chat = {};
			this._chats.set(chatId, chat);
		}
		return chat;
	}

	private _changed(): void {
		this._merged = undefined;
		this._onDidChangeEntries.fire();
		this._saveScheduler.schedule();
	}

	private get _ledgerUri(): URI | undefined {
		const storage = this._extensionContext.globalStorageUri;
		return storage ? URI.joinPath(storage, LEDGER_FILE) : undefined;
	}

	private _queueSync(): void {
		this._syncSequencer.queue(() => this._sync()).catch(error => this._logService.warn(`[GatewayTracking] Could not sync the cost ledger: ${error}`));
	}

	private get _clearedUri(): URI | undefined {
		const storage = this._extensionContext.globalStorageUri;
		return storage ? URI.joinPath(storage, CLEARED_FILE) : undefined;
	}

	/** Every window's copy of this extension writes the same ledger: merges what the others write. */
	private _watchLedger(): void {
		const storage = this._extensionContext.globalStorageUri;
		if (!storage) {
			return;
		}
		try {
			const watcher = this._register(this._fileSystemService.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse(storage.toString()), `{${LEDGER_FILE},${CLEARED_FILE}}`)));
			this._register(watcher.onDidCreate(() => this._reloadScheduler.schedule()));
			this._register(watcher.onDidChange(() => this._reloadScheduler.schedule()));
			this._register(watcher.onDidDelete(() => this._reloadScheduler.schedule()));
		} catch (error) {
			this._logService.warn(`[GatewayTracking] Cannot watch the cost ledger: ${error}`);
		}
	}

	/**
	 * Merges the ledger file with this window's own entries and writes the result back when the file
	 * lacks any of them (or has an older version of one).
	 *
	 * Every window's copy of this extension shares the ledger, so the file is the truth for the others'
	 * entries and this window is the truth for its own (only the window that recorded a request updates
	 * it, so its version is the newest). Lines are "last line per id wins", like `parseLedgerLines` in
	 * `creaeditorServerCosts.ts`. A write goes to a temporary file that is renamed over the ledger, so a
	 * reader never sees half a file. Two windows saving at the same moment can still overwrite each
	 * other's write; the loser's watcher then reloads, finds its own entries missing and writes them
	 * again, so the ledger converges on the union. Entries up to the time of the last Clear are dropped
	 * whichever window still had them.
	 */
	private async _sync(): Promise<void> {
		const uri = this._ledgerUri;
		if (!uri) {
			return;
		}
		const clearedAt = await this._readClearedAt();
		if (clearedAt > this._clearedAt) {
			this._clearedAt = clearedAt;
		}
		let content: string | undefined;
		try {
			content = new TextDecoder().decode(await this._fileSystemService.readFile(uri, true));
		} catch {
			// No ledger yet.
		}
		const byId = new Map<string, IGatewayCostEntry>();
		let rewrite = false;
		for (const entry of parseLedger(content ?? '')) {
			if (entry.time <= this._clearedAt) {
				rewrite = true; // Written by a window that had not seen the Clear yet.
				continue;
			}
			byId.delete(entry.id); // The last line of an id wins, at its position.
			byId.set(entry.id, entry);
		}
		for (const [id, own] of this._own) {
			if (own.time <= this._clearedAt) {
				this._own.delete(id);
				continue;
			}
			const onDisk = byId.get(id);
			if (!onDisk || JSON.stringify(onDisk) !== JSON.stringify(own)) {
				byId.set(id, own);
				rewrite = true;
			}
		}
		let merged = [...byId.values()].sort((a, b) => a.time - b.time);
		if (merged.length > MAX_ENTRIES) {
			for (const dropped of merged.splice(0, merged.length - MAX_ENTRIES)) {
				this._own.delete(dropped.id);
			}
			rewrite = true;
		}
		if (rewrite) {
			content = await this._write(uri, merged) ?? content;
			// Requests recorded or updated while writing are saved by the next sync.
			const ids = new Set(merged.map(entry => entry.id));
			merged = merged.map(entry => this._own.get(entry.id) ?? entry);
			const added = [...this._own.values()].filter(entry => !ids.has(entry.id));
			if (added.length) {
				merged = [...merged, ...added].sort((a, b) => a.time - b.time);
			}
		} else if (content === this._lastContent && merged.length === this._entries.length) {
			return; // Nothing new on either side (e.g. the watcher reporting this window's own write).
		}
		this._lastContent = content;
		this._entries = merged;
		this._merged = undefined;
		this._onDidChangeEntries.fire();
	}

	/** Replaces the ledger with `entries`; returns the written content, or undefined when it failed. */
	private async _write(uri: URI, entries: readonly IGatewayCostEntry[]): Promise<string | undefined> {
		const folder = URI.joinPath(uri, '..');
		try {
			await this._fileSystemService.createDirectory(folder);
		} catch {
			// Already exists.
		}
		const content = entries.length ? entries.map(entry => JSON.stringify(entry)).join('\n') + '\n' : '';
		// Not matched by the ledger watcher, so the other windows only see the finished file.
		const temp = URI.joinPath(folder, `.${LEDGER_FILE}.${generateUuid()}.tmp`);
		try {
			await this._fileSystemService.writeFile(temp, new TextEncoder().encode(content));
			await this._fileSystemService.rename(temp, uri, { overwrite: true });
			return content;
		} catch (error) {
			this._logService.warn(`[GatewayTracking] Could not save the cost ledger: ${error}`);
			await this._fileSystemService.delete(temp).catch(() => undefined);
			return undefined;
		}
	}

	private async _writeClear(): Promise<void> {
		const uri = this._ledgerUri;
		const clearedUri = this._clearedUri;
		if (!uri || !clearedUri) {
			return;
		}
		// The marker first: a window that syncs in between then drops its old entries instead of writing them back.
		try {
			await this._fileSystemService.writeFile(clearedUri, new TextEncoder().encode(JSON.stringify({ clearedAt: this._clearedAt })));
		} catch (error) {
			this._logService.warn(`[GatewayTracking] Could not clear the cost ledger: ${error}`);
		}
		await this._write(uri, []);
		await this._sync();
	}

	/** When the ledger was last cleared (in any window), epoch milliseconds; 0 when never. */
	private async _readClearedAt(): Promise<number> {
		const uri = this._clearedUri;
		if (!uri) {
			return 0;
		}
		try {
			const value: unknown = JSON.parse(new TextDecoder().decode(await this._fileSystemService.readFile(uri, true)));
			const clearedAt = value && typeof value === 'object' && 'clearedAt' in value ? value.clearedAt : undefined;
			return typeof clearedAt === 'number' ? clearedAt : 0;
		} catch {
			return 0;
		}
	}

	private get _serverCostsUri(): URI | undefined {
		// The default profile's, read by every window whatever its profile (see getServerCostsFolderPath).
		const storage = this._extensionContext.globalStorageUri;
		return storage ? URI.from({ scheme: storage.scheme, authority: storage.authority, path: getServerCostsFolderPath(storage.path) }) : undefined;
	}

	private _watchServerCosts(): void {
		const folder = this._serverCostsUri;
		if (!folder) {
			return;
		}
		try {
			const watcher = this._register(this._fileSystemService.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.parse(folder.toString()), '*.json')));
			this._register(watcher.onDidCreate(() => this._serverCostsScheduler.schedule()));
			this._register(watcher.onDidChange(() => this._serverCostsScheduler.schedule()));
			this._register(watcher.onDidDelete(() => this._serverCostsScheduler.schedule()));
		} catch (error) {
			this._logService.warn(`[GatewayTracking] Cannot watch the costs of CreaEditor Servers: ${error}`);
		}
		this._serverCostsScheduler.schedule();
	}

	/** Reads the costs pulled from CreaEditor Servers (latest version of each id wins). */
	private async _loadServerCosts(): Promise<void> {
		const folder = this._serverCostsUri;
		if (!folder) {
			return;
		}
		const byId = new Map<string, IGatewayCostEntry>();
		let files: [string, FileType][] = [];
		try {
			files = await this._fileSystemService.readDirectory(folder);
		} catch {
			// No server costs yet.
		}
		for (const [name, type] of files) {
			if (type !== FileType.File || !name.endsWith('.json')) {
				continue;
			}
			try {
				const content = new TextDecoder().decode(await this._fileSystemService.readFile(URI.joinPath(folder, name), true));
				for (const entry of parseServerCostsFile(content)) {
					byId.set(entry.id, entry);
				}
			} catch {
				// Being written; the watcher fires again.
			}
		}
		this._serverEntries = [...byId.values()];
		this._merged = undefined;
		this._onDidChangeEntries.fire();
	}
}

function getUserName(): string | undefined {
	try {
		return os.userInfo().username;
	} catch {
		return undefined;
	}
}

/** The entries of a ledger, in file order; a corrupt line is skipped rather than losing the ledger. */
function parseLedger(content: string): IGatewayCostEntry[] {
	const entries: IGatewayCostEntry[] = [];
	for (const line of content.split('\n')) {
		if (line.trim()) {
			try {
				entries.push(JSON.parse(line));
			} catch {
				// Skip.
			}
		}
	}
	return entries;
}
