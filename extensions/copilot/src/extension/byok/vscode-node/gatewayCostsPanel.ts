/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { commands, Uri, ViewColumn, WebviewPanel, window, workspace } from 'vscode';
import { formatIssue, getIssueUrl } from '../../../platform/endpoint/common/gatewayTracking';
import { IGatewayCostEntry, IGatewayTrackingService } from '../../../platform/endpoint/common/gatewayTrackingService';
import { IntervalTimer, RunOnceScheduler } from '../../../util/vs/base/common/async';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { filterCostRows, ICostDataset, ICostFilters, ICostQueryOptions, ICostRow, prepareCostDataset, runCostQuery } from '../common/gatewayCostsAnalysis';
import { ADVANCED_STYLES, escapeHtml, getAdvancedMarkup, getAdvancedScript, getAdvancedStrings } from './gatewayCostsAdvancedView';
import { GatewayBudgets } from './gatewayBudgets';
import { getKeysMarkup, getKeysStrings, KEYS_SCRIPT, KEYS_STYLES, toBudgetSnapshots } from './gatewayCostsKeysView';
import { GatewayKeyStatusMonitor } from './gatewayKeyStatusMonitor';
import { ADD_SUBSCRIPTION_ACCOUNT_COMMAND_IDS, GET_SUBSCRIPTION_ACCOUNTS_STATE_COMMAND_ID, getSubscriptionsMarkup, ISubscriptionAccountsSnapshot, getSubscriptionsStrings, REFRESH_SUBSCRIPTION_USAGE_COMMAND_ID, SHOW_SUBSCRIPTION_USAGE_COMMAND_ID, SUBSCRIPTIONS_SCRIPT, SUBSCRIPTIONS_STYLES, toSubscriptionAccountsSnapshot } from './gatewayCostsSubscriptionsView';

export const SHOW_GATEWAY_COSTS_COMMAND_ID = 'creaeditor.showAiCosts';

/** How often the Subscriptions section reads the accounts again while the page is visible. */
const SUBSCRIPTIONS_POLL_INTERVAL = 30_000;
/** Usage readings arrive a little after a refresh request. */
const SUBSCRIPTIONS_REFRESH_DELAY = 3_000;

type PanelMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'exportCsv' }
	| { readonly type: 'clear' }
	| { readonly type: 'refreshSubscriptions' }
	| { readonly type: 'openSubscriptionUsage' }
	| { readonly type: 'addSubscriptionAccount'; readonly provider: string }
	| { readonly type: 'refreshKeys' }
	| { readonly type: 'addBudget' }
	| { readonly type: 'editBudget'; readonly id: string }
	| { readonly type: 'removeBudget'; readonly id: string }
	| { readonly type: 'query'; readonly seq: number; readonly filters: ICostFilters; readonly options: ICostQueryOptions }
	| { readonly type: 'exportFiltered'; readonly format: 'csv' | 'json'; readonly filters: ICostFilters };

/** Arguments of {@link SHOW_GATEWAY_COSTS_COMMAND_ID}. */
interface IShowGatewayCostsOptions {
	/** Main chat id as recorded in the ledger; the page opens filtered to that chat. */
	readonly chatId?: string;
}

function parseShowOptions(options: unknown): IShowGatewayCostsOptions | undefined {
	const chatId = options && typeof options === 'object' ? (options as IShowGatewayCostsOptions).chatId : undefined;
	return typeof chatId === 'string' && chatId ? { chatId } : undefined;
}

/**
 * CreaEditor: the "AI Costs" page. Shows the cost OpenRouter and LiteLLM reported for every request,
 * grouped per issue and per chat, from the local cost ledger. Its Advanced tab sends `query` messages
 * that are answered here with the analysis of `gatewayCostsAnalysis.ts`.
 */
export class GatewayCostsPanel extends Disposable {

	private _panel: WebviewPanel | undefined;
	private readonly _panelDisposables = this._register(new DisposableStore());
	/** The ledger prepared for queries; reset whenever the ledger changes. */
	private _dataset: ICostDataset | undefined;
	/** Chat to show once a new page is ready. */
	private _pendingChatId: string | undefined;
	private readonly _subscriptionsRefresh = this._register(new RunOnceScheduler(() => this._postSubscriptions(), SUBSCRIPTIONS_REFRESH_DELAY));

	constructor(
		private readonly _keyStatus: GatewayKeyStatusMonitor,
		private readonly _budgets: GatewayBudgets,
		@IGatewayTrackingService private readonly _trackingService: IGatewayTrackingService,
	) {
		super();
		this._register(commands.registerCommand(SHOW_GATEWAY_COSTS_COMMAND_ID, (options: unknown) => this.show(parseShowOptions(options))));
	}

	/** Opens the page; with a chat id, on the Advanced tab filtered to that chat (subagents included). */
	show(options?: IShowGatewayCostsOptions): void {
		if (this._panel) {
			this._panel.reveal();
			if (options?.chatId) {
				void this._panel.webview.postMessage({ type: 'showChat', chatId: options.chatId });
			}
			return;
		}
		this._pendingChatId = options?.chatId;
		const panel = window.createWebviewPanel('creaeditor.aiCosts', l10n.t('AI Costs'), ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		this._panel = panel;
		panel.webview.html = this._getHtml();
		this._panelDisposables.add(panel.webview.onDidReceiveMessage((message: PanelMessage) => this._onMessage(message)));
		this._panelDisposables.add(this._trackingService.onDidChangeEntries(() => {
			this._dataset = undefined;
			this._postEntries();
		}));
		// CreaEditor: the Keys and Budgets sections.
		this._panelDisposables.add(this._keyStatus.onDidChange(() => this._postKeys()));
		this._panelDisposables.add(this._budgets.onDidChange(() => this._postBudgets()));
		// The Subscriptions section reads the accounts from the workbench while the page is visible.
		const subscriptionsPoll = this._panelDisposables.add(new IntervalTimer());
		const updateSubscriptionsPoll = () => {
			if (panel.visible) {
				subscriptionsPoll.cancelAndSet(() => this._postSubscriptions(), SUBSCRIPTIONS_POLL_INTERVAL);
			} else {
				subscriptionsPoll.cancel();
			}
		};
		updateSubscriptionsPoll();
		this._panelDisposables.add(panel.onDidChangeViewState(() => {
			if (panel.visible) {
				void this._postSubscriptions();
			}
			updateSubscriptionsPoll();
		}));
		this._panelDisposables.add(panel.onDidDispose(() => {
			this._panel = undefined;
			this._dataset = undefined;
			this._panelDisposables.clear();
		}));
	}

	private async _onMessage(message: PanelMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				this._postEntries();
				if (this._pendingChatId) {
					void this._panel?.webview.postMessage({ type: 'showChat', chatId: this._pendingChatId });
					this._pendingChatId = undefined;
				}
				void this._postSubscriptions();
				this._postKeys();
				this._postBudgets();
				void this._keyStatus.refresh();
				break;
			case 'refreshKeys':
				await this._keyStatus.refresh();
				this._postKeys();
				break;
			case 'addBudget':
				await this._budgets.editBudget(undefined);
				break;
			case 'editBudget':
				await this._budgets.editBudget(message.id);
				break;
			case 'removeBudget':
				await this._budgets.removeBudget(message.id);
				break;
			case 'refreshSubscriptions':
				try {
					await commands.executeCommand(REFRESH_SUBSCRIPTION_USAGE_COMMAND_ID);
				} catch {
					// No subscription accounts in this window; the section already says so.
				}
				this._subscriptionsRefresh.schedule();
				break;
			case 'openSubscriptionUsage':
				await commands.executeCommand(SHOW_SUBSCRIPTION_USAGE_COMMAND_ID);
				break;
			case 'addSubscriptionAccount':
				if (message.provider === 'claude' || message.provider === 'codex') {
					await commands.executeCommand(ADD_SUBSCRIPTION_ACCOUNT_COMMAND_IDS[message.provider]);
				}
				break;
			case 'exportCsv':
				await this._exportCsv();
				break;
			case 'query': {
				const result = runCostQuery(this._getDataset(), message.filters, message.options, Date.now());
				void this._panel?.webview.postMessage({ type: 'result', seq: message.seq, result });
				break;
			}
			case 'exportFiltered':
				await this._exportFiltered(message.format, filterCostRows(this._getDataset(), message.filters, Date.now()));
				break;
			case 'clear': {
				const clear = l10n.t('Clear');
				const answer = await window.showWarningMessage(l10n.t('Remove all recorded AI costs from this machine?'), { modal: true }, clear);
				if (answer === clear) {
					this._trackingService.clear();
				}
				break;
			}
		}
	}

	private async _postSubscriptions(): Promise<void> {
		let state: ISubscriptionAccountsSnapshot | undefined;
		try {
			state = toSubscriptionAccountsSnapshot(await commands.executeCommand<unknown>(GET_SUBSCRIPTION_ACCOUNTS_STATE_COMMAND_ID));
		} catch {
			state = undefined;
		}
		void this._panel?.webview.postMessage({ type: 'subscriptions', state });
	}

	private _postKeys(): void {
		void this._panel?.webview.postMessage({ type: 'keys', statuses: this._keyStatus.getStatuses() });
	}

	private _postBudgets(): void {
		void this._panel?.webview.postMessage({ type: 'budgets', statuses: toBudgetSnapshots(this._budgets.getStatuses()) });
	}

	private _postEntries(): void {
		// The issue label (`owner/repo#123`, `#123` or `PROJ-123`) groups the entries; the URL links Jira issues.
		const entries = this._trackingService.entries.map(entry => ({ ...entry, issueLabel: formatIssue(entry.issue, entry.repo), issueUrl: getIssueUrl(entry.issue) }));
		void this._panel?.webview.postMessage({ type: 'entries', entries });
	}

	private _getDataset(): ICostDataset {
		this._dataset ??= prepareCostDataset(this._trackingService.entries);
		return this._dataset;
	}

	private async _exportFiltered(format: 'csv' | 'json', rows: readonly ICostRow[]): Promise<void> {
		const target = await window.showSaveDialog({
			defaultUri: Uri.file(`creaeditor-ai-costs-filtered-${new Date().toISOString().slice(0, 10)}.${format}`),
			filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
		});
		if (!target) {
			return;
		}
		const content = format === 'csv' ? toCsv(rows) : JSON.stringify(rows, undefined, '\t') + '\n';
		await workspace.fs.writeFile(target, new TextEncoder().encode(content));
		window.showInformationMessage(l10n.t('Exported {0} requests.', rows.length));
	}

	private async _exportCsv(): Promise<void> {
		const target = await window.showSaveDialog({
			defaultUri: Uri.file(`creaeditor-ai-costs-${new Date().toISOString().slice(0, 10)}.csv`),
			filters: { CSV: ['csv'] },
		});
		if (!target) {
			return;
		}
		await workspace.fs.writeFile(target, new TextEncoder().encode(toCsv(this._trackingService.entries)));
		window.showInformationMessage(l10n.t('Exported {0} requests.', this._trackingService.entries.length));
	}

	private _getHtml(): string {
		const nonce = generateUuid().replace(/-/g, '');
		const strings = {
			title: l10n.t('AI Costs'),
			subtitle: l10n.t('Cost reported by OpenRouter and LiteLLM for every request, per issue and chat.'),
			total: l10n.t('Total'),
			requests: l10n.t('Requests'),
			issues: l10n.t('Issues'),
			chats: l10n.t('Chats'),
			oneChat: l10n.t('{0} chat'),
			manyChats: l10n.t('{0} chats'),
			unknownCost: l10n.t('Requests without a cost yet'),
			period7: l10n.t('Last 7 days'),
			period30: l10n.t('Last 30 days'),
			period90: l10n.t('Last 90 days'),
			periodAll: l10n.t('All time'),
			allGateways: l10n.t('All gateways'),
			search: l10n.t('Filter by issue, chat, repository or model'),
			export: l10n.t('Export CSV'),
			clear: l10n.t('Clear'),
			noIssue: l10n.t('Not linked to an issue'),
			untitled: l10n.t('Untitled chat'),
			empty: l10n.t('No requests recorded yet. Requests to OpenRouter and LiteLLM models are tracked automatically.'),
			model: l10n.t('Model'),
			tokens: l10n.t('Tokens'),
			cost: l10n.t('Cost'),
			last: l10n.t('Last request'),
			sources: l10n.t('Cost sources'),
			source_response: l10n.t('response'),
			source_header: l10n.t('LiteLLM header'),
			['source_openrouter-api']: l10n.t('OpenRouter API'),
			['source_litellm-api']: l10n.t('LiteLLM spend API'),
			viaBranch: l10n.t('from branch'),
			viaPrompt: l10n.t('from prompt'),
			viaAgent: l10n.t('set by agent'),
			...getAdvancedStrings(),
			...getSubscriptionsStrings(),
			...getKeysStrings(),
		};
		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px 32px; margin: 0; }
	h1 { font-size: 1.6em; font-weight: 600; margin: 0 0 4px; }
	.subtitle { color: var(--vscode-descriptionForeground); margin-bottom: 20px; }
	.toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 20px; }
	select, input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 4px 8px; font: inherit; }
	.toolbar input { flex: 1; min-width: 220px; }
	button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 4px; padding: 5px 12px; font: inherit; cursor: pointer; }
	button:hover { background: var(--vscode-button-secondaryHoverBackground); }
	.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
	.card { background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-widget-border, transparent); border-radius: 8px; padding: 12px 16px; }
	.card .label { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
	.card .value { font-size: 1.5em; font-weight: 600; margin-top: 4px; }
	.card.total .value { color: var(--vscode-button-background); }
	details.issue { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
	details.issue > summary { display: flex; align-items: center; gap: 12px; padding: 10px 14px; cursor: pointer; background: var(--vscode-sideBar-background, transparent); list-style: none; }
	details.issue > summary::-webkit-details-marker { display: none; }
	.issue-name { font-weight: 600; flex: 1; }
	.issue-name a { color: var(--vscode-textLink-foreground); text-decoration: none; }
	.issue-name a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
	.muted { color: var(--vscode-descriptionForeground); }
	.badge { font-size: 0.8em; padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.amount { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 80px; text-align: right; }
	table { width: 100%; border-collapse: collapse; }
	th, td { text-align: left; padding: 6px 14px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); vertical-align: top; }
	th { color: var(--vscode-descriptionForeground); font-weight: normal; font-size: 0.9em; }
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
	.chat-title { font-weight: 500; }
	.models { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
	.empty { color: var(--vscode-descriptionForeground); padding: 40px 0; text-align: center; }
${ADVANCED_STYLES}
${SUBSCRIPTIONS_STYLES}
${KEYS_STYLES}
</style>
</head>
<body>
<h1>${escapeHtml(strings.title)}</h1>
<div class="subtitle">${escapeHtml(strings.subtitle)}</div>
${getSubscriptionsMarkup(strings)}
${getKeysMarkup(strings)}
<div class="tabs" role="tablist" aria-label="${escapeHtml(strings.tabsLabel)}">
	<button type="button" class="tab" role="tab" id="tab-overview" data-tab="overview" aria-controls="overview" aria-selected="true">${escapeHtml(strings.tabOverview)}</button>
	<button type="button" class="tab" role="tab" id="tab-advanced" data-tab="advanced" aria-controls="advanced" aria-selected="false" tabindex="-1">${escapeHtml(strings.tabAdvanced)}</button>
</div>
<section id="overview" role="tabpanel" aria-labelledby="tab-overview">
<div class="toolbar">
	<select id="period"><option value="7">${escapeHtml(strings.period7)}</option><option value="30" selected>${escapeHtml(strings.period30)}</option><option value="90">${escapeHtml(strings.period90)}</option><option value="0">${escapeHtml(strings.periodAll)}</option></select>
	<select id="gateway"><option value="">${escapeHtml(strings.allGateways)}</option><option value="openrouter">OpenRouter</option><option value="litellm">LiteLLM</option></select>
	<input id="search" type="search" placeholder="${escapeHtml(strings.search)}">
	<button id="export">${escapeHtml(strings.export)}</button>
	<button id="clear">${escapeHtml(strings.clear)}</button>
</div>
<div class="cards" id="cards"></div>
<div id="groups"></div>
</section>
<section id="advanced" role="tabpanel" aria-labelledby="tab-advanced" hidden>
${getAdvancedMarkup(strings)}
</section>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const S = ${JSON.stringify(strings)};
let entries = [];
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Cents are enough from a dollar up; below that, small request costs need four decimals.
const money = v => v === undefined ? '–' : '$' + (v < 1 && v > 0 ? v.toFixed(4) : v.toFixed(2));
const tokens = v => v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(v);
const issueLabel = e => e.issueLabel || '';
function filtered() {
	const days = Number($('period').value);
	// Whole local days, today included, the same as the Advanced tab.
	const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
	const since = days ? start.getTime() : 0;
	const gateway = $('gateway').value;
	const q = $('search').value.trim().toLowerCase();
	return entries.filter(e => e.time >= since && (!gateway || e.gateway === gateway) && (!q || [issueLabel(e), e.chatTitle, e.repo, e.branch, e.model].some(v => v && String(v).toLowerCase().includes(q))));
}
function sum(list, f) { return list.reduce((a, e) => a + (f(e) || 0), 0); }
function render() {
	const list = filtered();
	const byIssue = new Map();
	for (const e of list) {
		const key = issueLabel(e) || '';
		if (!byIssue.has(key)) byIssue.set(key, []);
		byIssue.get(key).push(e);
	}
	const chats = new Set(list.map(e => e.rootChatId));
	const unknown = list.filter(e => e.cost === undefined).length;
	$('cards').innerHTML = [
		['total', S.total, money(sum(list, e => e.cost))],
		['', S.requests, list.length],
		['', S.issues, [...byIssue.keys()].filter(Boolean).length],
		['', S.chats, chats.size],
		['', S.unknownCost, unknown],
	].map(([cls, l, v]) => '<div class="card ' + cls + '"><div class="label">' + esc(l) + '</div><div class="value">' + esc(v) + '</div></div>').join('');
	if (!list.length) { $('groups').innerHTML = '<div class="empty">' + esc(S.empty) + '</div>'; return; }
	const groups = [...byIssue.entries()].sort((a, b) => sum(b[1], e => e.cost) - sum(a[1], e => e.cost));
	$('groups').innerHTML = groups.map(([issue, items]) => {
		const byChat = new Map();
		for (const e of items) { if (!byChat.has(e.rootChatId)) byChat.set(e.rootChatId, []); byChat.get(e.rootChatId).push(e); }
		const sourceOf = items.find(e => e.issueSource)?.issueSource;
		const url = items.find(e => e.issueUrl)?.issueUrl;
		const name = issue ? (url ? '<a href="' + esc(url) + '">' + esc(issue) + '</a>' : esc(issue)) : esc(S.noIssue);
		const via = sourceOf === 'branch' ? S.viaBranch : sourceOf === 'prompt' ? S.viaPrompt : sourceOf === 'agent' ? S.viaAgent : '';
		const rows = [...byChat.values()].sort((a, b) => sum(b, e => e.cost) - sum(a, e => e.cost)).map(chat => {
			const models = [...new Set(chat.map(e => e.model))].join(', ');
			const last = new Date(Math.max(...chat.map(e => e.time)));
			const title = chat.find(e => e.chatTitle)?.chatTitle || S.untitled;
			const branch = chat.find(e => e.branch)?.branch;
			return '<tr><td><div class="chat-title">' + esc(title) + '</div><div class="models">' + esc(models) + (branch ? ' · ' + esc(branch) : '') + '</div></td>'
				+ '<td class="num">' + chat.length + '</td>'
				+ '<td class="num">' + tokens(sum(chat, e => (e.promptTokens || 0) + (e.completionTokens || 0))) + '</td>'
				+ '<td>' + esc(last.toLocaleString()) + '</td>'
				+ '<td class="num"><b>' + money(sum(chat, e => e.cost)) + '</b></td></tr>';
		}).join('');
		return '<details class="issue" open><summary><span class="issue-name">' + name + '</span>'
			+ (via ? '<span class="badge">' + esc(via) + '</span>' : '')
			+ '<span class="muted">' + esc((byChat.size === 1 ? S.oneChat : S.manyChats).replace('{0}', byChat.size)) + '</span>'
			+ '<span class="amount">' + money(sum(items, e => e.cost)) + '</span></summary>'
			+ '<table><tr><th>' + esc(S.chats) + '</th><th class="num">' + esc(S.requests) + '</th><th class="num">' + esc(S.tokens) + '</th><th>' + esc(S.last) + '</th><th class="num">' + esc(S.cost) + '</th></tr>' + rows + '</table></details>';
	}).join('');
}
for (const id of ['period', 'gateway']) $(id).addEventListener('change', render);
$('search').addEventListener('input', render);
$('export').addEventListener('click', () => vscode.postMessage({ type: 'exportCsv' }));
$('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
window.addEventListener('message', event => { if (event.data?.type === 'entries') { entries = event.data.entries; render(); } });
vscode.postMessage({ type: 'ready' });
</script>
<script nonce="${nonce}">
${getAdvancedScript()}
</script>
<script nonce="${nonce}">
${SUBSCRIPTIONS_SCRIPT}
</script>
<script nonce="${nonce}">
${KEYS_SCRIPT}
</script>
</body>
</html>`;
	}
}

function csvCell(value: string | number | undefined): string {
	const text = value === undefined ? '' : String(value);
	return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CreaEditor: the cost ledger as CSV, one row per request. */
export function toCsv(entries: readonly IGatewayCostEntry[]): string {
	const header = ['time', 'issue', 'issue_source', 'repo', 'branch', 'chat', 'chat_title', 'subchat', 'gateway', 'gateway_host', 'model', 'gateway_request_id', 'prompt_tokens', 'completion_tokens', 'cached_tokens', 'cost_usd', 'cost_source'];
	const rows = entries.map(entry => [
		new Date(entry.time).toISOString(),
		formatIssue(entry.issue, entry.repo),
		entry.issueSource,
		entry.repo,
		entry.branch,
		entry.rootChatId,
		entry.chatTitle,
		entry.chatId !== entry.rootChatId ? entry.chatId : undefined,
		entry.gateway,
		entry.gatewayHost,
		entry.model,
		entry.gatewayRequestId,
		entry.promptTokens,
		entry.completionTokens,
		entry.cachedTokens,
		entry.cost,
		entry.costSource,
	].map(csvCell).join(','));
	return [header.join(','), ...rows].join('\n') + '\n';
}
