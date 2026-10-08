/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Keys and Budgets sections at the top of the AI Costs page. Keys shows the limit and
// spend every OpenRouter and LiteLLM key reports; Budgets shows the spend of the user's budgets from
// the ledger. Budgets are added and edited with quick picks run by the extension.

import * as l10n from '@vscode/l10n';
import { ICostBudgetStatus } from '../common/gatewayCostsAnalysis';
import { escapeHtml } from './gatewayCostsAdvancedView';

/** A budget status as the page shows it. */
export interface IBudgetSnapshot {
	readonly id: string;
	readonly scope: string;
	readonly value: string;
	readonly amount: number;
	readonly period: string;
	readonly hardStop: boolean;
	readonly spent: number;
	readonly share: number;
	readonly to: number;
}

/** The budget statuses for the page. */
export function toBudgetSnapshots(statuses: readonly ICostBudgetStatus[]): IBudgetSnapshot[] {
	return statuses.map(({ budget, spent, share, to }) => ({ id: budget.id, scope: budget.scope, value: budget.value, amount: budget.amount, period: budget.period, hardStop: budget.hardStop, spent, share, to }));
}

/** The localized strings of the Keys and Budgets sections, merged into the page's `S` object. */
export function getKeysStrings() {
	return {
		keysTitle: l10n.t('Keys'),
		keysRefresh: l10n.t('Refresh'),
		keysEmpty: l10n.t('No OpenRouter or LiteLLM keys read yet. Keys are read once their models are listed in the model picker.'),
		keysUpdated: l10n.t('Read at {0}'),
		keysNoName: l10n.t('Default key'),
		keysLimit: l10n.t('Limit'),
		keysRemaining: l10n.t('Remaining'),
		keysNoLimit: l10n.t('No limit'),
		keysReset: l10n.t('Resets'),
		keysReset_daily: l10n.t('Daily'),
		keysReset_weekly: l10n.t('Weekly'),
		keysReset_monthly: l10n.t('Monthly'),
		keysReset_never: l10n.t('Never'),
		keysResetAt: l10n.t('on {0}'),
		keysSpentToday: l10n.t('Today'),
		keysSpentWeek: l10n.t('This week'),
		keysSpentMonth: l10n.t('This month'),
		keysSpentTotal: l10n.t('Spent'),
		keysCredits: l10n.t('Account balance'),
		keysCreditsValue: l10n.t('{0} of {1} left'),
		keysLeftOf: l10n.t('{0} left of {1}'),
		keysError: l10n.t('Could not read the key: {0}'),
		keysFreeTier: l10n.t('Free tier'),
		budgetsTitle: l10n.t('Budgets'),
		budgetsAdd: l10n.t('Add Budget'),
		budgetsEdit: l10n.t('Edit'),
		budgetsRemove: l10n.t('Remove'),
		budgetsEmpty: l10n.t('No budgets yet. Add one to be warned, or stopped, when a key, issue or repository spends too much.'),
		budgetsScope_key: l10n.t('Key'),
		budgetsScope_issue: l10n.t('Issue'),
		budgetsScope_repo: l10n.t('Repository'),
		budgetsPeriod_day: l10n.t('per day'),
		budgetsPeriod_week: l10n.t('per week'),
		budgetsPeriod_month: l10n.t('per month'),
		budgetsSpent: l10n.t('{0} of {1} {2}'),
		budgetsHardStop: l10n.t('Hard stop'),
		budgetsHardStopHover: l10n.t('Requests are refused once the budget is used up.'),
		budgetsUsedUp: l10n.t('Used up'),
		budgetsStartsOver: l10n.t('starts over {0}'),
	};
}

/** The markup of the Keys and Budgets sections. */
export function getKeysMarkup(s: ReturnType<typeof getKeysStrings>): string {
	const e = escapeHtml;
	return `<section class="subs keys" aria-labelledby="keys-title">
	<div class="subs-head">
		<h2 id="keys-title">${e(s.keysTitle)}</h2>
		<span id="keys-updated" class="muted"></span>
		<span class="spacer"></span>
		<button type="button" id="keys-refresh">${e(s.keysRefresh)}</button>
	</div>
	<div id="keys-body" aria-live="polite"></div>
</section>
<section class="subs budgets" aria-labelledby="budgets-title">
	<div class="subs-head">
		<h2 id="budgets-title">${e(s.budgetsTitle)}</h2>
		<span class="spacer"></span>
		<button type="button" id="budgets-add">${e(s.budgetsAdd)}</button>
	</div>
	<div id="budgets-body" aria-live="polite"></div>
</section>`;
}

/** Styles of the Keys and Budgets sections; they reuse the Subscriptions styles for the frame and meters. */
export const KEYS_STYLES = `
	.key-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 12px; }
	.key-card { border: var(--vscode-strokeThickness, 1px) solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: var(--vscode-cornerRadius-medium, 6px); padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
	.key-head { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
	.key-name { font-weight: var(--vscode-fontWeight-semiBold, 600); }
	.key-gateway, .key-facts dt { color: var(--vscode-descriptionForeground); font-size: var(--vscode-fontSize-body2, 11px); }
	.key-left { font-variant-numeric: tabular-nums; }
	.key-facts { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; }
	.key-facts dd { margin: 0; font-variant-numeric: tabular-nums; }
	.key-error { color: var(--vscode-errorForeground); font-size: var(--vscode-fontSize-body2, 11px); overflow-wrap: anywhere; }
	.budget-rows { display: flex; flex-direction: column; gap: 10px; }
	.budget-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: center; }
	.budget-name { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
	.budget-scope { color: var(--vscode-descriptionForeground); font-size: var(--vscode-fontSize-body2, 11px); }
	.budget-spent { font-variant-numeric: tabular-nums; font-size: var(--vscode-fontSize-body2, 11px); }
	.budget-actions { display: flex; gap: 6px; grid-row: span 2; }
	.budget-flag { font-size: var(--vscode-fontSize-body2, 11px); color: var(--vscode-descriptionForeground); }
	.budget-flag.used-up { color: var(--vscode-errorForeground); }
`;

/** The script of the Keys and Budgets sections. It runs after the other scripts and reuses `vscode`, `S`, `$`, `esc`, `fmt` and `money`. */
export const KEYS_SCRIPT = String.raw`
let keyStatuses;
let budgetStatuses;
const usd = v => v === undefined ? '–' : '$' + (Number.isInteger(v) ? String(v) : v.toFixed(2));
function meter(share) {
	const used = Math.max(0, Math.min(100, Math.round(share * 100)));
	// SVG attributes, since the page's content security policy blocks inline styles.
	return '<svg class="meter' + (used >= 100 ? ' full' : used >= 80 ? ' high' : '') + '" width="100%" height="4" aria-hidden="true"><rect class="track" width="100%" height="4" rx="2"/><rect class="fill" width="' + used + '%" height="4" rx="2"/></svg>';
}
function renderKeys() {
	const body = $('keys-body');
	if (!keyStatuses) { return; }
	if (!keyStatuses.length) { body.innerHTML = '<div class="subs-empty">' + esc(S.keysEmpty) + '</div>'; $('keys-updated').textContent = ''; return; }
	const updated = Math.max(0, ...keyStatuses.map(k => k.updatedAt || 0));
	$('keys-updated').textContent = updated ? fmt(S.keysUpdated, new Date(updated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })) : '';
	body.innerHTML = '<div class="key-cards">' + keyStatuses.map(k => {
		const hasLimit = k.limit !== undefined && k.remaining !== undefined;
		const facts = [];
		facts.push([S.keysLimit, k.limit !== undefined ? usd(k.limit) : S.keysNoLimit]);
		if (hasLimit) { facts.push([S.keysRemaining, usd(k.remaining)]); }
		if (k.reset || k.resetDuration || k.resetAt) {
			const period = k.reset ? S['keysReset_' + k.reset] : k.resetDuration || '';
			const at = k.resetAt ? fmt(S.keysResetAt, new Date(k.resetAt).toLocaleDateString()) : '';
			facts.push([S.keysReset, [period, at].filter(Boolean).join(' ')]);
		}
		if (k.spentToday !== undefined) { facts.push([S.keysSpentToday, usd(k.spentToday)]); }
		if (k.spentThisWeek !== undefined) { facts.push([S.keysSpentWeek, usd(k.spentThisWeek)]); }
		if (k.spentThisMonth !== undefined) { facts.push([S.keysSpentMonth, usd(k.spentThisMonth)]); }
		if (k.spent !== undefined) { facts.push([S.keysSpentTotal, usd(k.spent)]); }
		if (k.credits) { facts.push([S.keysCredits, fmt(S.keysCreditsValue, usd(Math.max(0, k.credits.total - k.credits.used)), usd(k.credits.total))]); }
		const gateway = (k.gateway === 'openrouter' ? 'OpenRouter' : 'LiteLLM') + (k.host ? ' · ' + k.host : '');
		return '<div class="key-card"><div class="key-head"><span class="key-name">' + esc(k.group || k.label || S.keysNoName) + '</span>'
			+ '<span class="key-gateway">' + esc(gateway) + '</span>'
			+ (k.freeTier ? '<span class="badge">' + esc(S.keysFreeTier) + '</span>' : '')
			+ '<span class="spacer"></span>'
			+ (hasLimit ? '<span class="key-left">' + esc(fmt(S.keysLeftOf, usd(k.remaining), usd(k.limit))) + '</span>' : '') + '</div>'
			+ (hasLimit && k.limit > 0 ? meter(1 - k.remaining / k.limit) : '')
			+ '<dl class="key-facts">' + facts.map(([label, value]) => '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>').join('') + '</dl>'
			+ (k.error ? '<div class="key-error">' + esc(fmt(S.keysError, k.error)) + '</div>' : '')
			+ '</div>';
	}).join('') + '</div>';
}
function renderBudgets() {
	const body = $('budgets-body');
	if (!budgetStatuses) { return; }
	if (!budgetStatuses.length) { body.innerHTML = '<div class="subs-empty">' + esc(S.budgetsEmpty) + '</div>'; return; }
	body.innerHTML = '<div class="budget-rows">' + budgetStatuses.map(b => {
		const usedUp = b.spent >= b.amount;
		return '<div class="budget-row"><div class="budget-name"><span class="budget-scope">' + esc(S['budgetsScope_' + b.scope] || b.scope) + '</span><span>' + esc(b.value) + '</span>'
			+ '<span class="budget-spent">' + esc(fmt(S.budgetsSpent, usd(b.spent), usd(b.amount), S['budgetsPeriod_' + b.period] || b.period)) + '</span>'
			+ (usedUp ? '<span class="budget-flag used-up">' + esc(S.budgetsUsedUp) + '</span>' : '')
			+ (b.hardStop ? '<span class="budget-flag" title="' + esc(S.budgetsHardStopHover) + '">' + esc(S.budgetsHardStop) + '</span>' : '')
			+ '<span class="budget-flag">' + esc(fmt(S.budgetsStartsOver, new Date(b.to).toLocaleDateString())) + '</span></div>'
			+ '<div class="budget-actions"><button type="button" data-budget-edit="' + esc(b.id) + '">' + esc(S.budgetsEdit) + '</button><button type="button" data-budget-remove="' + esc(b.id) + '">' + esc(S.budgetsRemove) + '</button></div>'
			+ meter(b.share) + '</div>';
	}).join('') + '</div>';
}
$('keys-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshKeys' }));
$('budgets-add').addEventListener('click', () => vscode.postMessage({ type: 'addBudget' }));
$('budgets-body').addEventListener('click', event => {
	const target = event.target instanceof Element ? event.target.closest('button') : null;
	if (target?.dataset.budgetEdit) { vscode.postMessage({ type: 'editBudget', id: target.dataset.budgetEdit }); }
	if (target?.dataset.budgetRemove) { vscode.postMessage({ type: 'removeBudget', id: target.dataset.budgetRemove }); }
});
window.addEventListener('message', event => {
	if (event.data?.type === 'keys') { keyStatuses = event.data.statuses; renderKeys(); }
	if (event.data?.type === 'budgets') { budgetStatuses = event.data.statuses; renderBudgets(); }
});
`;
