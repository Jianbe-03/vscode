/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: reading the AI cost ledger of a CreaEditor Server (see `common/creaeditorCosts.ts`) and
// deciding its hard stops. The agent host's server-side gateway path writes
// `<costs>/creaeditor-gateway-costs.jsonl` (`gatewayCostLedger.ts`; one JSON entry per line like the
// copilot extension's ledger, either appended or rewritten; the last line of an id wins). The laptop
// pushes its budgets to `<costs>/budgets.json`. The server's front serves the ledger for
// `GET /api/server/costs` and writes the budgets; it never writes the ledger.

import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';
import { findServerHardStop, ICostBudgetRequest, ICreaEditorServerCostsResponse, IGatewayCostEntryLike, IServerCostBudgets, IServerHardStop, parseServerCostBudgets } from '../../common/creaeditorCosts.js';

/** Set by the CreaEditor Server: the folder of its cost ledger and the budgets the laptop pushed. */
export const AGENT_HOST_COSTS_DIR_ENV_VAR = 'CREAEDITOR_AGENT_HOST_COSTS_DIR';

/** The ledger file in the costs folder (same name as the copilot extension's ledger). */
export const SERVER_COST_LEDGER_FILE = 'creaeditor-gateway-costs.jsonl';
export const SERVER_COST_BUDGETS_FILE = 'budgets.json';

/** At most this many entries are answered per request; the client asks again from the new cursor. */
const MAX_ENTRIES_PER_READ = 5000;

/** Every entry of the ledger, the latest line of each id, oldest first. */
export function readServerCostLedger(dir: string): IGatewayCostEntryLike[] {
	let content: string;
	try {
		content = fs.readFileSync(join(dir, SERVER_COST_LEDGER_FILE), 'utf8');
	} catch {
		return [];
	}
	const byId = new Map<string, IGatewayCostEntryLike>();
	for (const line of content.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const entry = JSON.parse(line) as IGatewayCostEntryLike;
			if (entry && typeof entry.id === 'string' && typeof entry.time === 'number') {
				byId.delete(entry.id);
				byId.set(entry.id, entry);
			}
		} catch {
			// A corrupt or half-written line.
		}
	}
	return [...byId.values()].sort((a, b) => a.time - b.time);
}

/**
 * The entries with a `time` of at least `after` (epoch milliseconds), at most `limit`, oldest first.
 * `cursor` is the latest time answered; a client asks again from a bit before it (costs that arrive
 * later update an entry without changing its time) and keeps the latest version of each id.
 */
export function readServerCostEntries(dir: string, after: number, limit = MAX_ENTRIES_PER_READ): ICreaEditorServerCostsResponse {
	const from = Number.isFinite(after) && after > 0 ? after : 0;
	const entries = readServerCostLedger(dir).filter(entry => entry.time >= from).slice(0, limit);
	return { entries, cursor: entries.length ? entries[entries.length - 1].time : from, reset: false };
}

/** Writes the budgets the laptop pushed (atomically, 0600). */
export function writeServerCostBudgets(dir: string, budgets: IServerCostBudgets): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, SERVER_COST_BUDGETS_FILE);
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, `${JSON.stringify(budgets)}\n`, { mode: 0o600 });
	fs.renameSync(temp, file);
}

/** The budgets the laptop pushed last; undefined before the first push. */
export function readServerCostBudgets(dir: string): IServerCostBudgets | undefined {
	try {
		return parseServerCostBudgets(JSON.parse(fs.readFileSync(join(dir, SERVER_COST_BUDGETS_FILE), 'utf8')));
	} catch {
		return undefined;
	}
}

/**
 * The used up hard-stop budget that refuses a gateway request on this server, if any: call it before
 * every OpenRouter/LiteLLM request the server makes itself, and refuse with the budget's name like the
 * laptop does. `dir` defaults to {@link AGENT_HOST_COSTS_DIR_ENV_VAR}; outside a server there is none.
 */
export function findServerCostHardStop(request: ICostBudgetRequest, dir: string | undefined = process.env[AGENT_HOST_COSTS_DIR_ENV_VAR], now = Date.now()): IServerHardStop | undefined {
	if (!dir) {
		return undefined;
	}
	const budgets = readServerCostBudgets(dir);
	if (!budgets?.budgets.some(budget => budget.hardStop)) {
		return undefined;
	}
	return findServerHardStop(budgets, readServerCostLedger(dir), request, now);
}
