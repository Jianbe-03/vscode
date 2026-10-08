/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { commands } from 'vscode';
import { IGatewayTrackingService } from '../../../platform/endpoint/common/gatewayTrackingService';
import { RunOnceScheduler } from '../../../util/vs/base/common/async';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { computeChatCosts, getChangedChats, ICostAggregate } from '../common/gatewayCostsAnalysis';

/** Returns the gateway cost per chat for a list of chat ids (the ids the requests were recorded with). */
export const GET_CHAT_COSTS_COMMAND_ID = 'creaeditor.aiCosts.getChatCosts';
/** Workbench command that is told which chats have a new cost; without arguments, any chat may have. */
const DID_CHANGE_CHAT_COSTS_COMMAND_ID = '_creaeditor.chatGatewayCosts.didChange';
/** Beyond this many changed chats the workbench is told that all may have changed. */
const MAX_CHANGED_CHATS = 200;
/** Requests are recorded and then updated with their cost in quick succession. */
const NOTIFY_DELAY = 500;

/**
 * CreaEditor: the cost counter in the chat header. The workbench asks for the cost of the chats it shows
 * with {@link GET_CHAT_COSTS_COMMAND_ID}; this tells it when the ledger changed the cost of a chat, so
 * it asks again. Costs are per main chat, so the requests of its subagents are included.
 */
export class GatewayChatCosts extends Disposable {

	private _costs: Map<string, ICostAggregate>;
	private _dirty = false;
	private readonly _changed = new Set<string>();
	private readonly _notifyScheduler = this._register(new RunOnceScheduler(() => this._notify(), NOTIFY_DELAY));

	constructor(
		@IGatewayTrackingService private readonly _trackingService: IGatewayTrackingService,
	) {
		super();
		this._costs = computeChatCosts(this._trackingService.entries);
		this._register(commands.registerCommand(GET_CHAT_COSTS_COMMAND_ID, (chatIds: unknown) => this._getChatCosts(chatIds)));
		this._register(this._trackingService.onDidChangeEntries(() => {
			this._dirty = true;
			this._notifyScheduler.schedule();
		}));
		// The workbench may have asked before this command existed.
		void this._tellWorkbench(undefined);
	}

	private _getChatCosts(chatIds: unknown): Record<string, ICostAggregate> {
		const result: Record<string, ICostAggregate> = {};
		if (!Array.isArray(chatIds)) {
			return result;
		}
		const costs = this._update();
		for (const chatId of chatIds) {
			const cost = typeof chatId === 'string' ? costs.get(chatId) : undefined;
			if (cost) {
				result[chatId] = cost;
			}
		}
		return result;
	}

	/** Recomputes the costs after the ledger changed and remembers which chats changed. */
	private _update(): Map<string, ICostAggregate> {
		if (this._dirty) {
			const next = computeChatCosts(this._trackingService.entries);
			for (const chatId of getChangedChats(this._costs, next)) {
				this._changed.add(chatId);
			}
			this._costs = next;
			this._dirty = false;
		}
		return this._costs;
	}

	private _notify(): void {
		this._update();
		if (!this._changed.size) {
			return;
		}
		const changed = this._changed.size <= MAX_CHANGED_CHATS ? [...this._changed] : undefined;
		this._changed.clear();
		void this._tellWorkbench(changed);
	}

	private async _tellWorkbench(chatIds: readonly string[] | undefined): Promise<void> {
		try {
			await commands.executeCommand(DID_CHANGE_CHAT_COSTS_COMMAND_ID, chatIds);
		} catch {
			// A workbench without the chat cost counter.
		}
	}
}
