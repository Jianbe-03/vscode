/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: brings the AI costs of CreaEditor Servers to this computer and their budgets to the
// servers (see `platform/agentHost/common/creaeditorCosts.ts`). Every few minutes while the Agents
// window is open (and when a server connects), it pulls each server's new ledger entries into
// `<global storage>/creaeditor-server-costs/<serverId>.json` of the DEFAULT profile (the Agents window
// runs in a built-in profile; every window's copilot extension reads that same folder and merges it into
// AI Costs with the server as the machine), and pushes the hard-stop budgets with what this computer
// and the other servers spent in their periods. Only the Agents window pulls (it has the servers).

import { IntervalTimer, RunOnceScheduler, Sequencer } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { COPILOT_GATEWAY_LEDGER_PATH, COST_BUDGETS_SETTING_ID, createServerCostBudgets, CREAEDITOR_SERVER_COSTS_CACHE_FOLDER, CREAEDITOR_SERVER_COSTS_OVERLAP_MS, ICreaEditorServerCostsCache, IGatewayCostEntryLike, mergeCostEntries, parseCostBudgets } from '../../../../../platform/agentHost/common/creaeditorCosts.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { IUserDataProfileService } from '../../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { IUserDataProfilesService } from '../../../../../platform/userDataProfile/common/userDataProfile.js';
import { ICreaEditorServer, ICreaEditorServersService } from './creaeditorServers.js';

const SYNC_INTERVAL_MS = 5 * 60_000;
/** Pages of entries per server per sync, at most. */
const MAX_PAGES = 20;
const PAGE_SIZE = 5000;

/** Reads a cache file; an empty one for a missing or broken file. */
export function parseServerCostsCache(text: string | undefined, server: ICreaEditorServer): ICreaEditorServerCostsCache {
	try {
		const value = text ? JSON.parse(text) as Partial<ICreaEditorServerCostsCache> : undefined;
		if (value && Array.isArray(value.entries) && typeof value.cursor === 'number') {
			return { serverId: server.id, serverName: server.name, cursor: value.cursor, entries: value.entries };
		}
	} catch {
		// Start over.
	}
	return { serverId: server.id, serverName: server.name, cursor: 0, entries: [] };
}

/** The cache file of a server's costs in a global storage folder (use the default profile's, which every window reads). */
export function getServerCostsCacheFile(globalStorage: URI, serverId: string): URI {
	return URI.joinPath(globalStorage, CREAEDITOR_SERVER_COSTS_CACHE_FOLDER, `${serverId}.json`);
}

/** Reads a JSON lines ledger, skipping broken lines. */
export function parseLedgerLines(text: string): IGatewayCostEntryLike[] {
	const entries: IGatewayCostEntryLike[] = [];
	for (const line of text.split('\n')) {
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

export class CreaEditorServerCostsSync extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.creaeditorServerCosts';

	private readonly _sequencer = new Sequencer();
	private readonly _timer = this._register(new IntervalTimer());
	private readonly _soon = this._register(new RunOnceScheduler(() => this._syncAll(), 5_000));

	constructor(
		@ICreaEditorServersService private readonly _serversService: ICreaEditorServersService,
		@IRemoteAgentHostService remoteAgentHostService: IRemoteAgentHostService,
		@IFileService private readonly _fileService: IFileService,
		@IUserDataProfileService private readonly _userDataProfileService: IUserDataProfileService,
		@IUserDataProfilesService private readonly _userDataProfilesService: IUserDataProfilesService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IHostService private readonly _hostService: IHostService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(remoteAgentHostService.onDidChangeConnections(() => this._soon.schedule()));
		this._register(this._configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(COST_BUDGETS_SETTING_ID)) {
				this._soon.schedule();
			}
		}));
		// Also while another window has focus: the AI Costs page there shows what this window pulls.
		this._timer.cancelAndSet(() => this._syncAll(), SYNC_INTERVAL_MS);
		this._register(this._hostService.onDidChangeFocus(focused => {
			if (focused) {
				this._soon.schedule();
			}
		}));
		this._soon.schedule();
	}

	/** The global storage folders whose files every window reads: the default profile's, then this window's own (if another). */
	private get _globalStorages(): URI[] {
		const shared = this._userDataProfilesService.defaultProfile.globalStorageHome;
		const own = this._userDataProfileService.currentProfile.globalStorageHome;
		return own.toString() === shared.toString() ? [shared] : [shared, own];
	}

	private _cacheFile(serverId: string, globalStorage = this._globalStorages[0]): URI {
		return getServerCostsCacheFile(globalStorage, serverId);
	}

	/** Pulls the costs of every server and pushes the budgets now. */
	syncNow(): Promise<void> {
		return this._sequencer.queue(async () => {
			const servers = this._serversService.servers.get();
			if (!servers.length) {
				return;
			}
			const caches = new Map<string, ICreaEditorServerCostsCache>();
			for (const server of servers) {
				caches.set(server.id, await this._pull(server));
			}
			await this._pushBudgets(servers, caches);
		}).catch(error => this._logService.warn('[CreaEditor Server Costs] Sync failed', error));
	}

	private _syncAll(): void {
		void this.syncNow();
	}

	/** Pulls new entries of one server into its cache file; answers the cache (unchanged when offline). */
	private async _pull(server: ICreaEditorServer): Promise<ICreaEditorServerCostsCache> {
		const file = this._cacheFile(server.id);
		let text = await this._readText(file);
		// Earlier versions kept the cache in this window's own profile, which other windows do not read.
		const oldFile = this._globalStorages.length > 1 ? this._cacheFile(server.id, this._globalStorages[1]) : undefined;
		const oldText = oldFile ? await this._readText(oldFile) : undefined;
		let migrated = false;
		if (text === undefined && oldText !== undefined) {
			text = oldText;
			migrated = true;
		}
		const cache = parseServerCostsCache(text, server);
		let entries = cache.entries;
		let cursor = cache.cursor;
		let after = Math.max(0, cursor - CREAEDITOR_SERVER_COSTS_OVERLAP_MS);
		let changed = cache.serverName !== server.name;
		for (let page = 0; page < MAX_PAGES; page++) {
			const answer = await this._serversService.fetchCosts(server.id, after);
			if (!answer) {
				break;
			}
			if (answer.reset) {
				entries = [];
			}
			if (answer.entries.length) {
				entries = mergeCostEntries(entries, answer.entries);
				changed = true;
			}
			cursor = Math.max(cursor, answer.cursor);
			if (answer.entries.length < PAGE_SIZE || answer.cursor <= after) {
				break;
			}
			after = answer.cursor;
		}
		const updated: ICreaEditorServerCostsCache = { serverId: server.id, serverName: server.name, cursor, entries };
		if (changed || migrated || cursor !== cache.cursor) {
			await this._fileService.writeFile(file, VSBuffer.fromString(JSON.stringify(updated)));
		}
		if (oldFile && oldText !== undefined) {
			await this._fileService.del(oldFile).catch(() => undefined);
		}
		return updated;
	}

	private async _readText(file: URI): Promise<string | undefined> {
		try {
			return (await this._fileService.readFile(file)).value.toString();
		} catch {
			return undefined;
		}
	}

	private async _pushBudgets(servers: readonly ICreaEditorServer[], caches: ReadonlyMap<string, ICreaEditorServerCostsCache>): Promise<void> {
		const budgets = parseCostBudgets(this._configurationService.getValue(COST_BUDGETS_SETTING_ID));
		const hardStops = budgets.filter(budget => budget.hardStop);
		let local: IGatewayCostEntryLike[] = [];
		if (hardStops.length) {
			// Each profile's copilot extension keeps its own ledger: the editor window's and this window's.
			for (const globalStorage of this._globalStorages) {
				const text = await this._readText(URI.joinPath(globalStorage, ...COPILOT_GATEWAY_LEDGER_PATH));
				local = text ? mergeCostEntries(local, parseLedgerLines(text)) : local;
			}
		}
		const now = Date.now();
		for (const server of servers) {
			// What this computer and the other servers spent; the server adds its own.
			const elsewhere = hardStops.length ? [...local, ...[...caches.values()].filter(cache => cache.serverId !== server.id).flatMap(cache => cache.entries)] : [];
			await this._serversService.pushBudgets(server.id, createServerCostBudgets(hardStops, elsewhere, now));
		}
	}
}

registerWorkbenchContribution2(CreaEditorServerCostsSync.ID, CreaEditorServerCostsSync, WorkbenchPhase.Eventually);
