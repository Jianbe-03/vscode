/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the AI cost ledger of a CreaEditor Server (see `common/creaeditorCosts.ts`). The agent
// host appends every OpenRouter/LiteLLM request it makes itself to `<costs>/ledger.jsonl` (an update
// appends the entry again; the last line of an id wins) and refuses requests once a hard-stop budget
// the laptop pushed (`<costs>/budgets.json`) is used up. The server's front reads the file for
// `GET /api/server/costs`; it never writes it, so the two processes do not race.

import * as fs from 'fs';
import { generateUuid } from '../../../../base/common/uuid.js';
import { join } from '../../../../base/common/path.js';
import { findServerHardStop, ICostBudgetRequest, ICreaEditorServerCostsResponse, IGatewayCostEntryLike, IServerCostBudgets, IServerHardStop, parseServerCostBudgets } from '../../common/creaeditorCosts.js';

/** Set by the CreaEditor Server: the folder of its cost ledger and the budgets the laptop pushed. */
export const AGENT_HOST_COSTS_DIR_ENV_VAR = 'CREAEDITOR_AGENT_HOST_COSTS_DIR';

export const SERVER_COST_LEDGER_FILE = 'ledger.jsonl';
export const SERVER_COST_BUDGETS_FILE = 'budgets.json';

/** At most this many entries are answered per request; the client asks again with the new cursor. */
const MAX_ENTRIES_PER_READ = 5000;

/** The ledger file of a server; see the top of this file. */
export class ServerCostLedger {

	private readonly _entries = new Map<string, IGatewayCostEntryLike>();
	private _budgets: { readonly mtimeMs: number; readonly value: IServerCostBudgets | undefined } | undefined;

	constructor(private readonly _dir: string, private readonly _now: () => number = Date.now) {
		fs.mkdirSync(_dir, { recursive: true, mode: 0o700 });
		const { entries } = readServerCostEntries(_dir, 0, Number.MAX_SAFE_INTEGER);
		for (const entry of entries) {
			this._entries.set(entry.id, entry);
		}
	}

	get entries(): readonly IGatewayCostEntryLike[] {
		return [...this._entries.values()];
	}

	/**
	 * Records a request (fields like the copilot extension's `IGatewayCostEntry`: `chatId`,
	 * `rootChatId`, `chatTitle`, `repo`, `branch`, `gateway`, `gatewayHost`, `providerGroup`, `model`,
	 * token counts, `cost`, `costSource`). Returns its id.
	 */
	record(entry: Omit<IGatewayCostEntryLike, 'id' | 'time'>): string {
		const recorded: IGatewayCostEntryLike = { ...entry, id: generateUuid(), time: this._now() };
		this._append(recorded);
		return recorded.id;
	}

	/** Updates a recorded request, e.g. with the cost the gateway reported later. */
	update(id: string, update: Partial<Omit<IGatewayCostEntryLike, 'id' | 'time'>>): void {
		const existing = this._entries.get(id);
		if (!existing) {
			return;
		}
		const defined = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined));
		this._append({ ...existing, ...defined, id, time: existing.time });
	}

	/** The used up hard-stop budget that refuses a request with this scope, if any. */
	findHardStop(request: ICostBudgetRequest): IServerHardStop | undefined {
		return findServerHardStop(this._readBudgets(), this.entries, request, this._now());
	}

	private _append(entry: IGatewayCostEntryLike): void {
		this._entries.set(entry.id, entry);
		fs.appendFileSync(join(this._dir, SERVER_COST_LEDGER_FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	}

	private _readBudgets(): IServerCostBudgets | undefined {
		const file = join(this._dir, SERVER_COST_BUDGETS_FILE);
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(file).mtimeMs;
		} catch {
			return undefined;
		}
		if (this._budgets?.mtimeMs !== mtimeMs) {
			let value: IServerCostBudgets | undefined;
			try {
				value = parseServerCostBudgets(JSON.parse(fs.readFileSync(file, 'utf8')));
			} catch {
				value = undefined;
			}
			this._budgets = { mtimeMs, value };
		}
		return this._budgets.value;
	}
}

/**
 * Reads the ledger from byte offset `after` (a cursor of an earlier read): only whole lines, at most
 * `limit` entries. A cursor past the end means the file was replaced: everything is read again.
 */
export function readServerCostEntries(dir: string, after: number, limit = MAX_ENTRIES_PER_READ): ICreaEditorServerCostsResponse {
	const file = join(dir, SERVER_COST_LEDGER_FILE);
	let content: Buffer;
	try {
		content = fs.readFileSync(file);
	} catch {
		return { entries: [], cursor: 0, reset: after > 0 };
	}
	const reset = !Number.isInteger(after) || after < 0 || after > content.length;
	let offset = reset ? 0 : after;
	const entries: IGatewayCostEntryLike[] = [];
	while (offset < content.length && entries.length < limit) {
		const end = content.indexOf(0x0a, offset);
		if (end === -1) {
			break; // A line being written.
		}
		const line = content.subarray(offset, end).toString('utf8');
		offset = end + 1;
		try {
			const entry = JSON.parse(line) as IGatewayCostEntryLike;
			if (entry && typeof entry.id === 'string' && typeof entry.time === 'number') {
				entries.push(entry);
			}
		} catch {
			// Skip a corrupt line rather than losing the ledger.
		}
	}
	return { entries, cursor: offset, reset };
}

/** Writes the budgets the laptop pushed (atomically, 0600). */
export function writeServerCostBudgets(dir: string, budgets: IServerCostBudgets): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, SERVER_COST_BUDGETS_FILE);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(budgets)}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
}

let serverCostLedger: ServerCostLedger | null | undefined;

/**
 * The ledger of this agent host when it runs on a CreaEditor Server ({@link AGENT_HOST_COSTS_DIR_ENV_VAR}),
 * else undefined: the desktop records gateway costs in the copilot extension.
 *
 * A request path that calls a gateway directly on the server records it here and checks
 * {@link ServerCostLedger.findHardStop} first, refusing with the same message the laptop shows.
 */
export function getServerCostLedger(): ServerCostLedger | undefined {
	if (serverCostLedger === undefined) {
		const dir = process.env[AGENT_HOST_COSTS_DIR_ENV_VAR];
		serverCostLedger = dir ? new ServerCostLedger(dir) : null;
	}
	return serverCostLedger ?? undefined;
}
