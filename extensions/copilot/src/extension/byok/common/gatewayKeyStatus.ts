/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the limit and balance of an OpenRouter or LiteLLM key as the gateway reports it
// (OpenRouter `GET /api/v1/key` and `GET /api/v1/credits`, LiteLLM `GET /key/info`). Pure, so it can be unit tested.

import { GatewayKind } from '../../../platform/endpoint/common/gatewayTracking';

/** How often the limit of a key resets, as far as the gateway says. */
export type GatewayKeyReset = 'daily' | 'weekly' | 'monthly' | 'never';

/** The limit and spend of one key (provider group). Amounts are in USD. */
export interface IGatewayKeyStatus {
	readonly gateway: GatewayKind;
	/** Provider group (key) name; `''` for a key without a group. */
	readonly group: string;
	/** Host of the gateway, e.g. `openrouter.ai`. */
	readonly host?: string;
	/** The name the gateway knows the key by (OpenRouter label, LiteLLM key alias). */
	readonly label?: string;
	readonly limit?: number;
	readonly remaining?: number;
	readonly reset?: GatewayKeyReset;
	/** LiteLLM budget duration as configured, e.g. `30d`, when it is not a plain day, week or month. */
	readonly resetDuration?: string;
	/** Epoch milliseconds of the next reset, when known. */
	readonly resetAt?: number;
	/** Spend of the key: all time (OpenRouter) or since the last budget reset (LiteLLM). */
	readonly spent?: number;
	readonly spentToday?: number;
	readonly spentThisWeek?: number;
	readonly spentThisMonth?: number;
	readonly freeTier?: boolean;
	/** The balance of the OpenRouter account, when the key may read it. */
	readonly credits?: { readonly total: number; readonly used: number };
	/** Why the status could not be read; the other fields are from an earlier reading, if any. */
	readonly error?: string;
	/** Epoch milliseconds of the reading. */
	readonly updatedAt: number;
}

type Reading = Omit<IGatewayKeyStatus, 'gateway' | 'group' | 'host' | 'updatedAt' | 'error'>;

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function dataOf(json: unknown, field: string): Record<string, unknown> | undefined {
	const data = json && typeof json === 'object' ? (json as Record<string, unknown>)[field] : undefined;
	return data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
}

function parseOpenRouterReset(value: unknown): GatewayKeyReset | undefined {
	return value === 'daily' || value === 'weekly' || value === 'monthly' ? value : undefined;
}

/** Reads an OpenRouter `GET /api/v1/key` response (`{ data: { limit, limit_remaining, limit_reset, usage, usage_daily, ... } }`). */
export function parseOpenRouterKey(json: unknown): Reading | undefined {
	const data = dataOf(json, 'data');
	if (!data) {
		return undefined;
	}
	const limit = num(data.limit);
	const spent = num(data.usage);
	const reset = parseOpenRouterReset(data.limit_reset) ?? (limit !== undefined ? 'never' : undefined);
	const spentForLimit = reset === 'daily' ? num(data.usage_daily) : reset === 'weekly' ? num(data.usage_weekly) : reset === 'monthly' ? num(data.usage_monthly) : spent;
	return {
		label: str(data.label),
		limit,
		remaining: num(data.limit_remaining) ?? (limit !== undefined && spentForLimit !== undefined ? Math.max(0, limit - spentForLimit) : undefined),
		reset,
		spent,
		spentToday: num(data.usage_daily),
		spentThisWeek: num(data.usage_weekly),
		spentThisMonth: num(data.usage_monthly),
		freeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : undefined,
	};
}

/** Reads an OpenRouter `GET /api/v1/credits` response (`{ data: { total_credits, total_usage } }`). */
export function parseOpenRouterCredits(json: unknown): IGatewayKeyStatus['credits'] {
	const data = dataOf(json, 'data');
	const total = num(data?.total_credits);
	const used = num(data?.total_usage);
	return total !== undefined && used !== undefined ? { total, used } : undefined;
}

function parseLiteLLMDuration(value: string | undefined): GatewayKeyReset | undefined {
	switch (value) {
		case '1d': case '24h': return 'daily';
		case '7d': case '1w': return 'weekly';
		case '30d': case '1mo': return 'monthly';
		default: return undefined;
	}
}

/** Reads a LiteLLM `GET /key/info` response (`{ key, info: { spend, max_budget, budget_duration, budget_reset_at, key_alias } }`). */
export function parseLiteLLMKeyInfo(json: unknown): Reading | undefined {
	const info = dataOf(json, 'info');
	if (!info) {
		return undefined;
	}
	const limit = num(info.max_budget);
	const spent = num(info.spend);
	const duration = str(info.budget_duration);
	const resetAt = str(info.budget_reset_at) ? Date.parse(info.budget_reset_at as string) : undefined;
	const reset = parseLiteLLMDuration(duration) ?? (limit !== undefined && !duration ? 'never' : undefined);
	return {
		label: str(info.key_alias) ?? str(info.key_name),
		limit,
		remaining: limit !== undefined && spent !== undefined ? Math.max(0, limit - spent) : undefined,
		reset,
		resetDuration: duration && !parseLiteLLMDuration(duration) ? duration : undefined,
		resetAt: resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined,
		spent,
	};
}

/** The share of the limit of a key that is used, 0 to 1, when the key has a limit. */
export function getKeyUsedShare(status: Pick<IGatewayKeyStatus, 'limit' | 'remaining'>): number | undefined {
	if (status.limit === undefined || status.remaining === undefined || status.limit <= 0) {
		return undefined;
	}
	return Math.min(1, Math.max(0, 1 - status.remaining / status.limit));
}

/** Formats a dollar amount: whole dollars without cents, otherwise with cents. */
export function formatUsd(value: number): string {
	return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}
