/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: Delegate to Server on this machine, in the main process: packs code with git, reads the
// agents' session files, talks to the server's code receiver and brings results back. Windows use it
// through ICreaEditorDelegationService (IPC channel CREAEDITOR_DELEGATION_CHANNEL_NAME).

import { hostname } from 'os';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { DELEGATION_ERROR_NAME, DelegationErrorCode, IBringBackRequest, IBringBackResult, ICreaEditorDelegationService, IDelegateRequest, IDelegateResult, IDelegationProgress, IDelegationRecord, IDelegationServerKeyResponse, IDelegationServerTarget, IDelegationWorktreeInfo } from '../common/creaeditorDelegation.js';
import { bringBackChanges, delegateChat, DelegationHttpClient } from '../node/creaeditorDelegation/delegationClient.js';
import { DelegationError, listUntrackedSecretFiles, readDelegationRepository } from '../node/creaeditorDelegation/delegationPack.js';
import { git, IDelegationProcessRunner, nodeDelegationProcessRunner } from '../node/creaeditorDelegation/delegationProcess.js';

/** Errors cross IPC as their name and message only: the name carries the code (`CreaEditorDelegationError:<code>`). */
function toTransferableError(error: unknown): Error {
	if (error instanceof DelegationError) {
		const transferable = new Error(error.message);
		transferable.name = `${DELEGATION_ERROR_NAME}:${error.code}`;
		return transferable;
	}
	return error instanceof Error ? error : new Error(String(error));
}

async function withTransferableErrors<T>(task: () => Promise<T>): Promise<T> {
	try {
		return await task();
	} catch (error) {
		throw toTransferableError(error);
	}
}

export class CreaEditorDelegationMainService extends Disposable implements ICreaEditorDelegationService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidProgress = this._register(new Emitter<IDelegationProgress>());
	readonly onDidProgress = this._onDidProgress.event;

	private readonly _runner: IDelegationProcessRunner = nodeDelegationProcessRunner;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
	}

	inspectFolder(folder: string): Promise<{ readonly repoRoot: string; readonly branch?: string; readonly remoteUrl?: string; readonly skippedSecretFiles: readonly string[] }> {
		return withTransferableErrors(async () => {
			const info = await readDelegationRepository(folder, this._runner);
			return {
				repoRoot: info.root,
				...(info.branch ? { branch: info.branch } : {}),
				...(info.remoteUrl ? { remoteUrl: info.remoteUrl } : {}),
				skippedSecretFiles: await listUntrackedSecretFiles(info.root, this._runner),
			};
		});
	}

	getServerInfo(server: IDelegationServerTarget): Promise<IDelegationServerKeyResponse> {
		return withTransferableErrors(() => new DelegationHttpClient(server).getKey());
	}

	delegate(operationId: string, request: IDelegateRequest): Promise<IDelegateResult> {
		return withTransferableErrors(async () => {
			this._logService.info(`[Delegation] Delegating ${request.folder} to ${request.server.name}`);
			const result = await delegateChat({ ...request, sourceName: request.sourceName || hostname() }, { onProgress: progress => this._onDidProgress.fire({ operationId, ...progress }) });
			this._logService.info(`[Delegation] Delegated to ${request.server.name}: ${result.bytesSent} bytes${result.incremental ? ' (incremental)' : ''}, session files ${result.sessionFilesSent ? 'sent' : 'not sent'}, branch ${result.record.branch}`);
			return result;
		});
	}

	getDelegation(server: IDelegationServerTarget, delegationId: string): Promise<IDelegationRecord> {
		return withTransferableErrors(() => new DelegationHttpClient(server).getDelegation(delegationId));
	}

	bringBackChanges(operationId: string, request: IBringBackRequest): Promise<IBringBackResult> {
		return withTransferableErrors(() => bringBackChanges(request, { onProgress: progress => this._onDidProgress.fire({ operationId, ...progress }) }));
	}

	openPullRequest(server: IDelegationServerTarget, delegationId: string): Promise<string> {
		return withTransferableErrors(() => new DelegationHttpClient(server).pullRequest(delegationId));
	}

	listServerWorktrees(server: IDelegationServerTarget): Promise<readonly IDelegationWorktreeInfo[]> {
		return withTransferableErrors(() => new DelegationHttpClient(server).listWorktrees());
	}

	removeServerDelegation(server: IDelegationServerTarget, delegationId: string): Promise<void> {
		return withTransferableErrors(async () => {
			await new DelegationHttpClient(server).removeDelegation(delegationId);
			this._logService.info(`[Delegation] Removed delegated chat ${delegationId} on ${server.name}`);
		});
	}

	setServerGitHubToken(server: IDelegationServerTarget, token: string): Promise<void> {
		return withTransferableErrors(() => new DelegationHttpClient(server).setGitHubToken(token));
	}

	applyBroughtBackBranch(folder: string, branch: string, how: 'checkout' | 'merge'): Promise<void> {
		return withTransferableErrors(async () => {
			const { root } = await readDelegationRepository(folder, this._runner);
			const changes = (await git(this._runner, root, ['status', '--porcelain', '--untracked-files=no'])).trim();
			if (changes) {
				throw new DelegationError(DelegationErrorCode.InvalidRequest, how === 'checkout'
					? `Commit or stash your changes before checking out ${branch}.`
					: `Commit or stash your changes before merging ${branch}.`);
			}
			if (how === 'checkout') {
				await git(this._runner, root, ['checkout', '-q', branch]);
				return;
			}
			const merge = await this._runner.run('git', ['merge', '--no-edit', branch], { cwd: root });
			if (merge.code !== 0) {
				await this._runner.run('git', ['merge', '--abort'], { cwd: root });
				throw new DelegationError(DelegationErrorCode.InvalidRequest, `${branch} does not merge cleanly into the current branch; nothing was changed. Check it out, or merge it in a terminal to resolve the conflicts.`);
			}
		});
	}

	listBranchChanges(folder: string, branch: string): Promise<readonly { readonly path: string; readonly status: 'A' | 'M' | 'D' }[]> {
		return withTransferableErrors(async () => {
			const { root } = await readDelegationRepository(folder, this._runner);
			const output = await git(this._runner, root, ['diff', '--name-status', '--no-renames', '-z', 'HEAD', branch, '--']);
			const parts = output.split('\0').filter(Boolean);
			const changes: { path: string; status: 'A' | 'M' | 'D' }[] = [];
			for (let i = 0; i + 1 < parts.length; i += 2) {
				const status = parts[i].charAt(0);
				changes.push({ path: `${root}/${parts[i + 1]}`, status: status === 'A' ? 'A' : status === 'D' ? 'D' : 'M' });
			}
			return changes;
		});
	}
}
