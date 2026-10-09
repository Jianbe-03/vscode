/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Subscriptions section at the top of the AI Costs page: the usage of the pooled Claude
// and Codex subscription accounts next to the gateway costs. The workbench owns the accounts; the page
// reads them with the internal `creaeditor.subscriptionAccounts.getState` command (no tokens in there).

import * as l10n from '@vscode/l10n';
import { escapeHtml } from './gatewayCostsAdvancedView';

/** Internal workbench command returning an {@link ISubscriptionAccountsSnapshot}. */
export const GET_SUBSCRIPTION_ACCOUNTS_STATE_COMMAND_ID = 'creaeditor.subscriptionAccounts.getState';
/** Internal workbench command that asks for new usage readings. */
export const REFRESH_SUBSCRIPTION_USAGE_COMMAND_ID = 'creaeditor.subscriptionAccounts.refreshUsage';
/** Workbench command that opens the Subscription Usage page. */
export const SHOW_SUBSCRIPTION_USAGE_COMMAND_ID = 'workbench.action.chat.showSubscriptionUsage';
/** Workbench commands that add a Claude or Codex subscription account. */
export const ADD_SUBSCRIPTION_ACCOUNT_COMMAND_IDS = {
	claude: 'workbench.action.chat.addClaudeAccount',
	codex: 'workbench.action.chat.addCodexAccount',
} as const;

/** One usage window of an account, such as the 5-hour or the weekly limit. */
interface ISubscriptionUsageWindow {
	readonly label: string;
	/** 0-100. */
	readonly usedPercent: number;
	/** Epoch milliseconds. */
	readonly resetsAt?: number;
}

interface ISubscriptionAccountInfo {
	readonly id: string;
	readonly provider: string;
	readonly label: string;
	readonly status: 'signedIn' | 'signedOut' | 'signingIn' | 'limited' | 'error';
	readonly email?: string;
	readonly planType?: string;
	readonly usage?: readonly ISubscriptionUsageWindow[];
	readonly usageUpdatedAt?: number;
	readonly limitedUntil?: number;
	readonly error?: string;
}

interface ISubscriptionPoolInfo {
	readonly provider: string;
	readonly remainingPercent?: number;
	readonly available: number;
	readonly total: number;
	readonly earliestResetAt?: number;
}

/** The subscription accounts as the workbench hands them to the page. */
export interface ISubscriptionAccountsSnapshot {
	readonly accounts: readonly ISubscriptionAccountInfo[];
	readonly pools: readonly ISubscriptionPoolInfo[];
}

/** Returns the snapshot when the command result has its shape, otherwise `undefined`. */
export function toSubscriptionAccountsSnapshot(value: unknown): ISubscriptionAccountsSnapshot | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const { accounts, pools } = value as Partial<ISubscriptionAccountsSnapshot>;
	return Array.isArray(accounts) && Array.isArray(pools) ? { accounts, pools } : undefined;
}

/** The localized strings of the Subscriptions section, merged into the page's `S` object. */
export function getSubscriptionsStrings() {
	return {
		subsTitle: l10n.t('Subscriptions'),
		subsRefresh: l10n.t('Refresh Usage'),
		subsOpen: l10n.t('Show Subscription Usage'),
		subsUpdated: l10n.t('Usage read at {0}'),
		subsEmpty: l10n.t('No Claude or Codex subscription accounts yet. Add one to run chats on your subscription.'),
		subsAddClaude: l10n.t('Add Claude Account'),
		subsAddCodex: l10n.t('Add Codex Account'),
		subsUnavailable: l10n.t('Subscription accounts are not available in this window.'),
		subsProvider_claude: l10n.t('Claude'),
		subsProvider_codex: l10n.t('Codex'),
		subsLeft: l10n.t('{0}% left'),
		subsNoReading: l10n.t('No usage reading yet'),
		subsAvailableOne: l10n.t('{0} of 1 account available'),
		subsAvailable: l10n.t('{0} of {1} accounts available'),
		subsFirstReset: l10n.t('first reset in {0}'),
		subsAccount: l10n.t('Account'),
		subsPlan: l10n.t('Plan'),
		subsUsage: l10n.t('Usage'),
		subsStatus: l10n.t('Status'),
		subsUsed: l10n.t('{0}: {1}% used'),
		subsResetsIn: l10n.t('resets in {0}'),
		subsResetsNow: l10n.t('resets now'),
		subsStatus_signedIn: l10n.t('Signed in'),
		subsStatus_signedOut: l10n.t('Signed out'),
		subsStatus_signingIn: l10n.t('Signing in'),
		subsStatus_limited: l10n.t('Used up'),
		subsStatus_error: l10n.t('Error'),
		subsLimitedUntil: l10n.t('Used up until {0}'),
		durationMinutes: l10n.t('{0}m'),
		durationHoursMinutes: l10n.t('{0}h {1}m'),
		durationHours: l10n.t('{0}h'),
		durationDaysHours: l10n.t('{0}d {1}h'),
		durationDays: l10n.t('{0}d'),
	};
}

/** The markup of the Subscriptions section. */
export function getSubscriptionsMarkup(s: ReturnType<typeof getSubscriptionsStrings>): string {
	const e = escapeHtml;
	return `<section class="subs" aria-labelledby="subs-title">
	<div class="subs-head">
		<h2 id="subs-title">${e(s.subsTitle)}</h2>
		<span id="subs-updated" class="muted"></span>
		<span class="spacer"></span>
		<button type="button" id="subs-refresh">${e(s.subsRefresh)}</button>
		<button type="button" id="subs-open">${e(s.subsOpen)}</button>
	</div>
	<div id="subs-body" aria-live="polite"></div>
</section>`;
}

/** Styles of the Subscriptions section. */
export const SUBSCRIPTIONS_STYLES = `
	.subs { border: var(--vscode-strokeThickness, 1px) solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: var(--vscode-cornerRadius-large, 8px); padding: 12px 16px; margin-bottom: 20px; }
	.subs-head { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-bottom: 8px; }
	.subs-head h2 { font-size: var(--vscode-fontSize-heading3, 13px); font-weight: var(--vscode-fontWeight-semiBold, 600); margin: 0; }
	.subs-empty { color: var(--vscode-descriptionForeground); }
	.subs-add { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
	.pools { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 12px 24px; }
	.pool-head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; margin-bottom: 4px; }
	.pool-name { font-weight: var(--vscode-fontWeight-semiBold, 600); }
	.pool-left { font-variant-numeric: tabular-nums; }
	.accounts { width: 100%; border-collapse: collapse; }
	.accounts th, .accounts td { padding: 6px 8px 6px 0; }
	.accounts td { vertical-align: top; }
	.account-email, .account-error { color: var(--vscode-descriptionForeground); font-size: var(--vscode-fontSize-body2, 11px); overflow-wrap: anywhere; }
	.account-error { color: var(--vscode-errorForeground); }
	.window { display: flex; flex-direction: column; gap: 2px; margin-bottom: 4px; min-width: 160px; }
	.window-text { font-size: var(--vscode-fontSize-body2, 11px); font-variant-numeric: tabular-nums; }
	.meter { display: block; }
	.meter .track { fill: var(--vscode-charts-lines); fill-opacity: 0.2; }
	.meter .fill { fill: var(--vscode-charts-blue); }
	.meter.high .fill { fill: var(--vscode-charts-orange); }
	.meter.full .fill { fill: var(--vscode-charts-red); }
`;

/** The script of the Subscriptions section. It runs after the other scripts and reuses `vscode`, `S`, `$`, `esc` and `fmt`. */
export const SUBSCRIPTIONS_SCRIPT = String.raw`
let subscriptions;
let subscriptionsLoaded = false;
function shortDuration(milliseconds) {
	const minutes = Math.max(1, Math.ceil(milliseconds / 60000));
	if (minutes < 60) { return fmt(S.durationMinutes, minutes); }
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest && hours < 10 ? fmt(S.durationHoursMinutes, hours, rest) : fmt(S.durationHours, hours);
	}
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours ? fmt(S.durationDaysHours, days, restHours) : fmt(S.durationDays, days);
}
function resetsIn(time, now) {
	return time <= now ? S.subsResetsNow : fmt(S.subsResetsIn, shortDuration(time - now));
}
function providerName(provider) {
	return S['subsProvider_' + provider] || provider;
}
function accountStatus(account, now) {
	if (account.status === 'limited' && account.limitedUntil && account.limitedUntil > now) {
		return fmt(S.subsLimitedUntil, new Date(account.limitedUntil).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }));
	}
	return S['subsStatus_' + account.status] || account.status;
}
function renderSubscriptions() {
	const body = $('subs-body');
	const now = Date.now();
	if (!subscriptionsLoaded) { return; }
	if (!subscriptions) { body.innerHTML = '<div class="subs-empty">' + esc(S.subsUnavailable) + '</div>'; $('subs-updated').textContent = ''; $('subs-refresh').hidden = true; return; }
	$('subs-refresh').hidden = false;
	if (!subscriptions.accounts.length) {
		body.innerHTML = '<div class="subs-empty">' + esc(S.subsEmpty) + '</div><div class="subs-add"><button type="button" data-add-account="claude">' + esc(S.subsAddClaude) + '</button><button type="button" data-add-account="codex">' + esc(S.subsAddCodex) + '</button></div>';
		$('subs-updated').textContent = '';
		return;
	}
	const updated = Math.max(0, ...subscriptions.accounts.map(a => a.usageUpdatedAt || 0));
	$('subs-updated').textContent = updated ? fmt(S.subsUpdated, new Date(updated).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })) : '';
	body.innerHTML = '<div class="pools">' + subscriptions.pools.map(pool => {
		const accounts = subscriptions.accounts.filter(a => a.provider === pool.provider);
		const head = '<div class="pool-head"><span class="pool-name">' + esc(providerName(pool.provider)) + '</span>'
			+ '<span class="pool-left">' + esc(pool.remainingPercent === undefined ? S.subsNoReading : fmt(S.subsLeft, pool.remainingPercent)) + '</span>'
			+ '<span class="muted">' + esc(pool.total === 1 ? fmt(S.subsAvailableOne, pool.available) : fmt(S.subsAvailable, pool.available, pool.total)) + '</span>'
			+ (pool.earliestResetAt && pool.earliestResetAt > now ? '<span class="muted">' + esc(fmt(S.subsFirstReset, shortDuration(pool.earliestResetAt - now))) + '</span>' : '')
			+ '</div>';
		const rows = accounts.map(a => {
			const windows = (a.usage || []).map(w => {
				const used = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
				return '<div class="window"><span class="window-text">' + esc(fmt(S.subsUsed, w.label, used)) + (w.resetsAt ? ' · ' + esc(resetsIn(w.resetsAt, now)) : '') + '</span>'
					// SVG attributes, since the page's content security policy blocks inline styles.
					+ '<svg class="meter' + (used >= 100 ? ' full' : used >= 80 ? ' high' : '') + '" width="100%" height="4" aria-hidden="true"><rect class="track" width="100%" height="4" rx="2"/><rect class="fill" width="' + used + '%" height="4" rx="2"/></svg></div>';
			}).join('');
			return '<tr><td><div>' + esc(a.label) + '</div>' + (a.email ? '<div class="account-email">' + esc(a.email) + '</div>' : '') + '</td>'
				+ '<td>' + (a.planType ? esc(a.planType) : '<span class="muted">–</span>') + '</td>'
				+ '<td>' + (windows || '<span class="muted">' + esc(S.subsNoReading) + '</span>') + '</td>'
				+ '<td><div>' + esc(accountStatus(a, now)) + '</div>' + (a.error ? '<div class="account-error">' + esc(a.error) + '</div>' : '') + '</td></tr>';
		}).join('');
		return '<div class="pool">' + head + '<div class="table-wrap"><table class="accounts"><thead><tr><th>' + esc(S.subsAccount) + '</th><th>' + esc(S.subsPlan) + '</th><th>' + esc(S.subsUsage) + '</th><th>' + esc(S.subsStatus) + '</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
	}).join('') + '</div>';
}
$('subs-refresh').addEventListener('click', () => vscode.postMessage({ type: 'refreshSubscriptions' }));
$('subs-open').addEventListener('click', () => vscode.postMessage({ type: 'openSubscriptionUsage' }));
$('subs-body').addEventListener('click', event => {
	const target = event.target instanceof Element ? event.target.closest('button') : null;
	if (target?.dataset.addAccount) { vscode.postMessage({ type: 'addSubscriptionAccount', provider: target.dataset.addAccount }); }
});
window.addEventListener('message', event => {
	if (event.data?.type === 'subscriptions') {
		subscriptions = event.data.state;
		subscriptionsLoaded = true;
		renderSubscriptions();
	}
});
// Keeps "resets in" current between readings.
setInterval(renderSubscriptions, 60000);
`;
