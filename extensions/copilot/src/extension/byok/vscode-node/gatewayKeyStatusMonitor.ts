/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { window } from 'vscode';
import { GatewayKind, normalizeGatewayRoot } from '../../../platform/endpoint/common/gatewayTracking';
import { IGatewayTrackingService } from '../../../platform/endpoint/common/gatewayTrackingService';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IntervalTimer, RunOnceScheduler } from '../../../util/vs/base/common/async';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { formatUsd, IGatewayKeyStatus, parseLiteLLMKeyInfo, parseOpenRouterCredits, parseOpenRouterKey } from '../common/gatewayKeyStatus';

/** How often the keys are read while the window has focus. */
const POLL_INTERVAL = 5 * 60_000;
/** The gateway updates the spend of a key a little after a request. */
const AFTER_REQUEST_DELAY = 10_000;
/** Requests read the keys again at most this often. */
const MIN_REFRESH_GAP = 60_000;

interface ITrackedKey {
	readonly gateway: GatewayKind;
	readonly group: string;
	readonly apiKey: string;
	/** OpenRouter API base or LiteLLM proxy root. */
	readonly root: string;
}

/** What a provider shows of the status of one of its keys. */
export interface IProviderGroupStatus {
	/** Short text next to the key in the model picker, e.g. "$12.40 left of $50". */
	readonly detail: string;
	/** Text for the model hover, e.g. "Work key: $12.40 left of $50". */
	readonly info: string;
}

function keyId(gateway: GatewayKind, group: string): string {
	return `${gateway}\u0000${group}`;
}

/** The short text of a key status, e.g. "$12.40 left of $50" or "$3.10 spent this month"; `undefined` without a reading. */
export function formatKeyStatusDetail(status: IGatewayKeyStatus | undefined): string | undefined {
	if (!status) {
		return undefined;
	}
	if (status.limit !== undefined && status.remaining !== undefined) {
		return l10n.t('{0} left of {1}', formatUsd(status.remaining), formatUsd(status.limit));
	}
	if (status.spentThisMonth !== undefined) {
		return l10n.t('{0} spent this month', formatUsd(status.spentThisMonth));
	}
	if (status.spent !== undefined) {
		return l10n.t('{0} spent', formatUsd(status.spent));
	}
	return undefined;
}

/**
 * CreaEditor: reads the limit and balance of every OpenRouter and LiteLLM key the providers list models
 * for, every few minutes while the window has focus and shortly after requests. Readings are kept in
 * memory only; keys are never logged. Model listing never waits for a reading.
 */
export class GatewayKeyStatusMonitor extends Disposable {

	private readonly _keys = new Map<string, ITrackedKey>();
	private readonly _statuses = new Map<string, IGatewayKeyStatus>();
	private readonly _reading = new Map<string, Promise<void>>();
	/** The detail each key last showed in the model picker. */
	private readonly _shownDetails = new Map<string, string | undefined>();
	private _lastRefresh = 0;

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when a reading changed. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _onDidChangeDetail = this._register(new Emitter<GatewayKind>());
	/** Fires with the gateway whose models show an outdated key status. */
	readonly onDidChangeDetail: Event<GatewayKind> = this._onDidChangeDetail.event;

	private readonly _poll = this._register(new IntervalTimer());
	private readonly _afterRequest = this._register(new RunOnceScheduler(() => void this.refresh(), AFTER_REQUEST_DELAY));

	constructor(
		@IFetcherService private readonly _fetcherService: IFetcherService,
		@ILogService private readonly _logService: ILogService,
		@IGatewayTrackingService trackingService: IGatewayTrackingService,
	) {
		super();
		this._register(trackingService.onDidChangeEntries(() => {
			if (this._keys.size && !this._afterRequest.isScheduled()) {
				this._afterRequest.schedule(Math.max(AFTER_REQUEST_DELAY, MIN_REFRESH_GAP - (Date.now() - this._lastRefresh)));
			}
		}));
		this._register(window.onDidChangeWindowState(state => {
			if (state.focused && this._keys.size && Date.now() - this._lastRefresh > POLL_INTERVAL) {
				void this.refresh();
			}
		}));
	}

	/**
	 * Reads the status of a key from now on and returns what its models show of it, if known yet.
	 * @param group provider group name; `undefined` for a key without a group
	 * @param url the OpenRouter API base or the LiteLLM proxy URL
	 */
	present(gateway: GatewayKind, group: string | undefined, apiKey: string | undefined, url: string | undefined): IProviderGroupStatus | undefined {
		const name = group ?? '';
		const id = keyId(gateway, name);
		if (!apiKey || !url) {
			return undefined;
		}
		const root = gateway === 'openrouter' ? url.replace(/\/+$/, '') : normalizeGatewayRoot(url);
		const known = this._keys.get(id);
		if (!known || known.apiKey !== apiKey || known.root !== root) {
			this._keys.set(id, { gateway, group: name, apiKey, root });
			if (known) {
				this._statuses.delete(id);
			}
			void this._read(id);
			if (this._keys.size === 1) {
				this._poll.cancelAndSet(() => {
					if (window.state.focused) {
						void this.refresh();
					}
				}, POLL_INTERVAL);
			}
		}
		const detail = formatKeyStatusDetail(this._statuses.get(id));
		this._shownDetails.set(id, detail);
		if (!detail) {
			return undefined;
		}
		return { detail, info: name ? l10n.t('{0}: {1}', name, detail) : detail };
	}

	/** The readings of all keys, sorted by gateway and key name. */
	getStatuses(): IGatewayKeyStatus[] {
		return [...this._statuses.values()].sort((a, b) => a.gateway.localeCompare(b.gateway) || a.group.localeCompare(b.group));
	}

	/** Reads all keys again. */
	async refresh(): Promise<void> {
		this._lastRefresh = Date.now();
		await Promise.all([...this._keys.keys()].map(id => this._read(id)));
	}

	private _read(id: string): Promise<void> {
		let reading = this._reading.get(id);
		if (!reading) {
			reading = this._readKey(id).finally(() => this._reading.delete(id));
			this._reading.set(id, reading);
		}
		return reading;
	}

	private async _readKey(id: string): Promise<void> {
		const key = this._keys.get(id);
		if (!key) {
			return;
		}
		let host: string | undefined;
		try {
			host = new URL(key.root).host;
		} catch {
			host = undefined;
		}
		const previous = this._statuses.get(id);
		let status: IGatewayKeyStatus;
		try {
			const reading = key.gateway === 'openrouter' ? await this._readOpenRouter(key) : await this._readLiteLLM(key);
			status = { gateway: key.gateway, group: key.group, host, ...reading, updatedAt: Date.now() };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._logService.trace(`[GatewayKeyStatus] Could not read the ${key.gateway} key ${key.group}: ${message}`);
			status = { ...previous, gateway: key.gateway, group: key.group, host, error: message, updatedAt: Date.now() };
		}
		if (this._keys.get(id) !== key) {
			return; // The key changed while it was read.
		}
		this._statuses.set(id, status);
		if (!previous || JSON.stringify({ ...previous, updatedAt: 0 }) !== JSON.stringify({ ...status, updatedAt: 0 })) {
			this._onDidChange.fire();
		}
		if (this._shownDetails.has(id) && this._shownDetails.get(id) !== formatKeyStatusDetail(status)) {
			this._onDidChangeDetail.fire(key.gateway);
		}
	}

	private async _getJson(url: string, apiKey: string, callSite: string): Promise<unknown> {
		const response = await this._fetcherService.fetch(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			callSite,
		});
		if (!response.ok) {
			throw new Error(l10n.t('The gateway answered with HTTP {0}.', response.status));
		}
		return response.json();
	}

	private async _readOpenRouter(key: ITrackedKey): Promise<Omit<IGatewayKeyStatus, 'gateway' | 'group' | 'updatedAt'>> {
		const [keyInfo, credits] = await Promise.all([
			this._getJson(`${key.root}/key`, key.apiKey, 'creaeditor-openrouter-key'),
			// The account balance needs a key that may read it; without it only the key is shown.
			this._getJson(`${key.root}/credits`, key.apiKey, 'creaeditor-openrouter-credits').catch(() => undefined),
		]);
		const reading = parseOpenRouterKey(keyInfo);
		if (!reading) {
			throw new Error(l10n.t('The gateway did not report the limit of the key.'));
		}
		return { ...reading, credits: parseOpenRouterCredits(credits) };
	}

	private async _readLiteLLM(key: ITrackedKey): Promise<Omit<IGatewayKeyStatus, 'gateway' | 'group' | 'updatedAt'>> {
		const reading = parseLiteLLMKeyInfo(await this._getJson(`${key.root}/key/info`, key.apiKey, 'creaeditor-litellm-key-info'));
		if (!reading) {
			throw new Error(l10n.t('The gateway did not report the budget of the key.'));
		}
		return reading;
	}
}
