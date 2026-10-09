/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: AI costs of CreaEditor Servers. A server records the OpenRouter/LiteLLM requests it makes
// itself in its own ledger (`<data>/costs/creaeditor-gateway-costs.jsonl`, written by the agent host's
// server-side gateway path, read by `node/shared/serverCostLedger.ts`); the laptop pulls new entries over the
// server's HTTP API (`GET /api/server/costs`, device key) into a cache next to the copilot extension's
// ledger, and the AI Costs page shows them with the server as the machine. The laptop also pushes its
// budgets with what was spent elsewhere in each budget's period (`PUT /api/server/costs/budgets`), so
// a hard stop refuses a server's requests the way it refuses the laptop's.
//
// The budget math mirrors `extensions/copilot/src/extension/byok/common/gatewayCostsAnalysis.ts`
// (the extension cannot import this layer); keep the two in step.

/** The path prefix of the server's own API (Remote Access `apiHandlers`). */
export const CREAEDITOR_SERVER_API_PREFIX = '/api/server/';

/** `POST /api/server/pairing`: a new pairing code. */
export const CREAEDITOR_SERVER_API_PAIRING = 'pairing';
/** `GET /api/server/costs?after=<cursor>`: new ledger entries. */
export const CREAEDITOR_SERVER_API_COSTS = 'costs';
/** `PUT /api/server/costs/budgets`: the laptop's budgets. */
export const CREAEDITOR_SERVER_API_BUDGETS = 'costs/budgets';

/** What `POST /api/server/pairing` answers. */
export interface ICreaEditorServerPairingResponse {
	readonly code: string;
	readonly expiresAt: number;
	/** The web page with the code, to show as a QR code. */
	readonly link: string;
}

/** The folder in the workbench's global storage where pulled server costs are kept, one file per server. */
export const CREAEDITOR_SERVER_COSTS_CACHE_FOLDER = 'creaeditor-server-costs';

/**
 * The copilot extension's own ledger, relative to the global storage folder (read, never written, here:
 * the spend of this computer counts toward the budgets pushed to servers).
 */
export const COPILOT_GATEWAY_LEDGER_PATH: readonly string[] = ['github.copilot-chat', 'creaeditor-gateway-costs.jsonl'];

/**
 * One gateway request, as the copilot extension's ledger keeps it (`IGatewayCostEntry`). Only the
 * fields this layer needs are typed; the rest are carried along as they are.
 */
export interface IGatewayCostEntryLike {
	readonly id: string;
	/** Epoch milliseconds. */
	readonly time: number;
	readonly cost?: number;
	readonly providerGroup?: string;
	readonly repo?: string;
	readonly issue?: { readonly kind?: 'github' | 'jira'; readonly number?: number; readonly repo?: string; readonly key?: string };
	readonly [field: string]: unknown;
}

/** What `GET /api/server/costs?after=<time>` answers: entries with a time of at least `after`, oldest first. */
export interface ICreaEditorServerCostsResponse {
	readonly entries: readonly IGatewayCostEntryLike[];
	/** The latest entry time answered. Ask from a bit before it next time: a cost reported later updates an entry without changing its time. */
	readonly cursor: number;
	/** Reserved: the client should drop what it kept. */
	readonly reset: boolean;
}

/** How far before the cursor the laptop asks again, for costs the gateway reported late. */
export const CREAEDITOR_SERVER_COSTS_OVERLAP_MS = 60 * 60 * 1000;

/** A pulled server's entries, as cached on the laptop (`<cache folder>/<serverId>.json`). */
export interface ICreaEditorServerCostsCache {
	readonly serverId: string;
	/** Shown as the machine on the AI Costs page. */
	readonly serverName: string;
	readonly cursor: number;
	readonly entries: readonly IGatewayCostEntryLike[];
}

export type CostBudgetScope = 'key' | 'issue' | 'repo';
export type CostBudgetPeriod = 'day' | 'week' | 'month';

/** A budget of the `creaeditor.aiCosts.budgets` setting. */
export interface ICostBudget {
	readonly id: string;
	readonly scope: CostBudgetScope;
	readonly value: string;
	readonly amount: number;
	readonly period: CostBudgetPeriod;
	readonly hardStop: boolean;
}

/** The setting the budgets are in (contributed by the copilot extension). */
export const COST_BUDGETS_SETTING_ID = 'creaeditor.aiCosts.budgets';

/** A hard-stop budget as pushed to a server, with the laptop's view of its current period. */
export interface IServerCostBudget extends ICostBudget {
	/** The period, by the laptop's clock and time zone; `to` exclusive. */
	readonly from: number;
	readonly to: number;
	/** What the laptop and the other servers spent in this budget's period. */
	readonly spentElsewhere: number;
}

/** What `PUT /api/server/costs/budgets` takes, and the server keeps in `costs/budgets.json`. */
export interface IServerCostBudgets {
	readonly updatedAt: number;
	readonly budgets: readonly IServerCostBudget[];
}

/** What a request is for, as the ledger would record it. */
export interface ICostBudgetRequest {
	readonly providerGroup?: string;
	/** Issue label, see {@link formatCostIssue}. */
	readonly issue?: string;
	readonly repo?: string;
}

const BUDGET_SCOPES: readonly CostBudgetScope[] = ['key', 'issue', 'repo'];
const BUDGET_PERIODS: readonly CostBudgetPeriod[] = ['day', 'week', 'month'];

/** Reads the budgets setting like the extension does (invalid entries are left out). */
export function parseCostBudgets(value: unknown): ICostBudget[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const result: ICostBudget[] = [];
	const ids = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const raw = item as Record<string, unknown>;
		const scope = BUDGET_SCOPES.find(candidate => candidate === raw.scope);
		const period = BUDGET_PERIODS.find(candidate => candidate === raw.period) ?? 'month';
		const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) && raw.amount > 0 ? raw.amount : undefined;
		const budgetValue = typeof raw.value === 'string' ? raw.value.trim() : '';
		if (!scope || amount === undefined || !budgetValue) {
			continue;
		}
		let id = typeof raw.id === 'string' && raw.id ? raw.id : `${scope}:${budgetValue}:${period}`;
		while (ids.has(id)) {
			id += '+';
		}
		ids.add(id);
		result.push({ id, scope, value: budgetValue, amount, period, hardStop: raw.hardStop === true });
	}
	return result;
}

/** Reads a pushed budgets file; undefined when it is not one. */
export function parseServerCostBudgets(value: unknown): IServerCostBudgets | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { updatedAt, budgets } = value as { updatedAt?: unknown; budgets?: unknown };
	if (typeof updatedAt !== 'number' || !Array.isArray(budgets)) {
		return undefined;
	}
	const parsed = parseCostBudgets(budgets);
	const result: IServerCostBudget[] = [];
	for (const budget of parsed) {
		const raw = budgets.find(item => item && typeof item === 'object' && (item as { id?: unknown }).id === budget.id) as Partial<IServerCostBudget> | undefined;
		const numbers = [raw?.from, raw?.to, raw?.spentElsewhere];
		if (raw && numbers.every(item => typeof item === 'number' && Number.isFinite(item))) {
			result.push({ ...budget, from: raw.from!, to: raw.to!, spentElsewhere: Math.max(0, raw.spentElsewhere!) });
		}
	}
	return { updatedAt, budgets: result };
}

/** The current day, week (from Monday) or month in local time, `to` exclusive. */
export function getBudgetPeriodRange(period: CostBudgetPeriod, now: number): { readonly from: number; readonly to: number } {
	const date = new Date(now);
	if (period === 'month') {
		return { from: new Date(date.getFullYear(), date.getMonth(), 1).getTime(), to: new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime() };
	}
	const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
	if (period === 'week') {
		start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
	}
	const end = new Date(start);
	end.setDate(end.getDate() + (period === 'week' ? 7 : 1));
	return { from: start.getTime(), to: end.getTime() };
}

/** An issue as the ledger labels it: `PROJ-7`, `owner/repo#42` or `#42`. */
export function formatCostIssue(issue: IGatewayCostEntryLike['issue'], fallbackRepo?: string): string | undefined {
	if (!issue) {
		return undefined;
	}
	if (issue.kind === 'jira') {
		return issue.key;
	}
	if (issue.number === undefined) {
		return undefined;
	}
	const repo = issue.repo ?? fallbackRepo;
	return repo ? `${repo}#${issue.number}` : `#${issue.number}`;
}

/** Whether a request falls in the scope of a budget. */
export function budgetMatchesRequest(budget: ICostBudget, request: ICostBudgetRequest): boolean {
	switch (budget.scope) {
		case 'key': return request.providerGroup === budget.value;
		case 'issue': return request.issue === budget.value;
		case 'repo': return request.repo === budget.value;
	}
}

/** What the entries spent in a budget's scope from `from` up to (not including) `to`. */
export function sumBudgetSpend(budget: ICostBudget, entries: Iterable<IGatewayCostEntryLike>, from: number, to: number): number {
	let spent = 0;
	for (const entry of entries) {
		if (entry.time >= from && entry.time < to && typeof entry.cost === 'number'
			&& budgetMatchesRequest(budget, { providerGroup: entry.providerGroup, issue: formatCostIssue(entry.issue, entry.repo), repo: entry.repo })) {
			spent += entry.cost;
		}
	}
	return spent;
}

/**
 * The hard-stop budgets to push to one server: each with its current period and what the other
 * machines (`elsewhere`: the laptop's own ledger and the other servers' entries) spent in it.
 */
export function createServerCostBudgets(budgets: readonly ICostBudget[], elsewhere: readonly IGatewayCostEntryLike[], now: number): IServerCostBudgets {
	return {
		updatedAt: now,
		budgets: budgets.filter(budget => budget.hardStop).map(budget => {
			const { from, to } = getBudgetPeriodRange(budget.period, now);
			return { ...budget, from, to, spentElsewhere: sumBudgetSpend(budget, elsewhere, from, to) };
		}),
	};
}

/** A used up hard-stop budget that refuses a request on a server. */
export interface IServerHardStop {
	readonly budget: IServerCostBudget;
	readonly spent: number;
}

/**
 * The used up hard-stop budget that refuses a request on a server, if any (the one used up the
 * furthest). Within the period the laptop pushed, the spend elsewhere counts too; once that period is
 * over (no newer push yet), only this server's own spend in its current period counts.
 */
export function findServerHardStop(pushed: IServerCostBudgets | undefined, ownEntries: readonly IGatewayCostEntryLike[], request: ICostBudgetRequest, now: number): IServerHardStop | undefined {
	let worst: IServerHardStop | undefined;
	for (const budget of pushed?.budgets ?? []) {
		if (!budget.hardStop || !budgetMatchesRequest(budget, request)) {
			continue;
		}
		const current = now >= budget.from && now < budget.to;
		const range = current ? budget : getBudgetPeriodRange(budget.period, now);
		const spent = (current ? budget.spentElsewhere : 0) + sumBudgetSpend(budget, ownEntries, range.from, range.to);
		if (spent >= budget.amount && (!worst || spent / budget.amount > worst.spent / worst.budget.amount)) {
			worst = { budget, spent };
		}
	}
	return worst;
}

/**
 * Merges pulled entries into what was kept: the same id keeps its latest version (a cost the gateway
 * reported later replaces the first record), oldest first, at most `max` entries.
 */
export function mergeCostEntries(kept: readonly IGatewayCostEntryLike[], pulled: readonly IGatewayCostEntryLike[], max = 50_000): IGatewayCostEntryLike[] {
	const byId = new Map<string, IGatewayCostEntryLike>();
	for (const entry of [...kept, ...pulled]) {
		if (entry && typeof entry.id === 'string' && typeof entry.time === 'number') {
			byId.set(entry.id, entry);
		}
	}
	return [...byId.values()].sort((a, b) => a.time - b.time).slice(-max);
}
