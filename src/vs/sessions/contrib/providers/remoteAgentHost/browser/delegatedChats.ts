/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the chats this machine delegated to a CreaEditor Server (Delegate to Server), kept in
// application storage so every window knows which local chat continues where.

import { fromNow } from '../../../../../base/common/date.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { toAgentHostUri } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { DelegationChatState, DelegationResultsMode, IDelegationWorktreeInfo } from '../../../../../platform/agentHost/common/creaeditorDelegation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { SessionStatus } from '../../../../services/sessions/common/session.js';

export const DELEGATED_CHATS_STORAGE_KEY = 'creaeditor.delegatedChats';

/** A chat that continues on a server. */
export interface IDelegatedChat {
	readonly delegationId: string;
	readonly shortId: string;
	readonly serverId: string;
	readonly serverName: string;
	readonly title: string;
	/** The chat's session on this machine (archived once delegated). */
	readonly localSessionResource?: string;
	/** The chat's session on the server, once it exists there. */
	readonly remoteSessionResource?: string;
	/** The chat's folder here. */
	readonly folder: string;
	/** The chat's worktree on the server. */
	readonly worktree?: string;
	/** The server's folder of delegated repositories, as the server reports it (older servers do not). */
	readonly repositoriesDir?: string;
	/** The commit the server's branch started from (it is in this repository). */
	readonly baseCommit: string;
	/** The server's branch (`creaeditor/delegated/<shortId>`). */
	readonly branch: string;
	readonly resultsMode: DelegationResultsMode;
	readonly createdAt: number;
	/** The conversation went along as a transcript (the agent's session could not move). */
	readonly transcriptOnly?: boolean;
	/** The local branch of the last Bring Back Changes. */
	readonly broughtBackBranch?: string;
	readonly pullRequestUrl?: string;
	/** The chat started on the server with its first message (Start on Server...): no local turn ran. */
	readonly startedOnServer?: boolean;
}

/** Reads the stored list, skipping anything malformed. */
/**
 * The workspace trust keys of folders on a server (absolute paths there) whose code came from this
 * computer's delegations. Trust is checked in two forms, so both are returned for each folder:
 * - the agent host URI (`vscode-agent-host://<authority>/file/...`): what the Agents window checks when
 *   it opens a session, and what is sent to the server as its trusted folders;
 * - the folder as the server reports it in a session's working directories (`file:///...`): what the
 *   chat checks before the first message of an existing session (it reads the session state as is).
 */
export function getServerFolderTrustUris(authority: string, folders: readonly (string | undefined)[]): URI[] {
	return folders.filter((folder): folder is string => !!folder).flatMap(folder => [toAgentHostUri(URI.file(folder), authority), URI.file(folder)]);
}

export function parseDelegatedChats(raw: string | undefined): IDelegatedChat[] {
	if (!raw) {
		return [];
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is IDelegatedChat => !!entry && typeof entry === 'object'
		&& typeof entry.delegationId === 'string' && typeof entry.shortId === 'string' && typeof entry.serverId === 'string'
		&& typeof entry.serverName === 'string' && typeof entry.folder === 'string' && typeof entry.baseCommit === 'string'
		&& typeof entry.branch === 'string' && typeof entry.createdAt === 'number'
		&& (entry.resultsMode === DelegationResultsMode.BringBack || entry.resultsMode === DelegationResultsMode.PullRequest));
}

/** How a delegated chat's state reads in lists. */
export function describeDelegatedChatState(status: SessionStatus | undefined, connected: boolean): string {
	if (!connected) {
		return localize('delegatedChat.offline', "server offline");
	}
	switch (status) {
		case SessionStatus.InProgress: return localize('delegatedChat.running', "running");
		case SessionStatus.NeedsInput: return localize('delegatedChat.waiting', "waiting for approval");
		case SessionStatus.Completed: return localize('delegatedChat.done', "done");
		case SessionStatus.Error: return localize('delegatedChat.error', "stopped with an error");
		default: return localize('delegatedChat.starting', "starting");
	}
}

/** The title of a chat that starts on a server with `message` (Start on Server...): its first line, shortened. */
export function titleFromFirstMessage(message: string): string {
	const line = message.split(/\r?\n/).find(candidate => candidate.trim())?.trim() ?? '';
	return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/** How a server's worktree of a delegated chat reads in Clean Up Server... */
export function describeServerWorktree(info: IDelegationWorktreeInfo, now: number): { readonly label: string; readonly description: string; readonly detail: string } {
	let state: string;
	switch (info.chatState) {
		case DelegationChatState.Running: state = localize('serverWorktree.running', "chat in use"); break;
		case DelegationChatState.Archived: state = !info.archivedSince
			? localize('serverWorktree.archived', "chat archived")
			: now - info.archivedSince < 60_000
				? localize('serverWorktree.archivedJustNow', "chat archived just now")
				: localize('serverWorktree.archivedSince', "chat archived {0}", fromNow(info.archivedSince, true)); break;
		case DelegationChatState.Deleted: state = localize('serverWorktree.deleted', "no chat on the server"); break;
		default: state = localize('serverWorktree.unknown', "chat state unknown"); break;
	}
	const size = info.bytes === undefined
		? undefined
		: info.bytes < 100 * 1024
			? localize('serverWorktree.sizeSmall', "under 0.1 MB")
			: localize('serverWorktree.size', "{0} MB", (info.bytes / (1024 * 1024)).toFixed(info.bytes < 10 * 1024 * 1024 ? 1 : 0));
	const work = info.pullRequestUrl && info.workSafe
		? localize('serverWorktree.pushed', "work is in its pull request")
		: info.broughtBackAt && info.workSafe
			? localize('serverWorktree.broughtBack', "work brought back {0}", fromNow(info.broughtBackAt, true))
			: info.workSafe
				? localize('serverWorktree.unchanged', "no changes on the server")
				: localize('serverWorktree.notBroughtBack', "work NOT brought back");
	const removal = info.removeAfter === undefined
		? localize('serverWorktree.kept', "kept until removed by hand")
		: info.removeAfter <= now
			? localize('serverWorktree.removedSoon', "the server removes it at its next cleanup")
			: localize('serverWorktree.removedOn', "the server removes it on {0}", new Date(info.removeAfter).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
	const folder = info.worktree.split(/[\\/]/).pop() ?? info.worktree;
	return {
		label: info.title,
		description: [size, state].filter(Boolean).join(' · '),
		detail: [folder, localize('serverWorktree.from', "from {0}", info.sourceName), work, removal].join(' · '),
	};
}

/** The delegated chats of this machine. */
export class DelegatedChatsStore extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _chats: IDelegatedChat[];

	constructor(@IStorageService private readonly _storageService: IStorageService) {
		super();
		this._chats = parseDelegatedChats(this._storageService.get(DELEGATED_CHATS_STORAGE_KEY, StorageScope.APPLICATION));
		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, DELEGATED_CHATS_STORAGE_KEY, this._store)(() => {
			this._chats = parseDelegatedChats(this._storageService.get(DELEGATED_CHATS_STORAGE_KEY, StorageScope.APPLICATION));
			this._onDidChange.fire();
		}));
	}

	get chats(): readonly IDelegatedChat[] {
		return this._chats;
	}

	/** The delegated chat of a session resource (the local one or the one on the server). */
	find(sessionResource: string): IDelegatedChat | undefined {
		return this._chats.find(chat => chat.localSessionResource === sessionResource || chat.remoteSessionResource === sessionResource);
	}

	get(delegationId: string): IDelegatedChat | undefined {
		return this._chats.find(chat => chat.delegationId === delegationId);
	}

	upsert(chat: IDelegatedChat): void {
		this._write([...this._chats.filter(existing => existing.delegationId !== chat.delegationId), chat]);
	}

	update(delegationId: string, change: Partial<IDelegatedChat>): IDelegatedChat | undefined {
		const existing = this.get(delegationId);
		if (!existing) {
			return undefined;
		}
		const updated = { ...existing, ...change };
		this.upsert(updated);
		return updated;
	}

	remove(delegationId: string): void {
		this._write(this._chats.filter(chat => chat.delegationId !== delegationId));
	}

	private _write(chats: IDelegatedChat[]): void {
		this._chats = chats;
		if (chats.length) {
			this._storageService.store(DELEGATED_CHATS_STORAGE_KEY, JSON.stringify(chats), StorageScope.APPLICATION, StorageTarget.MACHINE);
		} else {
			this._storageService.remove(DELEGATED_CHATS_STORAGE_KEY, StorageScope.APPLICATION);
		}
		this._onDidChange.fire();
	}
}
