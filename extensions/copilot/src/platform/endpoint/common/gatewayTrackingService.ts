/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServiceIdentifier } from '../../../util/common/services';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { ChatIssueSource, GatewayKind, IChatIssue, IChatWorkContext } from './gatewayTracking';

/** Where the cost of a {@link IGatewayCostEntry} came from. */
export type GatewayCostSource = 'response' | 'header' | 'openrouter-api' | 'litellm-api';

/** One request made through an LLM gateway, with the cost the gateway reported for it. */
export interface IGatewayCostEntry {
	readonly id: string;
	/** Epoch milliseconds. */
	readonly time: number;
	readonly chatId: string;
	readonly rootChatId: string;
	readonly chatTitle?: string;
	readonly issue?: IChatIssue;
	readonly issueSource?: ChatIssueSource;
	readonly repo?: string;
	readonly branch?: string;
	readonly gateway: GatewayKind;
	/** Host of the gateway, e.g. `openrouter.ai` or `litellm.internal:4000`. */
	readonly gatewayHost: string;
	/** BYOK provider group name the model belongs to. */
	readonly providerGroup?: string;
	readonly model: string;
	readonly gatewayRequestId?: string;
	readonly promptTokens?: number;
	readonly completionTokens?: number;
	readonly cachedTokens?: number;
	/** Cost in USD. */
	readonly cost?: number;
	readonly costSource?: GatewayCostSource;
	/**
	 * CreaEditor: the CreaEditor Server that made the request (its name), for requests pulled from a
	 * server's ledger; undefined for requests made on this computer. Never persisted in this computer's
	 * own ledger.
	 */
	readonly source?: string;
}

export type GatewayCostEntryUpdate = Partial<Pick<IGatewayCostEntry, 'gatewayRequestId' | 'promptTokens' | 'completionTokens' | 'cachedTokens' | 'cost' | 'costSource'>>;

/**
 * CreaEditor: costs pulled from CreaEditor Servers, one `<serverId>.json` per server. Written by the
 * Agents window (see `src/vs/sessions/contrib/providers/remoteAgentHost/browser/creaeditorServerCosts.ts`
 * and `CREAEDITOR_SERVER_COSTS_CACHE_FOLDER` in `src/vs/platform/agentHost/common/creaeditorCosts.ts`).
 */
export const SERVER_COSTS_FOLDER = 'creaeditor-server-costs';

/**
 * CreaEditor: the folder of {@link SERVER_COSTS_FOLDER} for an extension whose global storage is at
 * `globalStoragePath` (`<User>/[profiles/<profile>/]globalStorage/<extension>`, a URI path). It is in
 * the default profile's global storage whatever profile the extension runs in (the Agents window
 * runs in a built-in profile), so every window reads the same costs.
 */
export function getServerCostsFolderPath(globalStoragePath: string): string {
	const profile = /^(?<user>.*\/User)\/profiles\/.+\/globalStorage\/[^/]+\/?$/.exec(globalStoragePath);
	const globalStorage = profile?.groups ? `${profile.groups.user}/globalStorage` : globalStoragePath.replace(/\/[^/]+\/?$/, '');
	return `${globalStorage}/${SERVER_COSTS_FOLDER}`;
}

/** CreaEditor: reads one CreaEditor Server's cost cache file; its entries tagged with the server's name. */
export function parseServerCostsFile(content: string): IGatewayCostEntry[] {
	try {
		const value = JSON.parse(content) as { serverName?: unknown; entries?: unknown };
		if (typeof value.serverName !== 'string' || !Array.isArray(value.entries)) {
			return [];
		}
		const source = value.serverName;
		return value.entries
			.filter((entry): entry is IGatewayCostEntry => !!entry && typeof entry.id === 'string' && typeof entry.time === 'number')
			.map(entry => ({ ...entry, source }));
	} catch {
		return [];
	}
}

export const IGatewayTrackingService = createServiceIdentifier<IGatewayTrackingService>('IGatewayTrackingService');

/**
 * CreaEditor: knows which chat and issue a gateway request belongs to and keeps a local ledger of
 * the cost every gateway request reported.
 */
export interface IGatewayTrackingService {
	readonly _serviceBrand: undefined;

	/** Fires when {@link entries} changed. */
	readonly onDidChangeEntries: Event<void>;

	/** All recorded requests, oldest first. */
	readonly entries: readonly IGatewayCostEntry[];

	/**
	 * Returns the work context of a request.
	 * @param chatId the chat session id of the request (the subagent's own id for subagents)
	 * @param rootChatId the top-level chat session id
	 * @param promptText text of the first user message of the request, used for the chat title and issue detection
	 */
	getWorkContext(chatId: string, rootChatId: string, promptText: string | undefined): IChatWorkContext;

	/** Sets the issue a chat works on, overriding any detected issue. `undefined` clears the override. */
	setIssue(chatId: string, issue: IChatIssue | undefined): void;

	/** Records a request; returns its entry id. */
	recordRequest(entry: Omit<IGatewayCostEntry, 'id' | 'time'>): string;

	/** Updates the usage and cost of a recorded request. */
	updateRequest(id: string, update: GatewayCostEntryUpdate): void;

	/** Removes all recorded requests. */
	clear(): void;
}

/** A tracking service that tracks nothing, for contexts without a workspace or storage (tests, web). */
export class NullGatewayTrackingService implements IGatewayTrackingService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeEntries = new Emitter<void>().event;
	readonly entries: readonly IGatewayCostEntry[] = [];

	getWorkContext(chatId: string, rootChatId: string): IChatWorkContext {
		return { chatId, rootChatId };
	}
	setIssue(): void { }
	recordRequest(): string {
		return '';
	}
	updateRequest(): void { }
	clear(): void { }
}
