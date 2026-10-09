/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the writer of a CreaEditor Server's AI cost ledger. The agent host's own gateway path
// (`gatewayDirectConnection.ts`) appends one JSON line per OpenRouter/LiteLLM request to
// `<costs>/creaeditor-gateway-costs.jsonl`, in the copilot extension's `IGatewayCostEntry` shape; an
// update appends the entry again (the last line of an id wins, see `serverCostLedger.ts`).

import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IGatewayCostEntryLike } from '../../common/creaeditorCosts.js';
import { AGENT_HOST_COSTS_DIR_ENV_VAR, SERVER_COST_LEDGER_FILE } from './serverCostLedger.js';

/** A gateway request as the copilot extension's ledger records it (`IGatewayCostEntry`). */
export interface IGatewayCostRecord {
	readonly chatId: string;
	readonly rootChatId: string;
	readonly chatTitle?: string;
	readonly issue?: IGatewayCostEntryLike['issue'];
	readonly issueSource?: 'agent' | 'prompt' | 'branch';
	readonly repo?: string;
	readonly branch?: string;
	readonly gateway: 'openrouter' | 'litellm';
	readonly gatewayHost: string;
	readonly providerGroup?: string;
	readonly model: string;
	readonly gatewayRequestId?: string;
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly cachedTokens?: number;
	readonly cost?: number;
	readonly costSource?: 'header' | 'response' | 'openrouter-api' | 'litellm-api';
}

/** Appends to the ledger in `dir` (default: the server's costs folder); answers undefined outside a server. */
export class GatewayCostLedgerWriter {

	private readonly _entries = new Map<string, IGatewayCostEntryLike>();

	constructor(private readonly _dir: string, private readonly _now: () => number = Date.now) { }

	/** Records a request; answers its id. */
	record(record: IGatewayCostRecord): string {
		const entry: IGatewayCostEntryLike = { ...withoutUndefined(record), id: generateUuid(), time: this._now() };
		this._append(entry);
		return entry.id;
	}

	/** Updates a recorded request (e.g. with a cost reported later). */
	update(id: string, update: Partial<IGatewayCostRecord>): void {
		const existing = this._entries.get(id);
		if (existing) {
			this._append({ ...existing, ...withoutUndefined(update), id, time: existing.time });
		}
	}

	private _append(entry: IGatewayCostEntryLike): void {
		this._entries.set(entry.id, entry);
		fs.mkdirSync(this._dir, { recursive: true, mode: 0o700 });
		fs.appendFileSync(join(this._dir, SERVER_COST_LEDGER_FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	}
}

function withoutUndefined<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

let writer: GatewayCostLedgerWriter | null | undefined;

/** The ledger writer of this agent host on a CreaEditor Server ({@link AGENT_HOST_COSTS_DIR_ENV_VAR}), else undefined. */
export function getGatewayCostLedgerWriter(): GatewayCostLedgerWriter | undefined {
	if (writer === undefined) {
		const dir = process.env[AGENT_HOST_COSTS_DIR_ENV_VAR];
		writer = dir ? new GatewayCostLedgerWriter(dir) : null;
	}
	return writer ?? undefined;
}
