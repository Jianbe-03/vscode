/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as os from 'os';
import { IVSCodeExtensionContext } from '../../extContext/common/extensionContext';
import { IFileSystemService } from '../../filesystem/common/fileSystemService';
import { IGitService } from '../../git/common/gitService';
import { ILogService } from '../../log/common/logService';
import { RunOnceScheduler } from '../../../util/vs/base/common/async';
import { Emitter } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { URI } from '../../../util/vs/base/common/uri';
import { BACKGROUND_CHAT_ID, detectIssueFromBranch, detectIssueFromText, IChatIssue, IChatWorkContext, repoFromRemoteUrl } from '../common/gatewayTracking';
import { GatewayCostEntryUpdate, IGatewayCostEntry, IGatewayTrackingService } from '../common/gatewayTrackingService';

const LEDGER_FILE = 'creaeditor-gateway-costs.jsonl';
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
 * `<globalStorage>/creaeditor-gateway-costs.jsonl`.
 */
export class GatewayTrackingService extends Disposable implements IGatewayTrackingService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	private _entries: IGatewayCostEntry[] = [];
	private readonly _chats = new Map<string, IChatState>();
	private readonly _loaded: Promise<void>;
	private readonly _saveScheduler = this._register(new RunOnceScheduler(() => this._save(), 1000));
	private readonly _user = getUserName();
	private readonly _backgroundTitle = l10n.t('Background requests (titles, summaries, commit messages)');

	constructor(
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
		@IFileSystemService private readonly _fileSystemService: IFileSystemService,
		@IGitService private readonly _gitService: IGitService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._loaded = this._load();
	}

	get entries(): readonly IGatewayCostEntry[] {
		return this._entries;
	}

	getWorkContext(chatId: string, rootChatId: string, promptText: string | undefined): IChatWorkContext {
		const root = this._getChat(rootChatId);
		const chat = chatId === rootChatId ? root : this._getChat(chatId);
		if (rootChatId === BACKGROUND_CHAT_ID) {
			root.title = this._backgroundTitle;
		} else if (!root.title && chatId === rootChatId && promptText?.trim()) {
			const firstLine = promptText.trim().split(/\r?\n/)[0];
			root.title = firstLine.length > MAX_TITLE_LENGTH ? firstLine.slice(0, MAX_TITLE_LENGTH - 1) + '…' : firstLine;
		}
		if (!root.promptIssue && !root.cleared && rootChatId !== BACKGROUND_CHAT_ID) {
			root.promptIssue = detectIssueFromText(promptText);
		}

		const repository = this._gitService.activeRepository.get();
		const branch = repository?.headBranchName;
		const repo = repoFromRemoteUrl(repository?.remoteFetchUrls?.find(url => !!url));

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
			const branchIssue = detectIssueFromBranch(branch);
			if (branchIssue) {
				issue = { number: branchIssue };
				issueSource = 'branch';
			}
		}

		return {
			chatId,
			rootChatId,
			chatTitle: root.title,
			issue: issue && !issue.repo && repo ? { ...issue, repo } : issue,
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
		this._entries.push({ ...entry, id, time: Date.now() });
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
		this._entries[index] = { ...this._entries[index], ...defined };
		this._changed();
	}

	clear(): void {
		this._entries = [];
		this._changed();
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
		this._onDidChangeEntries.fire();
		this._saveScheduler.schedule();
	}

	private get _ledgerUri(): URI | undefined {
		const storage = this._extensionContext.globalStorageUri;
		return storage ? URI.joinPath(storage, LEDGER_FILE) : undefined;
	}

	private async _load(): Promise<void> {
		const uri = this._ledgerUri;
		if (!uri) {
			return;
		}
		try {
			const content = new TextDecoder().decode(await this._fileSystemService.readFile(uri, true));
			const loaded: IGatewayCostEntry[] = [];
			for (const line of content.split('\n')) {
				if (line.trim()) {
					try {
						loaded.push(JSON.parse(line));
					} catch {
						// Skip a corrupt line rather than losing the ledger.
					}
				}
			}
			// Entries recorded before loading finished come after the persisted ones.
			this._entries = [...loaded, ...this._entries].slice(-MAX_ENTRIES);
			this._onDidChangeEntries.fire();
		} catch {
			// No ledger yet.
		}
	}

	private async _save(): Promise<void> {
		const uri = this._ledgerUri;
		if (!uri) {
			return;
		}
		await this._loaded;
		try {
			await this._fileSystemService.createDirectory(URI.joinPath(uri, '..'));
		} catch {
			// Already exists.
		}
		try {
			const content = this._entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
			await this._fileSystemService.writeFile(uri, new TextEncoder().encode(content));
		} catch (error) {
			this._logService.warn(`[GatewayTracking] Could not save the cost ledger: ${error}`);
		}
	}
}

function getUserName(): string | undefined {
	try {
		return os.userInfo().username;
	} catch {
		return undefined;
	}
}
