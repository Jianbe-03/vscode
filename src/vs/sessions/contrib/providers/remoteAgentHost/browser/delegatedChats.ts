/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the chats this machine delegated to a CreaEditor Server (Delegate to Server), kept in
// application storage so every window knows which local chat continues where.

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { toAgentHostUri } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { DelegationResultsMode } from '../../../../../platform/agentHost/common/creaeditorDelegation.js';
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
