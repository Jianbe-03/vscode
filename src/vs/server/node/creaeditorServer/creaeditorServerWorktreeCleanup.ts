/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the CreaEditor Server removes the worktrees of delegated chats it no longer needs
// (`<data>/worktrees/<repo>-<shortId>`, its branch `creaeditor/delegated/<shortId>`, its base ref and its
// delegation record). Chats started on the server itself in a delegated repository use the agent
// host's own worktree isolation (`<bare>.worktrees/`) and its own archive cleanup; this leaves them alone.
//
// - The user deletes the server's chat of a delegation: removed at once.
// - The server's chat is archived (Take Back Here archives it; the server archives idle chats): removed
//   7 days later, but only while its work is safe, see {@link isDelegationWorkSafe}. Unarchived again:
//   it stays.
// - No chat on the server works in the worktree (its chat data is gone): removed 30 days after it was
//   delegated, again only while its work is safe.
//
// A sweep runs when the agent host starts and every few hours; Clean Up Server... on a laptop removes
// worktrees by hand (`DELETE delegations/<id>?force=1`).

import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { isEqualOrParent } from '../../../base/common/extpath.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { DelegationChatState, getDelegationAgentProvider, IDelegationRecord } from '../../../platform/agentHost/common/creaeditorDelegation.js';
import { ICreaEditorServerSessionsSource, IServerChatSession } from './creaeditorServerSessions.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an archived delegated chat's worktree stays (while its work is safe). */
export const ARCHIVED_DELEGATION_KEEP_MS = 7 * DAY_MS;
/** How long a delegated chat's worktree stays when no chat on the server works in it (while its work is safe). */
export const ORPHANED_DELEGATION_KEEP_MS = 30 * DAY_MS;
/** How often the sweep runs. */
export const DELEGATION_CLEANUP_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** How long after the agent host (re)started the first sweep runs, so its chat list is complete. */
const START_DELAY_MS = 60_000;

/**
 * The chats of the agent host that belong to a delegated chat: the session its files were installed
 * as, and every chat working in its worktree (the one started with a transcript, and new chats the
 * user started right in that folder). `worktreePaths` are the worktree's path and its real path.
 */
export function findDelegationChats(record: Pick<IDelegationRecord, 'agent' | 'resumeSessionId'>, worktreePaths: readonly string[], sessions: readonly IServerChatSession[]): IServerChatSession[] {
	const provider = getDelegationAgentProvider(record.agent);
	return sessions.filter(session => {
		if (record.resumeSessionId && provider) {
			try {
				const uri = URI.parse(session.resource);
				if (uri.scheme === provider && uri.path === `/${record.resumeSessionId}`) {
					return true;
				}
			} catch {
				// Not a URI.
			}
		}
		return session.workingDirectories.some(directory => worktreePaths.some(worktree => isEqualOrParent(directory, worktree)));
	});
}

/** The state of a delegated chat from its chats on the server; Unknown when the server could not list them. */
export function getDelegationChatState(chats: readonly IServerChatSession[] | undefined): DelegationChatState {
	if (!chats) {
		return DelegationChatState.Unknown;
	}
	if (!chats.length) {
		return DelegationChatState.Deleted;
	}
	return chats.every(chat => chat.archived) ? DelegationChatState.Archived : DelegationChatState.Running;
}

/**
 * Whether removing the worktree loses no work: its current state (`currentTree`, uncommitted changes
 * and untracked files included) is still what it was when the chat arrived, or what Bring Back Changes
 * last fetched, or what Open PR from the Server last pushed. Undefined `currentTree` (no worktree and
 * no branch left) has nothing to lose.
 */
export function isDelegationWorkSafe(record: Pick<IDelegationRecord, 'initialTree' | 'broughtBackTree' | 'pushedTree'>, currentTree: string | undefined): boolean {
	if (currentTree === undefined) {
		return true;
	}
	return currentTree === record.initialTree || currentTree === record.broughtBackTree || currentTree === record.pushedTree;
}

export interface IDelegationCleanupPlan {
	/** When the server removes the worktree on its own; undefined while it keeps it. */
	readonly removeAfter?: number;
	/** Why it is (to be) removed, for the server log. */
	readonly reason?: string;
	/** The record's notes on what the server saw, updated (`chatSeenAt`, `archivedSeenAt`); undefined when unchanged. */
	readonly notes?: Pick<IDelegationRecord, 'chatSeenAt' | 'archivedSeenAt'>;
}

/** When the server removes a delegated chat's worktree on its own (see the top of this file). */
export function planDelegationCleanup(record: Pick<IDelegationRecord, 'createdAt' | 'chatSeenAt' | 'archivedSeenAt'>, state: DelegationChatState, workSafe: boolean, now: number): IDelegationCleanupPlan {
	let chatSeenAt = record.chatSeenAt;
	let archivedSeenAt = record.archivedSeenAt;
	let removeAfter: number | undefined;
	let reason: string | undefined;
	switch (state) {
		case DelegationChatState.Running:
			chatSeenAt ??= now;
			archivedSeenAt = undefined;
			break;
		case DelegationChatState.Archived:
			chatSeenAt ??= now;
			archivedSeenAt ??= now;
			if (workSafe) {
				removeAfter = archivedSeenAt + ARCHIVED_DELEGATION_KEEP_MS;
				reason = 'its chat is archived for 7 days and its work was brought back, pushed or never changed';
			}
			break;
		case DelegationChatState.Deleted:
			if (workSafe) {
				removeAfter = record.createdAt + ORPHANED_DELEGATION_KEEP_MS;
				reason = 'no chat on the server works in it for 30 days and its work was brought back, pushed or never changed';
			}
			break;
	}
	const changed = chatSeenAt !== record.chatSeenAt || archivedSeenAt !== record.archivedSeenAt;
	return {
		...(removeAfter !== undefined ? { removeAfter } : {}),
		...(reason ? { reason } : {}),
		...(changed ? { notes: { chatSeenAt, archivedSeenAt } } : {}),
	};
}

/** What the cleanup needs from the code receiver (`CreaEditorDelegationApi`). */
export interface IDelegationCleanupHost {
	listRecords(): readonly IDelegationRecord[];
	/** The worktree's path and its real path. */
	getWorktreePaths(record: IDelegationRecord): readonly string[];
	/** See {@link isDelegationWorkSafe}. */
	isWorkSafe(record: IDelegationRecord): Promise<boolean>;
	/** Writes the record's notes (when the record still exists). */
	updateNotes(delegationId: string, notes: Pick<IDelegationRecord, 'chatSeenAt' | 'archivedSeenAt'>): void;
	/** Removes the worktree, branch, base ref and record, and logs why. */
	removeDelegation(record: IDelegationRecord, reason: string): Promise<void>;
}

/** Runs the cleanup of delegated worktrees (see the top of this file). */
export class DelegationWorktreeCleanup extends Disposable {

	private _timer: ReturnType<typeof setTimeout> | undefined;
	private _running: Promise<void> = Promise.resolve();
	private _disposed = false;

	constructor(
		private readonly _host: IDelegationCleanupHost,
		private readonly _sessions: ICreaEditorServerSessionsSource,
		private readonly _logService: ILogService,
		private readonly _now: () => number = Date.now,
	) {
		super();
		this._register(this._sessions.onDidRemoveSession(session => this._enqueue(() => this._onDidRemoveSession(session))));
		this._register(this._sessions.onDidChangeSession(session => this._enqueue(() => this._onDidChangeSession(session))));
	}

	/** Sweeps soon (the agent host (re)started) and then every few hours. */
	scheduleSweep(delayMs = START_DELAY_MS): void {
		if (this._disposed) {
			return;
		}
		if (this._timer) {
			clearTimeout(this._timer);
		}
		this._timer = setTimeout(() => {
			this._timer = undefined;
			void this.sweep().finally(() => this.scheduleSweep(DELEGATION_CLEANUP_INTERVAL_MS));
		}, delayMs);
	}

	/** One pass over every delegation: notes what the server sees and removes what is due. */
	sweep(): Promise<void> {
		return this._enqueue(async () => {
			const sessions = await this._sessions.listSessions();
			if (!sessions) {
				return;
			}
			const now = this._now();
			for (const record of this._host.listRecords()) {
				try {
					const state = getDelegationChatState(findDelegationChats(record, this._host.getWorktreePaths(record), sessions));
					// Only ask git when the answer matters.
					const workSafe = state === DelegationChatState.Archived || state === DelegationChatState.Deleted ? await this._host.isWorkSafe(record) : false;
					const plan = planDelegationCleanup(record, state, workSafe, now);
					if (plan.removeAfter !== undefined && plan.removeAfter <= now && plan.reason) {
						await this._host.removeDelegation(record, plan.reason);
					} else if (plan.notes) {
						this._host.updateNotes(record.delegationId, plan.notes);
					}
				} catch (error) {
					this._logService.warn(`[Delegation cleanup] Checking ${record.worktree} failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		});
	}

	private async _onDidChangeSession(session: IServerChatSession): Promise<void> {
		const sessions = await this._sessions.listSessions();
		if (!sessions) {
			return;
		}
		const now = this._now();
		for (const record of this._host.listRecords()) {
			const paths = this._host.getWorktreePaths(record);
			if (!findDelegationChats(record, paths, [session]).length) {
				continue;
			}
			const plan = planDelegationCleanup(record, getDelegationChatState(findDelegationChats(record, paths, sessions)), false, now);
			if (plan.notes) {
				this._host.updateNotes(record.delegationId, plan.notes);
			}
		}
	}

	/** The user deleted a chat on the server: a delegation it was the last chat of goes at once. */
	private async _onDidRemoveSession(session: IServerChatSession): Promise<void> {
		const affected = this._host.listRecords().filter(record => record.chatSeenAt !== undefined && findDelegationChats(record, this._host.getWorktreePaths(record), [session]).length);
		if (!affected.length) {
			return;
		}
		const sessions = await this._sessions.listSessions();
		if (!sessions) {
			return;
		}
		for (const record of affected) {
			if (!findDelegationChats(record, this._host.getWorktreePaths(record), sessions).length) {
				await this._host.removeDelegation(record, 'its chat was deleted on the server').catch(error => this._logService.warn(`[Delegation cleanup] Removing ${record.worktree} failed: ${error instanceof Error ? error.message : String(error)}`));
			}
		}
	}

	private _enqueue(task: () => Promise<void>): Promise<void> {
		this._running = this._running.then(task).catch(error => this._logService.warn(`[Delegation cleanup] ${error instanceof Error ? error.message : String(error)}`));
		return this._running;
	}

	override dispose(): void {
		this._disposed = true;
		if (this._timer) {
			clearTimeout(this._timer);
		}
		super.dispose();
	}
}
