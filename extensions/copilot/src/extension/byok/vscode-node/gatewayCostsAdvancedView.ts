/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Advanced view of the AI Costs page: filter bar, KPI cards, charts, pivot table and a
// paged requests table. The webview only renders; the extension host runs the analysis in
// `gatewayCostsAnalysis.ts` for every `query` message and answers with a `result` message.

import * as l10n from '@vscode/l10n';
import { OTHER_VALUE } from '../common/gatewayCostsAnalysis';

/** Escapes text for HTML content and attribute values. */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c] ?? c);
}

/** The localized strings of the Advanced view, merged into the page's `S` object. */
export function getAdvancedStrings() {
	return {
		tabsLabel: l10n.t('Views'),
		tabOverview: l10n.t('Overview'),
		tabAdvanced: l10n.t('Advanced'),
		rangeLabel: l10n.t('Date range'),
		rangeToday: l10n.t('Today'),
		range7: l10n.t('Last 7 days'),
		range30: l10n.t('Last 30 days'),
		range90: l10n.t('Last 90 days'),
		rangeThisMonth: l10n.t('This month'),
		rangeLastMonth: l10n.t('Last month'),
		rangeAll: l10n.t('All time'),
		rangeCustom: l10n.t('Custom range'),
		from: l10n.t('From'),
		to: l10n.t('To'),
		kindLabel: l10n.t('Requests from'),
		kindMain: l10n.t('Main chats'),
		kindSubagent: l10n.t('Subagents'),
		kindBoth: l10n.t('Both'),
		withoutCost: l10n.t('Only requests without a cost'),
		minCost: l10n.t('Minimum cost per request in USD'),
		maxCost: l10n.t('Maximum cost per request in USD'),
		minShort: l10n.t('Min $'),
		maxShort: l10n.t('Max $'),
		advancedSearch: l10n.t('Search chat, issue, repository, branch, model or request ID'),
		reset: l10n.t('Reset Filters'),
		countOf: l10n.t('{0} of {1} requests'),
		exportCsv: l10n.t('Export CSV'),
		exportJson: l10n.t('Export JSON'),
		exportFilteredTitle: l10n.t('Export the requests that match the filters'),
		popSearch: l10n.t('Search'),
		popClear: l10n.t('Clear'),
		popMore: l10n.t('{0} more, refine the search'),
		popEmpty: l10n.t('No matches'),
		removeFilter: l10n.t('Remove filter: {0}'),
		dim_key: l10n.t('Key'),
		dim_model: l10n.t('Model'),
		dim_gateway: l10n.t('Gateway'),
		dim_repo: l10n.t('Repository'),
		dim_branch: l10n.t('Branch'),
		dim_issue: l10n.t('Issue'),
		dim_chat: l10n.t('Chat'),
		dim_costSource: l10n.t('Cost source'),
		dim_kind: l10n.t('Main or subagent'),
		none: l10n.t('(none)'),
		other: l10n.t('Other'),
		main: l10n.t('Main chat'),
		subagent: l10n.t('Subagent'),
		subagentBadge: l10n.t('subagent'),
		chipWithoutCost: l10n.t('Without a cost'),
		chipMin: l10n.t('Cost at least {0}'),
		chipMax: l10n.t('Cost at most {0}'),
		chipText: l10n.t('Search: {0}'),
		kTotal: l10n.t('Total cost'),
		kWithoutCost: l10n.t('{0} without a cost'),
		kAvg: l10n.t('Avg cost per request'),
		kMedian: l10n.t('Median request cost'),
		kP95: l10n.t('P95 request cost'),
		kP95Title: l10n.t('95% of the requests with a cost cost this much or less.'),
		kPrompt: l10n.t('Prompt tokens'),
		kCompletion: l10n.t('Completion tokens'),
		kCached: l10n.t('Cached tokens'),
		kCacheShare: l10n.t('Cache hit share'),
		kCacheShareTitle: l10n.t('Cached tokens as a share of the prompt tokens.'),
		kPerMillion: l10n.t('Cost per 1M tokens'),
		kPerMillionTitle: l10n.t('Cost divided by the prompt and completion tokens of the requests with a cost.'),
		kPerDay: l10n.t('Avg cost per active day'),
		kOneDay: l10n.t('{0} active day'),
		kDays: l10n.t('{0} active days'),
		kProjected: l10n.t('Projected this month'),
		kSoFar: l10n.t('{0} so far'),
		kProjectedTitle: l10n.t('Cost so far this month ({0}) divided by the {1} days elapsed, today included, times the {2} days in the month. Counts only the requests that match the other filters.'),
		kSubagentShare: l10n.t('Cost by subagents'),
		timelineTitle: l10n.t('Cost over time'),
		stackBy: l10n.t('Stack by'),
		bucketLabel: l10n.t('Per'),
		bucketAuto: l10n.t('Auto'),
		bucketDay: l10n.t('Day'),
		bucketWeek: l10n.t('Week'),
		bucketMonth: l10n.t('Month'),
		weekOf: l10n.t('Week of {0}'),
		chartHint: l10n.t('Click a bar, legend entry or row to add a filter on it. Values of the same kind match any of them; different kinds all apply.'),
		timelineAria: l10n.t('Stacked bars of the cost over time. The pivot table and requests table show the same data.'),
		breakdownTitle: l10n.t('Breakdown'),
		breakdownBy: l10n.t('By'),
		share: l10n.t('Share'),
		nRequests: l10n.t('{0} requests'),
		oneRequest: l10n.t('1 request'),
		tokensTitle: l10n.t('Tokens over time'),
		tokensAria: l10n.t('Lines of the prompt, completion and cached tokens over time.'),
		prompt: l10n.t('Prompt'),
		completion: l10n.t('Completion'),
		cached: l10n.t('Cached'),
		pivotTitle: l10n.t('Pivot table'),
		pivotRows: l10n.t('Rows'),
		pivotColumns: l10n.t('Columns'),
		pivotNone: l10n.t('None'),
		metric: l10n.t('Show'),
		metricCost: l10n.t('Cost'),
		metricRequests: l10n.t('Requests'),
		metricTokens: l10n.t('Tokens'),
		metricAvg: l10n.t('Avg cost'),
		totalCol: l10n.t('Total'),
		requestsTitle: l10n.t('Requests'),
		columns: l10n.t('Columns'),
		previous: l10n.t('Previous'),
		next: l10n.t('Next'),
		pageOf: l10n.t('Page {0} of {1}'),
		colTime: l10n.t('Time'),
		colRepoBranch: l10n.t('Repository / branch'),
		colCost: l10n.t('Cost'),
		colRequestId: l10n.t('Request ID'),
		fId: l10n.t('Entry ID'),
		fChatId: l10n.t('Chat ID'),
		fRootChatId: l10n.t('Main chat ID'),
		fChatTitle: l10n.t('Chat title'),
		fRootTitle: l10n.t('Main chat title'),
		fIssueSource: l10n.t('Issue source'),
		fGatewayHost: l10n.t('Gateway host'),
		fCostFull: l10n.t('Cost (USD)'),
		noMatch: l10n.t('No requests match these filters.'),
		compareLabel: l10n.t('Compare'),
		compareOff: l10n.t('No comparison'),
		comparePrevious: l10n.t('With the previous period'),
		compareMonth: l10n.t('This month vs last month'),
		compareTitle: l10n.t('Compared with the previous period'),
		compareMonthTitle: l10n.t('This month vs last month'),
		comparePeriods: l10n.t('{0} vs {1}'),
		compareNoRange: l10n.t('Pick a date range with a start to compare it with the period before it.'),
		compareBy: l10n.t('By'),
		compareThis: l10n.t('This period'),
		comparePrev: l10n.t('Previous'),
		compareChange: l10n.t('Change'),
		vsPrevious: l10n.t('{0} vs previous period'),
		previousValue: l10n.t('Previous period: {0}'),
		changeUp: l10n.t('up'),
		changeDown: l10n.t('down'),
		changeNew: l10n.t('new'),
		changeSame: l10n.t('no change'),
	};
}

/** The markup of the Advanced tab. */
export function getAdvancedMarkup(s: ReturnType<typeof getAdvancedStrings>): string {
	const e = escapeHtml;
	const ranges: [string, string][] = [['today', s.rangeToday], ['7', s.range7], ['30', s.range30], ['90', s.range90], ['thisMonth', s.rangeThisMonth], ['lastMonth', s.rangeLastMonth], ['all', s.rangeAll], ['custom', s.rangeCustom]];
	return `<div class="adv">
	<div class="filters" role="search">
		<div class="filter-row">
			<select id="a-range" aria-label="${e(s.rangeLabel)}">${ranges.map(([value, label]) => `<option value="${value}">${e(label)}</option>`).join('')}</select>
			<span id="a-custom" class="custom-range" hidden>
				<input id="a-from" type="date" aria-label="${e(s.from)}"><span class="muted">–</span><input id="a-to" type="date" aria-label="${e(s.to)}">
			</span>
			<span class="segmented" role="group" aria-label="${e(s.kindLabel)}">
				<button type="button" data-kind="main">${e(s.kindMain)}</button><button type="button" data-kind="subagent">${e(s.kindSubagent)}</button><button type="button" data-kind="both">${e(s.kindBoth)}</button>
			</span>
			<label class="check"><input id="a-nocost" type="checkbox">${e(s.withoutCost)}</label>
			<input id="a-min" class="cost-input" type="number" min="0" step="any" placeholder="${e(s.minShort)}" aria-label="${e(s.minCost)}">
			<input id="a-max" class="cost-input" type="number" min="0" step="any" placeholder="${e(s.maxShort)}" aria-label="${e(s.maxCost)}">
			<input id="a-text" class="text-input" type="search" placeholder="${e(s.advancedSearch)}" aria-label="${e(s.advancedSearch)}">
			<select id="a-compare" aria-label="${e(s.compareLabel)}"><option value="off">${e(s.compareOff)}</option><option value="previous">${e(s.comparePrevious)}</option><option value="month">${e(s.compareMonth)}</option></select>
		</div>
		<div class="filter-row" id="a-multis"></div>
		<div class="filter-row">
			<div id="a-chips" class="chips"></div>
			<span class="spacer"></span>
			<span id="a-count" class="muted count" aria-live="polite"></span>
			<button type="button" id="a-reset">${e(s.reset)}</button>
			<button type="button" id="a-export-csv" title="${e(s.exportFilteredTitle)}">${e(s.exportCsv)}</button>
			<button type="button" id="a-export-json" title="${e(s.exportFilteredTitle)}">${e(s.exportJson)}</button>
		</div>
	</div>
	<div id="a-empty" class="empty" hidden></div>
	<div id="a-content">
		<div class="cards" id="a-kpis"></div>
		<section class="panel" id="a-compare-panel" hidden>
			<div class="panel-head">
				<h2 id="a-compare-title">${e(s.compareTitle)}</h2>
				<span class="controls">
					<span id="a-compare-periods" class="muted"></span>
					<label>${e(s.compareBy)} <select id="a-compare-by"><option value="key">${e(s.dim_key)}</option><option value="model">${e(s.dim_model)}</option></select></label>
				</span>
			</div>
			<div id="a-compare-table" class="table-wrap"></div>
		</section>
		<section class="panel">
			<div class="panel-head">
				<h2>${e(s.timelineTitle)}</h2>
				<span class="controls">
					<label>${e(s.stackBy)} <select id="a-stack" data-dimensions></select></label>
					<label>${e(s.bucketLabel)} <select id="a-bucket"><option value="auto">${e(s.bucketAuto)}</option><option value="day">${e(s.bucketDay)}</option><option value="week">${e(s.bucketWeek)}</option><option value="month">${e(s.bucketMonth)}</option></select></label>
				</span>
			</div>
			<div id="a-legend" class="legend"></div>
			<div id="a-timeline" class="chart"></div>
			<div class="hint muted">${e(s.chartHint)}</div>
		</section>
		<div class="grid2">
			<section class="panel">
				<div class="panel-head">
					<h2>${e(s.breakdownTitle)}</h2>
					<span class="controls"><label>${e(s.breakdownBy)} <select id="a-breakdown-by" data-dimensions></select></label></span>
				</div>
				<div id="a-breakdown" class="breakdown"></div>
			</section>
			<section class="panel">
				<div class="panel-head"><h2>${e(s.tokensTitle)}</h2></div>
				<div id="a-tokens-legend" class="legend"></div>
				<div id="a-tokens" class="chart small"></div>
			</section>
		</div>
		<section class="panel">
			<div class="panel-head">
				<h2>${e(s.pivotTitle)}</h2>
				<span class="controls">
					<label>${e(s.pivotRows)} <select id="a-pivot-rows" data-dimensions></select></label>
					<label>${e(s.pivotColumns)} <select id="a-pivot-columns" data-dimensions data-none></select></label>
					<label>${e(s.metric)} <select id="a-pivot-metric"><option value="cost">${e(s.metricCost)}</option><option value="requests">${e(s.metricRequests)}</option><option value="tokens">${e(s.metricTokens)}</option><option value="avg">${e(s.metricAvg)}</option></select></label>
				</span>
			</div>
			<div id="a-pivot" class="table-wrap"></div>
		</section>
		<section class="panel">
			<div class="panel-head">
				<h2>${e(s.requestsTitle)}</h2>
				<span class="controls">
					<details class="menu" id="a-columns"><summary>${e(s.columns)}</summary><div class="menu-body" id="a-columns-body"></div></details>
				</span>
			</div>
			<div id="a-requests" class="table-wrap"></div>
			<div class="pager"><button type="button" id="a-prev">${e(s.previous)}</button><span id="a-page" class="muted"></span><button type="button" id="a-next">${e(s.next)}</button></div>
		</section>
	</div>
	<div id="a-popover" class="popover" role="dialog" hidden>
		<input id="a-pop-search" type="search" placeholder="${e(s.popSearch)}" aria-label="${e(s.popSearch)}">
		<div id="a-pop-list" class="pop-list"></div>
		<div class="pop-foot"><span id="a-pop-more" class="muted"></span><button type="button" id="a-pop-clear" class="link">${e(s.popClear)}</button></div>
	</div>
	<div id="a-tooltip" class="tooltip" role="tooltip" hidden></div>
</div>`;
}

/** Styles of the tabs and the Advanced view. */
export const ADVANCED_STYLES = `
	.tabs { display: flex; gap: 4px; border-bottom: var(--vscode-strokeThickness, 1px) solid var(--vscode-widget-border, var(--vscode-panel-border)); margin-bottom: 20px; }
	.tabs .tab { background: none; color: var(--vscode-descriptionForeground); border-radius: 0; border-bottom: 2px solid transparent; padding: 8px 12px; margin-bottom: -1px; }
	.tabs .tab:hover { background: none; color: var(--vscode-foreground); }
	.tabs .tab[aria-selected="true"] { color: var(--vscode-foreground); border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder)); }
	button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible, .bucket:focus-visible, tr.req:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	@media (max-width: 600px) { body { padding: 16px; } }
	.adv { --c0: var(--vscode-charts-blue); --c1: var(--vscode-charts-orange); --c2: var(--vscode-charts-purple); --c3: var(--vscode-charts-yellow); --c4: var(--vscode-charts-red); --c5: var(--vscode-charts-green); --cother: color-mix(in srgb, var(--vscode-descriptionForeground) 45%, transparent); }
	#advanced.loading #a-content { opacity: 0.6; transition: opacity 0.2s 0.2s; }
	.adv input { flex: none; min-width: 0; }
	.adv input[type="checkbox"] { padding: 0; margin: 0; accent-color: var(--vscode-checkbox-background, var(--vscode-focusBorder)); }
	body.vscode-dark .adv input[type="date"], body.vscode-high-contrast .adv input[type="date"] { color-scheme: dark; }
	.filters { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
	.filter-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
	.filter-row:empty { display: none; }
	.custom-range { display: inline-flex; gap: 4px; align-items: center; }
	.custom-range[hidden] { display: none; }
	.cost-input { width: 72px; }
	.adv .text-input { flex: 1 1 200px; }
	.check { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
	.segmented { display: inline-flex; border: var(--vscode-strokeThickness, 1px) solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: var(--vscode-cornerRadius-small, 4px); overflow: hidden; }
	.segmented button { background: transparent; color: var(--vscode-foreground); border-radius: 0; padding: 4px 10px; }
	.segmented button:hover { background: var(--vscode-toolbar-hoverBackground); }
	.segmented button[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	.multi { display: inline-flex; gap: 6px; align-items: center; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: var(--vscode-strokeThickness, 1px) solid var(--vscode-input-border, transparent); padding: 4px 8px; }
	.multi:hover { background: var(--vscode-input-background); border-color: var(--vscode-focusBorder); }
	.multi svg { fill: currentColor; opacity: 0.7; }
	.chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
	.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 280px; border-radius: var(--vscode-cornerRadius-circle, 9999px); padding: 2px 8px; font-size: var(--vscode-fontSize-label1, 12px); }
	.chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.chip .x { opacity: 0.7; }
	.spacer { flex: 1; }
	.count { font-variant-numeric: tabular-nums; }
	button.link { background: none; color: var(--vscode-textLink-foreground); padding: 2px 4px; }
	button.link:hover { background: none; text-decoration: underline; }
	.popover { position: fixed; z-index: 10; width: 320px; max-width: calc(100vw - 32px); box-sizing: border-box; background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground)); border: var(--vscode-strokeThickness, 1px) solid var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent)); border-radius: var(--vscode-cornerRadius-large, 8px); box-shadow: 0 4px 16px var(--vscode-widget-shadow, transparent); padding: 8px; }
	.popover input[type="search"] { width: 100%; box-sizing: border-box; margin-bottom: 6px; }
	.pop-list { max-height: 280px; overflow-y: auto; }
	.opt { display: flex; gap: 8px; align-items: center; padding: 4px 6px; border-radius: var(--vscode-cornerRadius-small, 4px); cursor: pointer; }
	.opt:hover { background: var(--vscode-list-hoverBackground); }
	.opt-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.opt-count { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
	.pop-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; gap: 8px; }
	.pop-empty { padding: 8px 6px; color: var(--vscode-descriptionForeground); }
	.card .sub { color: var(--vscode-descriptionForeground); font-size: var(--vscode-fontSize-body2, 11px); margin-top: 2px; }
	.card[title] .label { text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }
	.panel { border: var(--vscode-strokeThickness, 1px) solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: var(--vscode-cornerRadius-large, 8px); padding: 12px 16px; margin-bottom: 16px; min-width: 0; container-type: inline-size; }
	.panel-head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
	.panel h2 { font-size: var(--vscode-fontSize-heading3, 13px); font-weight: var(--vscode-fontWeight-semiBold, 600); margin: 0; }
	.controls { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; color: var(--vscode-descriptionForeground); }
	.controls select { color: var(--vscode-input-foreground); }
	.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 0 16px; }
	.hint { font-size: var(--vscode-fontSize-body2, 11px); margin-top: 6px; }
	.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 8px; }
	.legend button { display: inline-flex; gap: 6px; align-items: center; background: none; color: var(--vscode-foreground); padding: 2px 4px; max-width: 260px; }
	.legend button:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
	.legend button:disabled { cursor: default; }
	.legend .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.legend .legend-item { display: inline-flex; gap: 6px; align-items: center; }
	.swatch { width: 10px; height: 10px; border-radius: var(--vscode-cornerRadius-xSmall, 2px); flex: none; }
	.linekey { width: 12px; height: 2px; border-radius: 1px; flex: none; }
	.swatch.k0, .linekey.k0 { background: var(--c0); } .swatch.k1, .linekey.k1 { background: var(--c1); } .swatch.k2, .linekey.k2 { background: var(--c2); }
	.swatch.k3, .linekey.k3 { background: var(--c3); } .swatch.k4, .linekey.k4 { background: var(--c4); } .swatch.k5, .linekey.k5 { background: var(--c5); }
	.swatch.kother, .linekey.kother { background: var(--cother); }
	.chart { position: relative; width: 100%; min-height: 220px; }
	.chart.small { min-height: 180px; }
	.chart svg { display: block; }
	.chart .empty-chart { padding: 40px 0; text-align: center; color: var(--vscode-descriptionForeground); }
	svg .k0 { fill: var(--c0); } svg .k1 { fill: var(--c1); } svg .k2 { fill: var(--c2); } svg .k3 { fill: var(--c3); } svg .k4 { fill: var(--c4); } svg .k5 { fill: var(--c5); } svg .kother { fill: var(--cother); }
	svg .gridline { stroke: var(--vscode-charts-lines); stroke-opacity: 0.35; stroke-width: 1; shape-rendering: crispEdges; }
	svg .axis { stroke: var(--vscode-charts-lines); stroke-width: 1; shape-rendering: crispEdges; }
	svg .tick { fill: var(--vscode-descriptionForeground); font-size: 11px; font-variant-numeric: tabular-nums; }
	svg .value { fill: var(--vscode-foreground); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
	svg .bucket { cursor: pointer; outline: none; }
	svg .hit { fill: transparent; }
	svg .bucket:hover .hit, svg .bucket:focus .hit { fill: var(--vscode-list-hoverBackground); }
	svg .bucket:focus-visible .hit { stroke: var(--vscode-focusBorder); }
	.chart.hovering .s { opacity: 0.5; }
	.chart.hovering .bucket.active .s { opacity: 1; }
	svg .series-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
	svg .l0 { stroke: var(--c0); } svg .l1 { stroke: var(--c1); } svg .l2 { stroke: var(--c2); }
	svg .dot { stroke: var(--vscode-editor-background); stroke-width: 2; }
	svg .cross { stroke: var(--vscode-descriptionForeground); stroke-width: 1; shape-rendering: crispEdges; }
	svg .overlay { fill: transparent; }
	.tooltip { position: fixed; z-index: 20; pointer-events: none; max-width: 320px; background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); border: var(--vscode-strokeThickness, 1px) solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border, transparent)); border-radius: var(--vscode-cornerRadius-medium, 6px); box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent); padding: 8px 10px; font-size: var(--vscode-fontSize-label1, 12px); }
	.tip-title { color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
	.tip-row { display: flex; gap: 8px; align-items: center; line-height: 1.6; }
	.tip-row.current .tip-label { color: var(--vscode-foreground); }
	.tip-value { font-weight: 600; font-variant-numeric: tabular-nums; min-width: 64px; }
	.tip-label { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.breakdown { display: flex; flex-direction: column; gap: 2px; }
	.bd-head, .bd-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(40px, 1.5fr) 80px 48px 96px; gap: 12px; align-items: center; }
	.bd-head { color: var(--vscode-descriptionForeground); font-size: var(--vscode-fontSize-body2, 11px); padding: 0 4px 4px; }
	.bd-row { width: 100%; text-align: left; background: none; color: var(--vscode-foreground); padding: 6px 4px; border-radius: var(--vscode-cornerRadius-small, 4px); }
	.bd-row:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
	.bd-row:disabled { cursor: default; }
	.bd-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.bd-bar svg { display: block; }
	.bd-bar rect.track { fill: var(--vscode-charts-lines); fill-opacity: 0.15; }
	.num { text-align: right; font-variant-numeric: tabular-nums; }
	@container (max-width: 440px) {
		.bd-head, .bd-row { grid-template-columns: minmax(0, 1fr) auto auto; row-gap: 4px; }
		.bd-bar { grid-column: 1 / -1; order: 5; }
		.bd-req, .bd-head .bd-req, .bd-head .bd-bar { display: none; }
	}
	.table-wrap { overflow-x: auto; }
	.table-wrap table th { white-space: nowrap; }
	.sort { background: none; color: inherit; padding: 0; font: inherit; border-radius: 0; text-align: inherit; }
	.sort:hover { background: none; color: var(--vscode-foreground); }
	.sort .arrow { margin-left: 4px; }
	.pivot td.cell, .pivot tbody th { cursor: pointer; }
	.pivot td.cell:hover, .pivot tbody th:hover { background: var(--vscode-list-hoverBackground); }
	.pivot tbody th { font-weight: normal; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); font-size: inherit; }
	.pivot tbody tr.other th, .pivot tbody tr.other td { cursor: default; color: var(--vscode-descriptionForeground); }
	.pivot .total, .pivot tfoot td, .pivot tfoot th { font-weight: 600; }
	.pivot .zero { color: var(--vscode-descriptionForeground); }
	.requests td { white-space: nowrap; }
	.requests td.wrap { white-space: normal; min-width: 160px; max-width: 320px; }
	.requests tr.req { cursor: pointer; }
	.requests tr.req:hover { background: var(--vscode-list-hoverBackground); }
	.requests tr.details > td { background: var(--vscode-textBlockQuote-background, transparent); border-top: none; }
	.requests code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-fontSize-body2, 11px); }
	dl.fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 16px; margin: 4px 0; white-space: normal; }
	dl.fields dt { color: var(--vscode-descriptionForeground); }
	dl.fields dd { margin: 0; overflow-wrap: anywhere; }
	.menu { position: relative; }
	.menu summary { cursor: pointer; list-style: none; padding: 4px 8px; border-radius: var(--vscode-cornerRadius-small, 4px); color: var(--vscode-foreground); }
	.menu summary::-webkit-details-marker { display: none; }
	.menu summary:hover { background: var(--vscode-toolbar-hoverBackground); }
	.menu-body { position: absolute; right: 0; z-index: 5; display: flex; flex-direction: column; gap: 4px; min-width: 200px; padding: 8px; background: var(--vscode-editorWidget-background); border: var(--vscode-strokeThickness, 1px) solid var(--vscode-editorWidget-border, var(--vscode-widget-border, transparent)); border-radius: var(--vscode-cornerRadius-large, 8px); box-shadow: 0 4px 16px var(--vscode-widget-shadow, transparent); }
	.card .delta { font-size: var(--vscode-fontSize-body2, 11px); margin-top: 2px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
	.delta .arrow { font-weight: var(--vscode-fontWeight-semiBold, 600); }
	.delta.up .arrow { color: var(--vscode-charts-orange); }
	.delta.down .arrow { color: var(--vscode-charts-blue); }
	.compare th.group { text-align: center; border-left: var(--vscode-strokeThickness, 1px) solid var(--vscode-widget-border, var(--vscode-panel-border)); }
	.compare td.first, .compare th.first { border-left: var(--vscode-strokeThickness, 1px) solid var(--vscode-widget-border, var(--vscode-panel-border)); }
	.compare tbody tr:not(.other) { cursor: pointer; }
	.compare tbody tr:not(.other):hover { background: var(--vscode-list-hoverBackground); }
	.compare tbody th { font-weight: normal; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); font-size: inherit; }
	.compare tbody tr.other th, .compare tbody tr.other td { color: var(--vscode-descriptionForeground); }
	.compare-empty { padding: 24px 0; text-align: center; color: var(--vscode-descriptionForeground); }
	.compare tfoot td, .compare tfoot th { font-weight: 600; }
	.pager { display: flex; gap: 12px; align-items: center; justify-content: flex-end; margin-top: 12px; }
	.pager button:disabled { opacity: 0.5; cursor: default; }
`;

/** The script of the Advanced view. It runs after the Overview script and reuses its `vscode`, `S`, `$`, `esc`, `money` and `tokens`. */
export function getAdvancedScript(): string {
	return `const OTHER = ${JSON.stringify(OTHER_VALUE)};\n${ADVANCED_SCRIPT}`;
}

const ADVANCED_SCRIPT = String.raw`
const DIMENSIONS = ['key', 'model', 'gateway', 'repo', 'branch', 'issue', 'chat', 'costSource', 'kind'];
const FILTER_DIMENSIONS = ['key', 'model', 'gateway', 'repo', 'branch', 'issue', 'chat', 'costSource'];
const PAGE_SIZE = 100;
const POPOVER_LIMIT = 200;
const GATEWAY_NAMES = { openrouter: 'OpenRouter', litellm: 'LiteLLM' };
const CHEVRON = '<svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 5.6 8 10.4l4.8-4.8-.8-.8L8 8.8 4 4.8z"/></svg>';
const fmt = (text, ...args) => String(text).replace(/\{(\d+)\}/g, (match, index) => args[index] !== undefined ? String(args[index]) : match);
const num = v => Number(v || 0).toLocaleString();
const pct = v => v === undefined || v === null ? '–' : (v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0) + '%';
const requestsText = n => n === 1 ? S.oneRequest : fmt(S.nRequests, num(n));

function defaultFilters() {
	return { range: '30', from: '', to: '', values: {}, kind: 'both', withoutCost: false, minCost: '', maxCost: '', text: '' };
}
function defaultView() {
	return { bucket: 'auto', stackBy: 'key', breakdownBy: 'model', pivotRows: 'issue', pivotColumns: 'key', pivotMetric: 'cost', pivotSort: 'total', pivotDescending: true, sortColumn: 'time', sortDescending: true, page: 0, hidden: ['cachedTokens', 'costSource', 'requestId'], compare: 'previous', compareBy: 'key' };
}

const savedState = vscode.getState() || {};
let currentTab = savedState.tab === 'advanced' ? 'advanced' : 'overview';
let filters = Object.assign(defaultFilters(), savedState.filters);
let view = Object.assign(defaultView(), savedState.view);
let result;
let querySeq = 0;
let queryTimer;
let openDimension;
const colorSlots = {};
const expanded = new Set();

function saveState() {
	vscode.setState({ tab: currentTab, filters, view });
}

// ---- Labels ----

function labelOf(dimension, key) {
	const value = key.value;
	if (value === OTHER) { return S.other; }
	if (dimension === 'kind') { return value === 'subagent' ? S.subagent : S.main; }
	if (dimension === 'chat') { return key.label || S.untitled; }
	if (!value) { return S.none; }
	if (dimension === 'costSource') { return S['source_' + value] || value; }
	return key.label || value;
}
function optionLabel(dimension, value) {
	const option = result && result.options[dimension].find(o => o.value === value);
	return labelOf(dimension, option || { value });
}
function gatewayLabel(row) {
	return (GATEWAY_NAMES[row.gateway] || row.gateway) + ' · ' + row.gatewayHost;
}
function sourceLabel(source) {
	return source ? (S['source_' + source] || source) : '–';
}
function isoDay(time) {
	const d = new Date(time);
	return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function bucketLabel(start, bucket, long) {
	const d = new Date(start);
	if (bucket === 'month') { return d.toLocaleDateString(undefined, { month: long ? 'long' : 'short', year: 'numeric' }); }
	if (!long) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
	const day = d.toLocaleDateString(undefined, { weekday: bucket === 'day' ? 'short' : undefined, month: 'short', day: 'numeric', year: 'numeric' });
	return bucket === 'week' ? fmt(S.weekOf, day) : day;
}

// ---- Querying ----

function numberOrUndefined(value) {
	return value === '' || value === null || value === undefined || isNaN(Number(value)) ? undefined : Number(value);
}
function queryFilters() {
	return {
		range: filters.range, from: filters.from || undefined, to: filters.to || undefined, values: filters.values, kind: filters.kind,
		withoutCost: filters.withoutCost, minCost: numberOrUndefined(filters.minCost), maxCost: numberOrUndefined(filters.maxCost), text: filters.text,
	};
}
function queryOptions() {
	return { bucket: view.bucket, stackBy: view.stackBy, breakdownBy: view.breakdownBy, pivotRows: view.pivotRows, pivotColumns: view.pivotColumns, sortColumn: view.sortColumn, sortDescending: view.sortDescending, page: view.page, pageSize: PAGE_SIZE, compare: view.compare !== 'off' };
}
function scheduleQuery(delay) {
	saveState();
	if (currentTab !== 'advanced') { return; }
	clearTimeout(queryTimer);
	$('advanced').classList.add('loading');
	queryTimer = setTimeout(() => vscode.postMessage({ type: 'query', seq: ++querySeq, filters: queryFilters(), options: queryOptions() }), delay === undefined ? 150 : delay);
}
function filtersChanged() {
	view.page = 0;
	expanded.clear();
	syncControls();
	scheduleQuery();
}
/**
 * Adds a drill-down filter. A value of a dimension that already has a filter is added to it (any of
 * the values matches); filters of different dimensions all apply. Returns whether anything changed.
 */
function applyDimension(dimension, value) {
	if (value === OTHER) { return false; }
	if (dimension === 'kind') {
		if (filters.kind === value) { return false; }
		filters.kind = value;
		return true;
	}
	const current = filters.values[dimension] || [];
	if (current.includes(value)) { return false; }
	filters.values = Object.assign({}, filters.values, { [dimension]: current.concat([value]) });
	return true;
}

// ---- Tabs ----

function showTab(name) {
	currentTab = name;
	for (const tab of document.querySelectorAll('.tabs .tab')) {
		const selected = tab.dataset.tab === name;
		tab.setAttribute('aria-selected', String(selected));
		tab.tabIndex = selected ? 0 : -1;
	}
	$('overview').hidden = name !== 'overview';
	$('advanced').hidden = name !== 'advanced';
	closePopover();
	saveState();
	if (name === 'advanced') { scheduleQuery(0); }
}

// ---- Filter bar ----

function fillDimensionSelects() {
	for (const select of document.querySelectorAll('select[data-dimensions]')) {
		const options = DIMENSIONS.map(d => '<option value="' + d + '">' + esc(S['dim_' + d]) + '</option>');
		if (select.hasAttribute('data-none')) { options.unshift('<option value="none">' + esc(S.pivotNone) + '</option>'); }
		select.innerHTML = options.join('');
	}
}
function syncControls() {
	$('a-range').value = filters.range;
	$('a-custom').hidden = filters.range !== 'custom';
	$('a-from').value = filters.from || '';
	$('a-to').value = filters.to || '';
	for (const button of document.querySelectorAll('.segmented button')) { button.setAttribute('aria-pressed', String(button.dataset.kind === filters.kind)); }
	$('a-nocost').checked = !!filters.withoutCost;
	if (document.activeElement !== $('a-min')) { $('a-min').value = filters.minCost; }
	if (document.activeElement !== $('a-max')) { $('a-max').value = filters.maxCost; }
	if (document.activeElement !== $('a-text')) { $('a-text').value = filters.text; }
	$('a-stack').value = view.stackBy;
	$('a-bucket').value = view.bucket;
	$('a-breakdown-by').value = view.breakdownBy;
	$('a-pivot-rows').value = view.pivotRows;
	$('a-pivot-columns').value = view.pivotColumns;
	$('a-pivot-metric').value = view.pivotMetric;
	if (view.compare === 'month' && filters.range !== 'thisMonth') { view.compare = 'previous'; }
	$('a-compare').value = view.compare;
	$('a-compare-by').value = view.compareBy;
	renderMultiButtons();
	renderChips();
}
function renderMultiButtons() {
	$('a-multis').innerHTML = FILTER_DIMENSIONS.map(d => {
		const count = (filters.values[d] || []).length;
		return '<button type="button" class="multi" data-dim="' + d + '" aria-haspopup="dialog" aria-expanded="' + (openDimension === d) + '">'
			+ esc(S['dim_' + d]) + (count ? '<span class="badge">' + count + '</span>' : '') + CHEVRON + '</button>';
	}).join('');
}
function renderChips() {
	const chips = [];
	for (const d of FILTER_DIMENSIONS) {
		for (const value of filters.values[d] || []) { chips.push({ text: S['dim_' + d] + ': ' + optionLabel(d, value), dim: d, value }); }
	}
	if (filters.kind !== 'both') { chips.push({ text: filters.kind === 'main' ? S.kindMain : S.kindSubagent, special: 'kind' }); }
	if (filters.withoutCost) { chips.push({ text: S.chipWithoutCost, special: 'withoutCost' }); }
	if (numberOrUndefined(filters.minCost) !== undefined) { chips.push({ text: fmt(S.chipMin, '$' + filters.minCost), special: 'minCost' }); }
	if (numberOrUndefined(filters.maxCost) !== undefined) { chips.push({ text: fmt(S.chipMax, '$' + filters.maxCost), special: 'maxCost' }); }
	if (filters.text.trim()) { chips.push({ text: fmt(S.chipText, filters.text.trim()), special: 'text' }); }
	$('a-chips').innerHTML = chips.map(chip => '<button type="button" class="chip" data-dim="' + esc(chip.dim || '') + '" data-value="' + esc(chip.value || '') + '" data-special="' + esc(chip.special || '') + '" title="' + esc(fmt(S.removeFilter, chip.text)) + '" aria-label="' + esc(fmt(S.removeFilter, chip.text)) + '"><span>' + esc(chip.text) + '</span><span class="x" aria-hidden="true">×</span></button>').join('');
}
function removeChip(chip) {
	const special = chip.dataset.special;
	if (special === 'kind') { filters.kind = 'both'; }
	else if (special === 'withoutCost') { filters.withoutCost = false; }
	else if (special === 'minCost' || special === 'maxCost' || special === 'text') { filters[special] = ''; }
	else {
		const d = chip.dataset.dim;
		filters.values = Object.assign({}, filters.values, { [d]: (filters.values[d] || []).filter(v => v !== chip.dataset.value) });
	}
	filtersChanged();
}

// ---- Multi-select popover ----

function openPopover(dimension, anchor) {
	openDimension = dimension;
	const popover = $('a-popover');
	popover.setAttribute('aria-label', S['dim_' + dimension]);
	popover.hidden = false;
	$('a-pop-search').value = '';
	renderPopoverList();
	const rect = anchor.getBoundingClientRect();
	const width = popover.offsetWidth;
	popover.style.left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)) + 'px';
	const below = rect.bottom + 4;
	popover.style.top = (below + popover.offsetHeight > window.innerHeight - 8 ? Math.max(8, rect.top - popover.offsetHeight - 4) : below) + 'px';
	renderMultiButtons();
	$('a-pop-search').focus();
}
function closePopover(restoreFocus) {
	if (!openDimension) { return; }
	const dimension = openDimension;
	openDimension = undefined;
	$('a-popover').hidden = true;
	renderMultiButtons();
	if (restoreFocus) { document.querySelector('.multi[data-dim="' + dimension + '"]')?.focus(); }
}
function renderPopoverList() {
	const d = openDimension;
	const query = $('a-pop-search').value.trim().toLowerCase();
	const selected = new Set(filters.values[d] || []);
	const all = (result ? result.options[d] : []).map(o => ({ value: o.value, label: labelOf(d, o), count: o.count }));
	for (const value of selected) {
		if (!all.some(o => o.value === value)) { all.push({ value, label: labelOf(d, { value }), count: 0 }); }
	}
	const matching = all.filter(o => !query || o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query));
	matching.sort((a, b) => Number(selected.has(b.value)) - Number(selected.has(a.value)));
	const shown = matching.slice(0, POPOVER_LIMIT);
	$('a-pop-list').innerHTML = shown.length
		? shown.map(o => '<label class="opt" title="' + esc(o.label) + '"><input type="checkbox" data-value="' + esc(o.value) + '"' + (selected.has(o.value) ? ' checked' : '') + '><span class="opt-label">' + esc(o.label) + '</span><span class="opt-count">' + num(o.count) + '</span></label>').join('')
		: '<div class="pop-empty">' + esc(S.popEmpty) + '</div>';
	$('a-pop-more').textContent = matching.length > shown.length ? fmt(S.popMore, num(matching.length - shown.length)) : '';
}
function toggleOption(value, checked) {
	const d = openDimension;
	const current = (filters.values[d] || []).filter(v => v !== value);
	filters.values = Object.assign({}, filters.values, { [d]: checked ? current.concat([value]) : current });
	filtersChanged();
}

// ---- Tooltip ----

function showTooltip(x, y, title, rows) {
	const tip = $('a-tooltip');
	tip.replaceChildren();
	const head = document.createElement('div');
	head.className = 'tip-title';
	head.textContent = title;
	tip.append(head);
	for (const row of rows) {
		const line = document.createElement('div');
		line.className = 'tip-row' + (row.current ? ' current' : '');
		if (row.key) {
			const key = document.createElement('span');
			key.className = 'linekey ' + row.key;
			line.append(key);
		}
		const value = document.createElement('span');
		value.className = 'tip-value';
		value.textContent = row.value;
		const label = document.createElement('span');
		label.className = 'tip-label';
		label.textContent = row.label;
		line.append(value, label);
		tip.append(line);
	}
	tip.hidden = false;
	const rect = tip.getBoundingClientRect();
	let left = x + 14;
	if (left + rect.width > window.innerWidth - 8) { left = Math.max(8, x - rect.width - 14); }
	let top = y + 14;
	if (top + rect.height > window.innerHeight - 8) { top = Math.max(8, y - rect.height - 14); }
	tip.style.left = left + 'px';
	tip.style.top = top + 'px';
}
function hideTooltip() {
	$('a-tooltip').hidden = true;
}

// ---- Chart helpers ----

function niceScale(max, count) {
	const top0 = max > 0 ? max : 1;
	const raw = top0 / count;
	const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
	const normalized = raw / magnitude;
	const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
	const top = Math.ceil(top0 / step - 1e-9) * step;
	const ticks = [];
	for (let i = 0; i * step <= top + step / 2; i++) { ticks.push(i * step); }
	return { top, ticks, step };
}
function axisMoney(value, step) {
	const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4;
	return '$' + value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function assignSlots(dimension, series) {
	const slots = colorSlots[dimension] || (colorSlots[dimension] = new Map());
	const present = new Set(series.map(key => key.value));
	for (const value of [...slots.keys()]) { if (!present.has(value)) { slots.delete(value); } }
	const used = new Set(slots.values());
	return series.map(key => {
		if (key.value === OTHER) { return 'kother'; }
		if (!slots.has(key.value)) {
			let slot = 0;
			while (used.has(slot)) { slot++; }
			slots.set(key.value, slot);
			used.add(slot);
		}
		return 'k' + slots.get(key.value);
	});
}
/** A bar from the baseline up with rounded top corners (the data end) and a square base. */
function barPath(x, y, width, height, radius) {
	const r = Math.min(radius, width / 2, height);
	return 'M' + x + ' ' + (y + height) + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + width - r) + 'Q' + (x + width) + ' ' + y + ' ' + (x + width) + ' ' + (y + r) + 'V' + (y + height) + 'Z';
}
function xLabels(buckets, band, left, height, bucket) {
	const every = Math.max(1, Math.ceil(72 / band));
	let out = '';
	buckets.forEach((b, i) => {
		if (i % every === 0) { out += '<text class="tick" x="' + (left + band * (i + 0.5)) + '" y="' + (height - 6) + '" text-anchor="middle">' + esc(bucketLabel(b.start, bucket, false)) + '</text>'; }
	});
	return out;
}
function yAxis(scale, y, left, right, format) {
	return scale.ticks.map(v => '<line class="gridline" x1="' + left + '" x2="' + right + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="tick" x="' + (left - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(format(v)) + '</text>').join('');
}

// ---- Cost over time ----

function renderTimeline() {
	const el = $('a-timeline');
	const width = el.clientWidth;
	if (!result || width <= 0) { return; }
	const t = result.timeline;
	const keys = assignSlots(view.stackBy, t.series);
	$('a-legend').innerHTML = t.series.length > 1 ? t.series.map((key, i) => '<button type="button" data-s="' + i + '"' + (key.value === OTHER ? ' disabled' : '') + '><span class="swatch ' + keys[i] + '"></span><span class="name">' + esc(labelOf(view.stackBy, key)) + '</span></button>').join('') : '';
	const height = 220;
	const m = { top: 20, right: 8, bottom: 24, left: 60 };
	const plotWidth = Math.max(10, width - m.left - m.right);
	const plotHeight = height - m.top - m.bottom;
	const totals = t.buckets.map(b => b.values.reduce((sum, v) => sum + v, 0));
	const scale = niceScale(Math.max(0, ...totals), 4);
	const y = v => Math.round(m.top + plotHeight - v / scale.top * plotHeight) + 0.5;
	const band = plotWidth / Math.max(1, t.buckets.length);
	const barWidth = Math.max(2, Math.min(24, band * 0.7));
	let svg = '<svg width="' + width + '" height="' + height + '" role="img" aria-label="' + esc(S.timelineAria) + '">';
	svg += yAxis(scale, y, m.left, width - m.right, v => axisMoney(v, scale.step));
	const peak = totals.indexOf(Math.max(...totals));
	t.buckets.forEach((b, i) => {
		const x = m.left + band * i + (band - barWidth) / 2;
		const label = bucketLabel(b.start, t.bucket, true) + ': ' + money(totals[i]);
		svg += '<g class="bucket" data-i="' + i + '" tabindex="0" role="button" aria-label="' + esc(label) + '"><rect class="hit" x="' + (m.left + band * i) + '" y="' + m.top + '" width="' + band + '" height="' + plotHeight + '"/>';
		let acc = 0;
		const drawn = b.values.map((v, s) => ({ v, s })).filter(item => item.v > 0);
		drawn.forEach((item, index) => {
			const bottom = y(acc) - (index > 0 ? 2 : 0);
			acc += item.v;
			const top = y(acc);
			const h = bottom - top;
			if (h < 0.5) { return; }
			const d = index === drawn.length - 1 ? barPath(x, top, barWidth, h, 4) : 'M' + x + ' ' + top + 'h' + barWidth + 'v' + h + 'h' + (-barWidth) + 'Z';
			svg += '<path class="s ' + keys[item.s] + '" data-s="' + item.s + '" d="' + d + '"/>';
		});
		svg += '</g>';
	});
	if (totals[peak] > 0) {
		svg += '<text class="value" x="' + (m.left + band * (peak + 0.5)) + '" y="' + (y(totals[peak]) - 6) + '" text-anchor="middle">' + esc(money(totals[peak])) + '</text>';
	}
	svg += '<line class="axis" x1="' + m.left + '" x2="' + (width - m.right) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
	svg += xLabels(t.buckets, band, m.left, height, t.bucket) + '</svg>';
	el.innerHTML = svg;
}
function timelineTooltip(i, s, x, y) {
	const t = result.timeline;
	const b = t.buckets[i];
	const keys = assignSlots(view.stackBy, t.series);
	const total = b.values.reduce((sum, v) => sum + v, 0);
	const rows = [{ value: money(total), label: S.cost + ' · ' + requestsText(b.requests) }];
	t.series.forEach((key, index) => {
		if (b.values[index] > 0) { rows.push({ key: keys[index], value: money(b.values[index]), label: labelOf(view.stackBy, key), current: index === s }); }
	});
	showTooltip(x, y, bucketLabel(b.start, t.bucket, true), rows);
}
function drillTimeline(i, s) {
	const b = result.timeline.buckets[i];
	filters.range = 'custom';
	filters.from = isoDay(b.start);
	filters.to = isoDay(b.end - 1);
	if (s !== undefined) { applyDimension(view.stackBy, result.timeline.series[s].value); }
	if (view.compare === 'month') { view.compare = 'previous'; }
	filtersChanged();
}

// ---- Tokens over time ----

const TOKEN_SERIES = [['promptTokens', 'prompt', 'l0', 'k0'], ['completionTokens', 'completion', 'l1', 'k1'], ['cachedTokens', 'cached', 'l2', 'k2']];

function renderTokens() {
	const el = $('a-tokens');
	const width = el.clientWidth;
	if (!result || width <= 0) { return; }
	const t = result.timeline;
	$('a-tokens-legend').innerHTML = TOKEN_SERIES.map(([, label, , key]) => '<span class="legend-item"><span class="linekey ' + key + '"></span>' + esc(S[label]) + '</span>').join('');
	const height = 180;
	const m = { top: 12, right: 12, bottom: 24, left: 52 };
	const plotWidth = Math.max(10, width - m.left - m.right);
	const plotHeight = height - m.top - m.bottom;
	const scale = niceScale(Math.max(0, ...t.buckets.map(b => Math.max(b.promptTokens, b.completionTokens, b.cachedTokens))), 3);
	const y = v => Math.round(m.top + plotHeight - v / scale.top * plotHeight) + 0.5;
	const band = plotWidth / Math.max(1, t.buckets.length);
	const x = i => m.left + band * (i + 0.5);
	let svg = '<svg width="' + width + '" height="' + height + '" role="img" aria-label="' + esc(S.tokensAria) + '">';
	svg += yAxis(scale, y, m.left, width - m.right, v => tokens(Math.round(v)));
	svg += '<line class="axis" x1="' + m.left + '" x2="' + (width - m.right) + '" y1="' + y(0) + '" y2="' + y(0) + '"/>';
	for (const [field, , line, key] of TOKEN_SERIES) {
		const points = t.buckets.map((b, i) => x(i) + ' ' + y(b[field]));
		if (points.length > 1) { svg += '<path class="series-line ' + line + '" d="M' + points.join('L') + '"/>'; }
		const last = t.buckets.length - 1;
		if (last >= 0) { svg += '<circle class="dot ' + key + '" cx="' + x(last) + '" cy="' + y(t.buckets[last][field]) + '" r="4"/>'; }
	}
	svg += '<line class="cross" id="a-cross" x1="0" x2="0" y1="' + m.top + '" y2="' + (m.top + plotHeight) + '" visibility="hidden"/>';
	svg += '<rect class="overlay" x="' + m.left + '" y="' + m.top + '" width="' + plotWidth + '" height="' + plotHeight + '" data-band="' + band + '" data-left="' + m.left + '"/>';
	svg += xLabels(t.buckets, band, m.left, height, t.bucket) + '</svg>';
	el.innerHTML = svg;
}
function tokensPointer(event) {
	const overlay = event.target.closest('.overlay');
	if (!overlay || !result || !result.timeline.buckets.length) { return; }
	const t = result.timeline;
	const band = Number(overlay.dataset.band);
	const left = Number(overlay.dataset.left);
	const svgLeft = overlay.ownerSVGElement.getBoundingClientRect().left;
	const i = Math.max(0, Math.min(t.buckets.length - 1, Math.floor((event.clientX - svgLeft - left) / band)));
	const cross = $('a-cross');
	const cx = Math.round(left + band * (i + 0.5)) + 0.5;
	cross.setAttribute('x1', cx);
	cross.setAttribute('x2', cx);
	cross.setAttribute('visibility', 'visible');
	const b = t.buckets[i];
	showTooltip(event.clientX, event.clientY, bucketLabel(b.start, t.bucket, true), TOKEN_SERIES.map(([field, label, , key]) => ({ key, value: tokens(b[field]), label: S[label] })));
}

// ---- KPI cards ----

/** The change from the previous period as an arrow and a percentage, e.g. "▲ 12%". */
function changeParts(current, previous) {
	if (current === undefined || previous === undefined) { return undefined; }
	const absolute = current - previous;
	if (Math.abs(absolute) < 1e-9) { return { cls: '', arrow: '=', text: S.changeSame, aria: S.changeSame }; }
	const up = absolute > 0;
	const percent = previous ? Math.abs(absolute / previous) : undefined;
	const text = percent === undefined ? S.changeNew : (percent * 100).toFixed(percent < 0.1 ? 1 : 0) + '%';
	return { cls: up ? 'up' : 'down', arrow: up ? '▲' : '▼', text, aria: (up ? S.changeUp : S.changeDown) + ' ' + text };
}
function changeHtml(current, previous) {
	const parts = changeParts(current, previous);
	return parts ? '<span class="delta ' + parts.cls + '" aria-label="' + esc(parts.aria) + '"><span class="arrow" aria-hidden="true">' + esc(parts.arrow) + '</span> <span aria-hidden="true">' + esc(parts.text) + '</span></span>' : '<span class="muted">–</span>';
}
function renderKpis() {
	const k = result.kpis;
	const p = result.comparison ? result.comparison.previousKpis : undefined;
	const cards = [
		{ label: S.kTotal, value: money(k.cost), sub: k.withoutCost ? fmt(S.kWithoutCost, num(k.withoutCost)) : '', cls: 'total', field: 'cost', format: money },
		{ label: S.requests, value: num(k.requests), field: 'requests', format: num },
		{ label: S.kAvg, value: money(k.averageCost), field: 'averageCost', format: money },
		{ label: S.kMedian, value: money(k.medianCost), field: 'medianCost', format: money },
		{ label: S.kP95, value: money(k.p95Cost), title: S.kP95Title, field: 'p95Cost', format: money },
		{ label: S.kPrompt, value: tokens(k.promptTokens), field: 'promptTokens', format: tokens },
		{ label: S.kCompletion, value: tokens(k.completionTokens), field: 'completionTokens', format: tokens },
		{ label: S.kCached, value: tokens(k.cachedTokens), field: 'cachedTokens', format: tokens },
		{ label: S.kCacheShare, value: pct(k.cacheShare), title: S.kCacheShareTitle, field: 'cacheShare', format: pct },
		{ label: S.kPerMillion, value: money(k.costPerMillionTokens), title: S.kPerMillionTitle, field: 'costPerMillionTokens', format: money },
		{ label: S.kPerDay, value: money(k.averagePerActiveDay), sub: fmt(k.activeDays === 1 ? S.kOneDay : S.kDays, num(k.activeDays)), field: 'averagePerActiveDay', format: money },
		k.projection ? { label: S.kProjected, value: money(k.projection.projected), sub: fmt(S.kSoFar, money(k.projection.monthCost)), title: fmt(S.kProjectedTitle, money(k.projection.monthCost), k.projection.daysElapsed, k.projection.daysInMonth) } : undefined,
		{ label: S.kSubagentShare, value: pct(k.subagentShare) },
	].filter(Boolean);
	$('a-kpis').innerHTML = cards.map(c => {
		const parts = p && c.field ? changeParts(k[c.field], p[c.field]) : undefined;
		const delta = parts ? '<div class="delta ' + parts.cls + '" title="' + esc(fmt(S.previousValue, c.format(p[c.field]))) + '"><span class="arrow" aria-hidden="true">' + esc(parts.arrow) + '</span> ' + esc(fmt(S.vsPrevious, parts.text)) + '</div>' : '';
		return '<div class="card ' + (c.cls || '') + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '><div class="label">' + esc(c.label) + '</div><div class="value">' + esc(c.value) + '</div>' + (c.sub ? '<div class="sub">' + esc(c.sub) + '</div>' : '') + delta + '</div>';
	}).join('');
}

// ---- Comparison with the previous period ----

function periodLabel(period) {
	const from = new Date(period.from);
	const last = new Date(period.to - 1);
	const options = { month: 'short', day: 'numeric', year: from.getFullYear() !== last.getFullYear() || from.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined };
	const start = from.toLocaleDateString(undefined, options);
	const end = last.toLocaleDateString(undefined, options);
	return start === end ? start : start + ' – ' + end;
}
function renderComparison() {
	const panel = $('a-compare-panel');
	panel.hidden = view.compare === 'off';
	if (panel.hidden) { return; }
	const c = result.comparison;
	$('a-compare-title').textContent = view.compare === 'month' ? S.compareMonthTitle : S.compareTitle;
	if (!c) {
		$('a-compare-periods').textContent = '';
		$('a-compare-table').innerHTML = '<div class="compare-empty">' + esc(S.compareNoRange) + '</div>';
		return;
	}
	$('a-compare-periods').textContent = fmt(S.comparePeriods, periodLabel(c.current), periodLabel(c.previous));
	const dim = view.compareBy;
	const rows = dim === 'model' ? c.byModel : c.byKey;
	const metrics = [[S.metricCost, a => a.cost, money], [S.metricRequests, a => a.requests, num], [S.metricTokens, a => a.promptTokens + a.completionTokens, tokens]];
	const cells = (current, previous) => metrics.map(([, value, format]) => {
		const x = value(current); const y = value(previous);
		const absolute = x - y;
		const sign = absolute > 0 ? '+' : absolute < 0 ? '−' : '';
		return '<td class="num first">' + esc(format(x)) + '</td><td class="num muted">' + esc(format(y)) + '</td><td class="num">' + esc(sign + format(Math.abs(absolute))) + '</td><td class="num">' + changeHtml(x, y) + '</td>';
	}).join('');
	let html = '<table class="compare"><thead><tr><th rowspan="2">' + esc(S['dim_' + dim]) + '</th>' + metrics.map(([label]) => '<th class="group" colspan="4">' + esc(label) + '</th>').join('') + '</tr><tr>'
		+ metrics.map(() => '<th class="num first">' + esc(S.compareThis) + '</th><th class="num">' + esc(S.comparePrev) + '</th><th class="num">' + esc(S.compareChange) + '</th><th class="num">%</th>').join('') + '</tr></thead><tbody>';
	rows.forEach((row, i) => {
		const label = labelOf(dim, row);
		html += '<tr data-i="' + i + '"' + (row.value === OTHER ? ' class="other"' : ' tabindex="0"') + '><th scope="row" title="' + esc(label) + '">' + esc(label) + '</th>' + cells(row.current, row.previous) + '</tr>';
	});
	html += '</tbody><tfoot><tr><th scope="row">' + esc(S.totalCol) + '</th>' + cells(c.total.current, c.total.previous) + '</tr></tfoot></table>';
	$('a-compare-table').innerHTML = html;
}

// ---- Breakdown ----

function renderBreakdown() {
	const rows = result.breakdown;
	const max = Math.max(0, ...rows.map(r => r.cost));
	$('a-breakdown').innerHTML = '<div class="bd-head"><span>' + esc(S['dim_' + view.breakdownBy]) + '</span><span class="bd-bar"></span><span class="num">' + esc(S.cost) + '</span><span class="num">' + esc(S.share) + '</span><span class="num bd-req">' + esc(S.requests) + '</span></div>'
		+ rows.map((r, i) => {
			const label = labelOf(view.breakdownBy, r);
			const width = max > 0 ? Math.max(r.cost > 0 ? 0.5 : 0, r.cost / max * 100) : 0;
			return '<button type="button" class="bd-row" data-i="' + i + '"' + (r.value === OTHER ? ' disabled' : '') + '>'
				+ '<span class="bd-label" title="' + esc(label) + '">' + esc(label) + '</span>'
				+ '<span class="bd-bar"><svg width="100%" height="10" aria-hidden="true"><rect class="track" width="100%" height="10" rx="2"/><rect class="k0" width="' + width.toFixed(2) + '%" height="10" rx="2"/></svg></span>'
				+ '<span class="num">' + esc(money(r.cost)) + '</span><span class="num muted">' + esc(pct(r.share)) + '</span><span class="num muted bd-req">' + esc(requestsText(r.requests)) + '</span></button>';
		}).join('');
}

// ---- Pivot ----

function metricValue(a) {
	switch (view.pivotMetric) {
		case 'requests': return a.requests;
		case 'tokens': return a.promptTokens + a.completionTokens;
		case 'avg': return a.costed ? a.cost / a.costed : undefined;
		default: return a.cost;
	}
}
function metricText(a) {
	if (!a.requests) { return '<span class="zero">–</span>'; }
	const v = metricValue(a);
	return esc(view.pivotMetric === 'requests' ? num(v) : view.pivotMetric === 'tokens' ? tokens(v) : money(v));
}
function sortHeader(label, column, active, descending, numeric) {
	const sorted = active === column;
	return '<th' + (numeric ? ' class="num"' : '') + (sorted ? ' aria-sort="' + (descending ? 'descending' : 'ascending') + '"' : '') + '><button type="button" class="sort" data-col="' + esc(String(column)) + '">' + esc(label) + (sorted ? '<span class="arrow" aria-hidden="true">' + (descending ? '↓' : '↑') + '</span>' : '') + '</button></th>';
}
function renderPivot() {
	const p = result.pivot;
	const rowsDim = view.pivotRows;
	const columnsDim = view.pivotColumns;
	const order = p.rows.map((_, r) => r);
	const valueFor = r => view.pivotSort === 'label' ? labelOf(rowsDim, p.rows[r]).toLowerCase() : view.pivotSort === 'total' ? metricValue(p.rowTotals[r]) : metricValue(p.cells[r][Number(view.pivotSort)] || { cost: 0, requests: 0, costed: 0, promptTokens: 0, completionTokens: 0 });
	order.sort((a, b) => {
		if (p.rows[a].value === OTHER) { return 1; }
		if (p.rows[b].value === OTHER) { return -1; }
		const x = valueFor(a); const y = valueFor(b);
		const cmp = typeof x === 'string' ? x.localeCompare(y) : (x ?? -1) - (y ?? -1);
		return view.pivotDescending ? -cmp : cmp;
	});
	let html = '<table class="pivot"><thead><tr>' + sortHeader(S['dim_' + rowsDim], 'label', view.pivotSort, view.pivotDescending, false);
	p.columns.forEach((c, i) => { html += sortHeader(labelOf(columnsDim, c), String(i), view.pivotSort, view.pivotDescending, true); });
	html += sortHeader(S.totalCol, 'total', view.pivotSort, view.pivotDescending, true) + '</tr></thead><tbody>';
	for (const r of order) {
		const key = p.rows[r];
		const other = key.value === OTHER;
		const label = labelOf(rowsDim, key);
		html += '<tr data-r="' + r + '"' + (other ? ' class="other"' : '') + '><th scope="row" title="' + esc(label) + '">' + esc(label) + '</th>';
		p.columns.forEach((c, i) => { html += '<td class="num' + (other || c.value === OTHER ? '' : ' cell') + '" data-c="' + i + '">' + metricText(p.cells[r][i]) + '</td>'; });
		html += '<td class="num total">' + metricText(p.rowTotals[r]) + '</td></tr>';
	}
	html += '</tbody><tfoot><tr><th scope="row">' + esc(S.totalCol) + '</th>';
	p.columnTotals.forEach(c => { html += '<td class="num">' + metricText(c) + '</td>'; });
	html += '<td class="num">' + metricText(p.total) + '</td></tr></tfoot></table>';
	$('a-pivot').innerHTML = html;
}

// ---- Requests ----

const COLUMNS = [
	{ id: 'time', label: S.colTime, render: r => esc(new Date(r.time).toLocaleString()) },
	{ id: 'key', label: S.dim_key, render: r => r.providerGroup ? esc(r.providerGroup) : '<span class="muted">–</span>' },
	{ id: 'model', label: S.dim_model, render: r => esc(r.model) },
	{ id: 'gateway', label: S.dim_gateway, render: r => esc(gatewayLabel(r)) },
	{ id: 'chat', label: S.dim_chat, wrap: true, render: r => esc(r.rootTitle || S.untitled) + (r.subagent ? ' <span class="badge">' + esc(S.subagentBadge) + '</span>' : '') },
	{ id: 'issue', label: S.dim_issue, render: r => !r.issueLabel ? '<span class="muted">–</span>' : r.issueUrl ? '<a href="' + esc(r.issueUrl) + '">' + esc(r.issueLabel) + '</a>' : esc(r.issueLabel) },
	{ id: 'repo', label: S.colRepoBranch, render: r => (r.repo || r.branch) ? esc(r.repo || '') + (r.branch ? '<div class="muted">' + esc(r.branch) + '</div>' : '') : '<span class="muted">–</span>' },
	{ id: 'promptTokens', label: S.prompt, numeric: true, render: r => r.promptTokens === undefined ? '–' : esc(num(r.promptTokens)) },
	{ id: 'completionTokens', label: S.completion, numeric: true, render: r => r.completionTokens === undefined ? '–' : esc(num(r.completionTokens)) },
	{ id: 'cachedTokens', label: S.cached, numeric: true, render: r => r.cachedTokens === undefined ? '–' : esc(num(r.cachedTokens)) },
	{ id: 'cost', label: S.colCost, numeric: true, render: r => '<b>' + esc(money(r.cost)) + '</b>' },
	{ id: 'costSource', label: S.dim_costSource, render: r => esc(sourceLabel(r.costSource)) },
	{ id: 'requestId', label: S.colRequestId, render: r => r.gatewayRequestId ? '<code>' + esc(r.gatewayRequestId) + '</code>' : '<span class="muted">–</span>' },
];

function renderColumnChooser() {
	const hidden = new Set(view.hidden);
	$('a-columns-body').innerHTML = COLUMNS.map(c => '<label class="check"><input type="checkbox" data-col="' + c.id + '"' + (hidden.has(c.id) ? '' : ' checked') + '>' + esc(c.label) + '</label>').join('');
}
function detailFields(r) {
	const via = r.issueSource === 'branch' ? S.viaBranch : r.issueSource === 'prompt' ? S.viaPrompt : r.issueSource === 'agent' ? S.viaAgent : r.issueSource;
	return [
		[S.colTime, new Date(r.time).toLocaleString() + ' (' + new Date(r.time).toISOString() + ')'],
		[S.fRootTitle, r.rootTitle], [S.fChatTitle, r.chatTitle], [S.dim_kind, r.subagent ? S.subagent : S.main],
		[S.fRootChatId, r.rootChatId], [S.fChatId, r.chatId],
		[S.dim_issue, r.issueLabel], [S.fIssueSource, via],
		[S.dim_repo, r.repo], [S.dim_branch, r.branch],
		[S.dim_gateway, GATEWAY_NAMES[r.gateway] || r.gateway], [S.fGatewayHost, r.gatewayHost], [S.dim_key, r.providerGroup], [S.dim_model, r.model],
		[S.colRequestId, r.gatewayRequestId],
		[S.prompt, r.promptTokens === undefined ? undefined : num(r.promptTokens)], [S.completion, r.completionTokens === undefined ? undefined : num(r.completionTokens)], [S.cached, r.cachedTokens === undefined ? undefined : num(r.cachedTokens)],
		[S.fCostFull, r.cost === undefined ? undefined : '$' + r.cost], [S.dim_costSource, r.costSource ? sourceLabel(r.costSource) : undefined],
		[S.fId, r.id],
	].filter(([, v]) => v !== undefined && v !== '');
}
function renderRequests() {
	const hidden = new Set(view.hidden);
	const columns = COLUMNS.filter(c => !hidden.has(c.id));
	const rows = result.requests.rows;
	let html = '<table class="requests"><thead><tr>' + columns.map(c => sortHeader(c.label, c.id, view.sortColumn, view.sortDescending, c.numeric)).join('') + '</tr></thead><tbody>';
	for (const r of rows) {
		const open = expanded.has(r.id);
		html += '<tr class="req" data-id="' + esc(r.id) + '" tabindex="0" aria-expanded="' + open + '">' + columns.map(c => '<td class="' + (c.numeric ? 'num' : '') + (c.wrap ? ' wrap' : '') + '">' + c.render(r) + '</td>').join('') + '</tr>';
		if (open) {
			html += '<tr class="details"><td colspan="' + columns.length + '"><dl class="fields">' + detailFields(r).map(([label, value]) => '<dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd>').join('') + '</dl></td></tr>';
		}
	}
	html += '</tbody></table>';
	$('a-requests').innerHTML = html;
	$('a-page').textContent = fmt(S.pageOf, result.requests.page + 1, result.requests.pageCount);
	$('a-prev').disabled = result.requests.page <= 0;
	$('a-next').disabled = result.requests.page >= result.requests.pageCount - 1;
}

// ---- Rendering ----

function renderAdvanced() {
	if (!result) { return; }
	$('a-count').textContent = fmt(S.countOf, num(result.matching), num(result.total));
	renderChips();
	if (openDimension) { renderPopoverList(); }
	const empty = result.matching === 0;
	$('a-empty').hidden = !empty;
	$('a-empty').textContent = result.total === 0 ? S.empty : S.noMatch;
	$('a-content').hidden = empty;
	if (empty) { return; }
	renderKpis();
	renderComparison();
	renderTimeline();
	renderBreakdown();
	renderTokens();
	renderPivot();
	renderRequests();
}

// ---- Events ----

function initAdvanced() {
	fillDimensionSelects();
	renderColumnChooser();
	syncControls();

	const tabs = [...document.querySelectorAll('.tabs .tab')];
	for (const tab of tabs) {
		tab.addEventListener('click', () => showTab(tab.dataset.tab));
		tab.addEventListener('keydown', event => {
			if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
				const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
				showTab(next.dataset.tab);
				next.focus();
			}
		});
	}

	$('a-range').addEventListener('change', event => {
		filters.range = event.target.value;
		if (filters.range === 'custom' && !filters.from && !filters.to) {
			filters.from = isoDay(Date.now() - 29 * 864e5);
			filters.to = isoDay(Date.now());
		}
		filtersChanged();
	});
	for (const id of ['a-from', 'a-to']) {
		$(id).addEventListener('change', event => {
			filters[id === 'a-from' ? 'from' : 'to'] = event.target.value;
			filters.range = 'custom';
			filtersChanged();
		});
	}
	for (const button of document.querySelectorAll('.segmented button')) {
		button.addEventListener('click', () => { filters.kind = button.dataset.kind; filtersChanged(); });
	}
	$('a-nocost').addEventListener('change', event => { filters.withoutCost = event.target.checked; filtersChanged(); });
	for (const [id, field] of [['a-min', 'minCost'], ['a-max', 'maxCost'], ['a-text', 'text']]) {
		$(id).addEventListener('input', event => { filters[field] = event.target.value; filtersChanged(); });
	}
	$('a-reset').addEventListener('click', () => { filters = defaultFilters(); filtersChanged(); });
	$('a-export-csv').addEventListener('click', () => vscode.postMessage({ type: 'exportFiltered', format: 'csv', filters: queryFilters() }));
	$('a-export-json').addEventListener('click', () => vscode.postMessage({ type: 'exportFiltered', format: 'json', filters: queryFilters() }));
	$('a-chips').addEventListener('click', event => { const chip = event.target.closest('.chip'); if (chip) { removeChip(chip); } });

	$('a-multis').addEventListener('click', event => {
		const button = event.target.closest('.multi');
		if (!button) { return; }
		if (openDimension === button.dataset.dim) { closePopover(); } else { openPopover(button.dataset.dim, button); }
	});
	$('a-pop-search').addEventListener('input', renderPopoverList);
	$('a-pop-list').addEventListener('change', event => { if (event.target.dataset.value !== undefined) { toggleOption(event.target.dataset.value, event.target.checked); } });
	$('a-pop-clear').addEventListener('click', () => { filters.values = Object.assign({}, filters.values, { [openDimension]: [] }); filtersChanged(); renderPopoverList(); });
	document.addEventListener('pointerdown', event => {
		if (openDimension && !$('a-popover').contains(event.target) && !event.target.closest('.multi')) { closePopover(); }
		const menu = $('a-columns');
		if (menu.open && !menu.contains(event.target)) { menu.open = false; }
	});
	document.addEventListener('keydown', event => { if (event.key === 'Escape') { closePopover(true); $('a-columns').open = false; hideTooltip(); } });
	window.addEventListener('resize', () => closePopover());
	window.addEventListener('scroll', () => closePopover());

	const viewSelects = [['a-stack', 'stackBy'], ['a-bucket', 'bucket'], ['a-breakdown-by', 'breakdownBy'], ['a-pivot-rows', 'pivotRows'], ['a-pivot-columns', 'pivotColumns']];
	for (const [id, field] of viewSelects) {
		$(id).addEventListener('change', event => {
			view[field] = event.target.value;
			if (field === 'pivotColumns' && /^\d+$/.test(String(view.pivotSort))) { view.pivotSort = 'total'; }
			scheduleQuery(0);
		});
	}
	$('a-pivot-metric').addEventListener('change', event => { view.pivotMetric = event.target.value; saveState(); renderPivot(); });
	$('a-compare').addEventListener('change', event => {
		view.compare = event.target.value;
		if (view.compare === 'month' && filters.range !== 'thisMonth') {
			filters.range = 'thisMonth';
			filtersChanged();
			return;
		}
		scheduleQuery(0);
	});
	$('a-compare-by').addEventListener('change', event => { view.compareBy = event.target.value; saveState(); if (result) { renderComparison(); } });
	const drillComparison = event => {
		const tr = event.target.closest('tbody tr');
		const rows = result && result.comparison ? (view.compareBy === 'model' ? result.comparison.byModel : result.comparison.byKey) : [];
		if (tr && !tr.classList.contains('other') && rows[Number(tr.dataset.i)] && applyDimension(view.compareBy, rows[Number(tr.dataset.i)].value)) { filtersChanged(); }
	};
	$('a-compare-table').addEventListener('click', drillComparison);
	$('a-compare-table').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); drillComparison(event); } });

	const timeline = $('a-timeline');
	timeline.addEventListener('pointermove', event => {
		const bucket = event.target.closest('.bucket');
		for (const active of timeline.querySelectorAll('.bucket.active')) { if (active !== bucket) { active.classList.remove('active'); } }
		if (!bucket) { timeline.classList.remove('hovering'); hideTooltip(); return; }
		bucket.classList.add('active');
		timeline.classList.add('hovering');
		const segment = event.target.closest('.s');
		timelineTooltip(Number(bucket.dataset.i), segment ? Number(segment.dataset.s) : undefined, event.clientX, event.clientY);
	});
	timeline.addEventListener('pointerleave', () => { timeline.classList.remove('hovering'); hideTooltip(); });
	timeline.addEventListener('focusin', event => {
		const bucket = event.target.closest('.bucket');
		if (bucket) { const rect = bucket.getBoundingClientRect(); timelineTooltip(Number(bucket.dataset.i), undefined, rect.right, rect.top); }
	});
	timeline.addEventListener('focusout', hideTooltip);
	timeline.addEventListener('click', event => {
		const bucket = event.target.closest('.bucket');
		if (!bucket) { return; }
		const segment = event.target.closest('.s');
		hideTooltip();
		drillTimeline(Number(bucket.dataset.i), segment && result.timeline.series[Number(segment.dataset.s)].value !== OTHER ? Number(segment.dataset.s) : undefined);
	});
	timeline.addEventListener('keydown', event => {
		const bucket = event.target.closest('.bucket');
		if (bucket && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); hideTooltip(); drillTimeline(Number(bucket.dataset.i)); }
	});
	$('a-legend').addEventListener('click', event => {
		const item = event.target.closest('button[data-s]');
		if (item && applyDimension(view.stackBy, result.timeline.series[Number(item.dataset.s)].value)) { filtersChanged(); }
	});

	const tokensChart = $('a-tokens');
	tokensChart.addEventListener('pointermove', tokensPointer);
	tokensChart.addEventListener('pointerleave', () => { $('a-cross')?.setAttribute('visibility', 'hidden'); hideTooltip(); });

	$('a-breakdown').addEventListener('click', event => {
		const row = event.target.closest('.bd-row');
		if (row && applyDimension(view.breakdownBy, result.breakdown[Number(row.dataset.i)].value)) { filtersChanged(); }
	});

	$('a-pivot').addEventListener('click', event => {
		const sort = event.target.closest('.sort');
		if (sort) {
			const column = sort.dataset.col;
			view.pivotDescending = view.pivotSort === column ? !view.pivotDescending : column !== 'label';
			view.pivotSort = column;
			saveState();
			renderPivot();
			return;
		}
		const tr = event.target.closest('tbody tr');
		if (!tr || tr.classList.contains('other')) { return; }
		const p = result.pivot;
		let changed = applyDimension(view.pivotRows, p.rows[Number(tr.dataset.r)].value);
		const cell = event.target.closest('td.cell');
		if (cell && view.pivotColumns !== 'none') { changed = applyDimension(view.pivotColumns, p.columns[Number(cell.dataset.c)].value) || changed; }
		if (changed) { filtersChanged(); }
	});

	$('a-requests').addEventListener('click', event => {
		const sort = event.target.closest('.sort');
		if (sort) {
			const column = sort.dataset.col;
			const numeric = COLUMNS.find(c => c.id === column)?.numeric || column === 'time';
			view.sortDescending = view.sortColumn === column ? !view.sortDescending : numeric;
			view.sortColumn = column;
			view.page = 0;
			scheduleQuery(0);
			return;
		}
		if (event.target.closest('a')) { return; }
		const row = event.target.closest('tr.req');
		if (row) { toggleRow(row.dataset.id); }
	});
	$('a-requests').addEventListener('keydown', event => {
		const row = event.target.closest('tr.req');
		if (row && (event.key === 'Enter' || event.key === ' ') && event.target === row) { event.preventDefault(); toggleRow(row.dataset.id); }
	});
	$('a-columns-body').addEventListener('change', event => {
		const column = event.target.dataset.col;
		view.hidden = event.target.checked ? view.hidden.filter(c => c !== column) : view.hidden.concat([column]);
		saveState();
		if (result) { renderRequests(); }
	});
	$('a-prev').addEventListener('click', () => { view.page = Math.max(0, view.page - 1); scheduleQuery(0); });
	$('a-next').addEventListener('click', () => { view.page = view.page + 1; scheduleQuery(0); });

	let lastWidth = 0;
	new ResizeObserver(() => {
		const width = $('a-timeline').clientWidth;
		if (width !== lastWidth && result && !$('a-content').hidden) {
			lastWidth = width;
			requestAnimationFrame(() => { renderTimeline(); renderTokens(); });
		}
	}).observe($('a-content'));

	window.addEventListener('message', event => {
		const message = event.data;
		if (message?.type === 'result' && message.seq === querySeq) {
			result = message.result;
			view.page = result.requests.page;
			$('advanced').classList.remove('loading');
			renderAdvanced();
		} else if (message?.type === 'entries' && currentTab === 'advanced') {
			scheduleQuery(400);
		}
	});

	showTab(currentTab);
}
function toggleRow(id) {
	if (expanded.has(id)) { expanded.delete(id); } else { expanded.add(id); }
	renderRequests();
	document.querySelector('tr.req[data-id="' + CSS.escape(id) + '"]')?.focus();
}

initAdvanced();
`;
