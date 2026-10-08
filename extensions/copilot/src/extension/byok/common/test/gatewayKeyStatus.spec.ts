/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { getKeyUsedShare, parseLiteLLMKeyInfo, parseOpenRouterCredits, parseOpenRouterKey } from '../gatewayKeyStatus';

describe('gateway key status', () => {
	it('reads an OpenRouter key with a monthly limit', () => {
		expect(parseOpenRouterKey({ data: { label: 'sk-or-v1-abc...xyz', limit: 50, limit_remaining: 12.4, limit_reset: 'monthly', usage: 120.5, usage_daily: 1.5, usage_weekly: 9, usage_monthly: 37.6, is_free_tier: false } })).toEqual({
			label: 'sk-or-v1-abc...xyz', limit: 50, remaining: 12.4, reset: 'monthly', spent: 120.5, spentToday: 1.5, spentThisWeek: 9, spentThisMonth: 37.6, freeTier: false,
		});
	});

	it('reads an OpenRouter key without a limit or with missing fields', () => {
		expect(parseOpenRouterKey({ data: { limit: null, limit_remaining: null, limit_reset: null, usage: 3.1 } })).toEqual({
			label: undefined, limit: undefined, remaining: undefined, reset: undefined, spent: 3.1, spentToday: undefined, spentThisWeek: undefined, spentThisMonth: undefined, freeTier: undefined,
		});
		// Older responses without `limit_remaining`: the remaining limit is derived from the usage.
		expect(parseOpenRouterKey({ data: { limit: 20, usage: 5 } })?.remaining).toBe(15);
		expect(parseOpenRouterKey({ error: { code: 401 } })).toBeUndefined();
	});

	it('reads the OpenRouter account credits', () => {
		expect(parseOpenRouterCredits({ data: { total_credits: 100, total_usage: 42.5 } })).toEqual({ total: 100, used: 42.5 });
		expect(parseOpenRouterCredits({ data: {} })).toBeUndefined();
	});

	it('reads a LiteLLM key', () => {
		const resetAt = '2026-11-01T00:00:00Z';
		expect(parseLiteLLMKeyInfo({ key: 'hashed', info: { key_alias: 'work', spend: 37.5, max_budget: 50, budget_duration: '30d', budget_reset_at: resetAt } })).toEqual({
			label: 'work', limit: 50, remaining: 12.5, reset: 'monthly', resetDuration: undefined, resetAt: Date.parse(resetAt), spent: 37.5,
		});
		expect(parseLiteLLMKeyInfo({ info: { spend: 3.1, max_budget: null, budget_duration: null } })).toEqual({
			label: undefined, limit: undefined, remaining: undefined, reset: undefined, resetDuration: undefined, resetAt: undefined, spent: 3.1,
		});
		expect(parseLiteLLMKeyInfo({ info: { spend: 1, max_budget: 10, budget_duration: '2d' } })).toMatchObject({ reset: undefined, resetDuration: '2d', remaining: 9 });
		expect(parseLiteLLMKeyInfo({ detail: 'Not allowed' })).toBeUndefined();
	});

	it('computes the used share of the limit', () => {
		expect([getKeyUsedShare({ limit: 50, remaining: 12.5 }), getKeyUsedShare({ limit: 50, remaining: 60 }), getKeyUsedShare({}), getKeyUsedShare({ limit: 0, remaining: 0 })]).toEqual([0.75, 0, undefined, undefined]);
	});
});
