/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Subscription Usage page. Per provider (Claude, Codex) a card with the pool as a
// whole, and below it one row per account with a bar per usage window and the account's actions. The
// pool and every account also show their usage of the past weeks per day (with a verdict on whether the
// pool has enough accounts), read from the usage history the agent host records
// (`agent-subscription-usage-history.jsonl` in the user's `globalStorage`).

import './media/subscriptionUsage.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { toAction } from '../../../../../base/common/actions.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ISubscriptionAccount, ISubscriptionUsageWindow, SubscriptionAccountStatus, SubscriptionProvider, getRemainingPercent } from '../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { ISubscriptionUsageSample, SUBSCRIPTION_USAGE_HISTORY_FILE, getPoolVerdict, parseUsageHistory, summarizeUsageHistory } from '../../../../../platform/agentHost/common/meta/subscriptionUsageHistory.js';
import { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../browser/parts/editor/editorPane.js';
import { EditorInputCapabilities, IEditorOpenContext, IUntypedEditorInput } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { ISubscriptionAccountsService, ISubscriptionPoolSummary, SUBSCRIPTION_PROVIDERS, formatAvailability, formatRemaining, formatResetsIn, formatShortDuration, getEarliestReset, getPoolSummaries, getSubscriptionProviderLabel } from '../../../../services/agentHost/browser/subscriptionAccountsService.js';
import { SubscriptionAccountsFlows } from './subscriptionAccountsFlows.js';
import { USAGE_HISTORY_DAYS, formatAccountHistorySummary, formatPoolHistorySummary, formatPoolVerdict, formatUsageDay, renderUsageActivity, renderUsageDayChart } from './subscriptionUsageHistoryChart.js';

const $ = DOM.$;

/** Below this share left, a bar turns into a warning. */
const LOW_REMAINING_PERCENT = 20;

export class SubscriptionUsageEditorInput extends EditorInput {

	static readonly ID = 'workbench.editors.subscriptionUsage';
	private static instance: SubscriptionUsageEditorInput | undefined;

	readonly resource = undefined;

	static getOrCreate(): SubscriptionUsageEditorInput {
		if (!SubscriptionUsageEditorInput.instance || SubscriptionUsageEditorInput.instance.isDisposed()) {
			SubscriptionUsageEditorInput.instance = new SubscriptionUsageEditorInput();
		}
		return SubscriptionUsageEditorInput.instance;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.Singleton;
	}

	override get typeId(): string {
		return SubscriptionUsageEditorInput.ID;
	}

	override getName(): string {
		return localize('subscriptionUsage.editorName', "Subscription Usage");
	}

	override getIcon(): ThemeIcon {
		return Codicon.pulse;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof SubscriptionUsageEditorInput;
	}

	override async resolve(): Promise<null> {
		return null;
	}
}

export class SubscriptionUsageEditor extends EditorPane {

	static readonly ID = 'workbench.editor.subscriptionUsage';

	private readonly _renderDisposables = this._register(new DisposableStore());
	private readonly _flows: SubscriptionAccountsFlows;
	private _container: HTMLElement | undefined;
	private _content: HTMLElement | undefined;
	private _scrollable: DomScrollableElement | undefined;
	private _firstFocusable: Button | undefined;
	/** The usage history samples, by account. */
	private _history = new Map<string, ISubscriptionUsageSample[]>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ISubscriptionAccountsService private readonly _subscriptionAccountsService: ISubscriptionAccountsService,
		@IHoverService private readonly _hoverService: IHoverService,
		@IFileService private readonly _fileService: IFileService,
		@IEnvironmentService private readonly _environmentService: IEnvironmentService,
	) {
		super(SubscriptionUsageEditor.ID, group, telemetryService, themeService, storageService);
		this._flows = instantiationService.createInstance(SubscriptionAccountsFlows);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = DOM.append(parent, $('.subscription-usage-editor'));
		this._content = $('.subscription-usage-content');
		this._scrollable = this._register(new DomScrollableElement(this._content, {
			horizontal: ScrollbarVisibility.Hidden,
			vertical: ScrollbarVisibility.Auto,
		}));
		this._container.appendChild(this._scrollable.getDomNode());

		this._register(autorun(reader => {
			const accounts = this._subscriptionAccountsService.accounts.read(reader);
			const autoSwitch = this._subscriptionAccountsService.autoSwitch.read(reader);
			this._render(accounts, autoSwitch);
		}));
		// Keep "resets in ..." and the history current.
		this._register(DOM.disposableWindowInterval(DOM.getWindow(this._container), () => {
			void this._loadHistory();
		}, 60_000));
	}

	override async setInput(input: SubscriptionUsageEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._subscriptionAccountsService.refreshUsage();
		void this._loadHistory();
	}

	/** Reads the usage history the agent host records and renders the page again. */
	private async _loadHistory(): Promise<void> {
		const resource = joinPath(this._environmentService.userRoamingDataHome, 'globalStorage', SUBSCRIPTION_USAGE_HISTORY_FILE);
		let samples: ISubscriptionUsageSample[] = [];
		try {
			samples = parseUsageHistory((await this._fileService.readFile(resource)).value.toString());
		} catch {
			// No history yet.
		}
		const history = new Map<string, ISubscriptionUsageSample[]>();
		for (const sample of samples.sort((a, b) => a.t - b.t)) {
			let own = history.get(sample.a);
			if (!own) {
				own = [];
				history.set(sample.a, own);
			}
			own.push(sample);
		}
		this._history = history;
		this._render(this._subscriptionAccountsService.accounts.get(), this._subscriptionAccountsService.autoSwitch.get());
	}

	override layout(dimension: DOM.Dimension): void {
		if (!this._container || !this._content || !this._scrollable) {
			return;
		}
		this._container.classList.toggle('narrow', dimension.width < 640);
		for (const element of [this._container, this._content, this._scrollable.getDomNode()]) {
			element.style.width = `${dimension.width}px`;
			element.style.height = `${dimension.height}px`;
		}
		this._scrollable.scanDomNode();
	}

	override focus(): void {
		super.focus();
		this._firstFocusable?.focus();
	}

	private _render(accounts: readonly ISubscriptionAccount[], autoSwitch: boolean): void {
		const content = this._content;
		if (!content) {
			return;
		}
		const scrollTop = content.scrollTop;
		this._renderDisposables.clear();
		DOM.clearNode(content);
		const now = Date.now();
		const page = DOM.append(content, $('.subscription-usage-page'));

		const header = DOM.append(page, $('.subscription-usage-header'));
		const titles = DOM.append(header, $('.subscription-usage-titles'));
		DOM.append(titles, $('h1', undefined, localize('subscriptionUsage.title', "Subscription Usage")));
		DOM.append(titles, $('p.subscription-usage-subtitle', undefined, localize('subscriptionUsage.subtitle', "Your Claude and Codex accounts work as one pool: when an account is used up, its chat continues on the next account.")));
		const refresh = this._renderDisposables.add(new Button(DOM.append(header, $('.subscription-usage-header-actions')), { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this._firstFocusable = refresh;
		refresh.label = `$(refresh) ${localize('subscriptionUsage.refreshAll', "Refresh All")}`;
		this._renderDisposables.add(refresh.onDidClick(() => this._subscriptionAccountsService.refreshUsage()));

		const setting = DOM.append(page, $('.subscription-usage-setting'));
		const checkbox = this._renderDisposables.add(new Checkbox(localize('subscriptionUsage.autoSwitch', "Switch Accounts Automatically"), autoSwitch, defaultCheckboxStyles));
		setting.appendChild(checkbox.domNode);
		const settingLabel = DOM.append(setting, $('.subscription-usage-setting-label'));
		DOM.append(settingLabel, $('span.subscription-usage-setting-title', undefined, localize('subscriptionUsage.autoSwitch', "Switch Accounts Automatically")));
		DOM.append(settingLabel, $('span.subscription-usage-setting-description', undefined, autoSwitch
			? localize('subscriptionUsage.autoSwitchOn', "A used-up account hands its chat to the next account without asking.")
			: localize('subscriptionUsage.autoSwitchOff', "When an account is used up, the chat asks before it continues on the next account.")));
		this._renderDisposables.add(checkbox.onChange(() => this._subscriptionAccountsService.setAutoSwitch(checkbox.checked)));
		this._renderDisposables.add(DOM.addDisposableListener(settingLabel, DOM.EventType.CLICK, () => {
			checkbox.checked = !checkbox.checked;
			void this._subscriptionAccountsService.setAutoSwitch(checkbox.checked);
		}));

		const pools = getPoolSummaries(accounts, now);
		for (const provider of SUBSCRIPTION_PROVIDERS) {
			this._renderProvider(page, provider, accounts.filter(account => account.provider === provider), pools.find(pool => pool.provider === provider), now);
		}

		this._scrollable?.scanDomNode();
		content.scrollTop = scrollTop;
	}

	private _renderProvider(page: HTMLElement, provider: SubscriptionProvider, accounts: readonly ISubscriptionAccount[], pool: ISubscriptionPoolSummary | undefined, now: number): void {
		const providerLabel = getSubscriptionProviderLabel(provider);
		const section = DOM.append(page, $(`section.subscription-usage-provider.${provider}`));
		const sectionHeader = DOM.append(section, $('.subscription-usage-provider-header'));
		DOM.append(sectionHeader, $('h2', undefined, providerLabel));
		const add = this._renderDisposables.add(new Button(sectionHeader, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		add.label = provider === 'claude' ? `$(add) ${localize('subscriptionUsage.addClaude', "Add Claude Account")}` : `$(add) ${localize('subscriptionUsage.addCodex', "Add Codex Account")}`;
		this._renderDisposables.add(add.onDidClick(() => this._flows.addAccount(provider)));

		if (!pool || !accounts.length) {
			const empty = DOM.append(section, $('.subscription-usage-empty'));
			empty.textContent = provider === 'claude'
				? localize('subscriptionUsage.noClaude', "No Claude accounts yet. Add one with a setup-token or a browser sign-in.")
				: localize('subscriptionUsage.noCodex', "No Codex accounts yet. Add one with a ChatGPT sign-in.");
			return;
		}

		// The pool as a whole.
		const card = DOM.append(section, $('.subscription-usage-pool'));
		const figure = DOM.append(card, $('.subscription-usage-pool-figure'));
		DOM.append(figure, $('span.subscription-usage-pool-percent', undefined, pool.remainingPercent === undefined ? '\u2013' : localize('subscriptionUsage.percent', "{0}%", pool.remainingPercent)));
		DOM.append(figure, $('span.subscription-usage-pool-caption', undefined, localize('subscriptionUsage.poolCaption', "left on average")));
		const poolDetails = DOM.append(card, $('.subscription-usage-pool-details'));
		this._renderMeter(poolDetails, pool.remainingPercent, localize('subscriptionUsage.poolMeter', "{0} pool", providerLabel));
		const facts = DOM.append(poolDetails, $('.subscription-usage-pool-facts'));
		DOM.append(facts, $('span', undefined, formatAvailability(pool)));
		if (pool.earliestResetAt !== undefined) {
			DOM.append(facts, $('span', undefined, localize('subscriptionUsage.firstReset', "First reset in {0}", formatShortDuration(pool.earliestResetAt - now))));
		}

		// The pool over the past weeks: is it big enough?
		if (accounts.length > 1) {
			this._renderPoolHistory(section, providerLabel, accounts, now);
		}

		// One row per account, in the order they are tried.
		const list = DOM.append(section, $('ol.subscription-usage-accounts'));
		accounts.forEach((account, index) => this._renderAccount(list, account, index, accounts.length, now));
	}

	private _renderAccount(list: HTMLElement, account: ISubscriptionAccount, index: number, count: number, now: number): void {
		const row = DOM.append(list, $('li.subscription-usage-account'));
		const identity = DOM.append(row, $('.subscription-usage-account-identity'));
		const titleLine = DOM.append(identity, $('.subscription-usage-account-title'));
		DOM.append(titleLine, $('span.subscription-usage-account-label', undefined, account.label));
		this._renderStatus(titleLine, account, now);
		const meta = [account.email, account.planType, account.kind === 'default' ? localize('subscriptionUsage.defaultLogin', "default login") : undefined].filter(Boolean).join(' \u00b7 ');
		if (meta) {
			DOM.append(identity, $('.subscription-usage-account-meta', undefined, meta));
		}
		// A signed-in account can carry a note too, such as why its usage could not be read.
		if (account.error) {
			DOM.append(identity, $('.subscription-usage-account-error', undefined, account.error));
		}

		const windows = DOM.append(row, $('.subscription-usage-windows'));
		if (account.usage?.length) {
			for (const window of account.usage) {
				this._renderWindow(windows, window, account.status === 'limited', now);
			}
		} else {
			DOM.append(windows, $('.subscription-usage-window-empty', undefined, account.status === 'signedIn' || account.status === 'limited' ? formatRemaining(undefined) : ''));
		}

		const actions = this._renderDisposables.add(new ActionBar(DOM.append(row, $('.subscription-usage-account-actions')), {
			ariaLabel: localize('subscriptionUsage.accountActions', "Actions for {0}", account.label),
		}));
		this._renderAccountHistory(row, account, now);
		const canSignIn = account.kind !== 'default' && account.status !== 'signedIn' && account.status !== 'limited' && account.status !== 'signingIn';
		row.classList.toggle('needs-sign-in', canSignIn);
		const editable = account.kind !== 'default';
		actions.push([
			...(canSignIn ? [toAction({ id: 'signIn', label: localize('subscriptionUsage.signIn', "Sign In"), class: ThemeIcon.asClassName(Codicon.signIn), run: () => this._flows.signIn(account) })] : []),
			toAction({ id: 'refresh', label: localize('subscriptionUsage.refresh', "Refresh Usage"), class: ThemeIcon.asClassName(Codicon.refresh), run: () => this._subscriptionAccountsService.refreshUsage(account.provider) }),
			toAction({ id: 'moveUp', label: localize('subscriptionUsage.moveUp', "Move Up"), class: ThemeIcon.asClassName(Codicon.arrowUp), enabled: index > 0, run: () => this._flows.move(account, -1) }),
			toAction({ id: 'moveDown', label: localize('subscriptionUsage.moveDown', "Move Down"), class: ThemeIcon.asClassName(Codicon.arrowDown), enabled: index < count - 1, run: () => this._flows.move(account, 1) }),
			...(editable ? [
				toAction({ id: 'rename', label: localize('subscriptionUsage.rename', "Rename"), class: ThemeIcon.asClassName(Codicon.edit), run: () => this._flows.rename(account) }),
				toAction({ id: 'remove', label: localize('subscriptionUsage.remove', "Remove"), class: ThemeIcon.asClassName(Codicon.trash), run: () => this._flows.remove(account) }),
			] : []),
		], { icon: true, label: false });
	}

	private _renderAccountHistory(row: HTMLElement, account: ISubscriptionAccount, now: number): void {
		const { days } = summarizeUsageHistory(new Map([[account.id, this._history.get(account.id) ?? []]]), now, USAGE_HISTORY_DAYS);
		const history = DOM.append(row, $('.subscription-usage-history'));
		// The summary line doubles as the readout of the day under the pointer.
		const summary = DOM.append(history, $('.subscription-usage-history-summary'));
		summary.setAttribute('aria-live', 'polite');
		this._renderDisposables.add(renderUsageDayChart(history, days, {
			pool: false,
			ariaLabel: localize('subscriptionUsage.accountHistory', "Daily usage of {0} over the past {1} weeks; use the arrow keys to read a day", account.label, USAGE_HISTORY_DAYS / 7),
			readout: summary,
			defaultReadout: formatAccountHistorySummary(days),
			describe: day => formatUsageDay(day, undefined),
		}));
	}

	private _renderPoolHistory(section: HTMLElement, providerLabel: string, accounts: readonly ISubscriptionAccount[], now: number): void {
		const samplesByAccount = new Map(accounts.map(account => [account.id, this._history.get(account.id) ?? []] as const));
		const summary = summarizeUsageHistory(samplesByAccount, now, USAGE_HISTORY_DAYS);
		const verdict = getPoolVerdict(summary.days);
		const history = DOM.append(section, $('.subscription-usage-history.pool'));
		if (verdict) {
			const text = formatPoolVerdict(verdict);
			const headline = DOM.append(history, $(`.subscription-usage-verdict.${verdict.verdict}`));
			headline.tabIndex = 0;
			headline.setAttribute('aria-label', localize('subscriptionUsage.verdictAria', "{0}. {1} {2}", text.title, text.detail, text.rule));
			const icon = verdict.verdict === 'enough' ? Codicon.passFilled : verdict.verdict === 'tight' ? Codicon.warning : Codicon.error;
			DOM.append(headline, $(`span.subscription-usage-verdict-icon${ThemeIcon.asCSSSelector(icon)}`));
			DOM.append(headline, $('span.subscription-usage-verdict-title', undefined, text.title));
			DOM.append(headline, $('span.subscription-usage-verdict-detail', undefined, text.detail));
			this._renderDisposables.add(this._hoverService.setupDelayedHover(headline, { content: text.rule }));
			DOM.append(history, $('.subscription-usage-history-summary', undefined, formatPoolHistorySummary(summary, verdict)));
		}
		const labels = new Map(accounts.map(account => [account.id, account.label]));
		const readout = $('.subscription-usage-history-readout');
		readout.setAttribute('aria-live', 'polite');
		this._renderDisposables.add(renderUsageDayChart(history, summary.days, {
			pool: true,
			ariaLabel: localize('subscriptionUsage.poolHistory', "How full the {0} pool got per day over the past {1} weeks; use the arrow keys to read a day", providerLabel, USAGE_HISTORY_DAYS / 7),
			readout,
			defaultReadout: localize('subscriptionUsage.poolHistoryHint', "Point at a day, or focus the chart and use the arrow keys, to see its details."),
			describe: day => formatUsageDay(day, labels),
		}));
		renderUsageActivity(history, summary.activity);
	}

	private _renderStatus(parent: HTMLElement, account: ISubscriptionAccount, now: number): void {
		const status = getDisplayStatus(account);
		const badge = DOM.append(parent, $(`span.subscription-usage-status.${status}`));
		DOM.append(badge, $('span.subscription-usage-status-dot'));
		DOM.append(badge, $('span', undefined, getStatusLabel(status)));
		if (status === 'limited') {
			const resetsAt = account.limitedUntil ?? getEarliestReset([account], account.provider, now);
			if (resetsAt !== undefined) {
				this._renderDisposables.add(this._hoverService.setupDelayedHover(badge, { content: formatResetsIn(resetsAt, now) }));
			}
		}
	}

	private _renderWindow(parent: HTMLElement, window: ISubscriptionUsageWindow, limited: boolean, now: number): void {
		const remaining = limited ? 0 : Math.max(0, Math.round(100 - window.usedPercent));
		const element = DOM.append(parent, $('.subscription-usage-window'));
		const head = DOM.append(element, $('.subscription-usage-window-head'));
		DOM.append(head, $('span.subscription-usage-window-label', undefined, window.label));
		const text = window.resetsAt !== undefined
			? localize('subscriptionUsage.windowLeftResets', "{0}% left \u00b7 {1}", remaining, formatResetsIn(window.resetsAt, now))
			: localize('subscriptionUsage.windowLeft', "{0}% left", remaining);
		DOM.append(head, $('span.subscription-usage-window-value', undefined, text));
		this._renderMeter(element, remaining, window.label);
		if (window.resetsAt !== undefined) {
			this._renderDisposables.add(this._hoverService.setupDelayedHover(element, { content: localize('subscriptionUsage.windowHover', "{0}: {1}% used, resets {2}", window.label, Math.round(window.usedPercent), new Date(window.resetsAt).toLocaleString()) }));
		}
	}

	private _renderMeter(parent: HTMLElement, remainingPercent: number | undefined, label: string): void {
		const meter = DOM.append(parent, $('.subscription-usage-meter'));
		meter.setAttribute('role', 'meter');
		meter.setAttribute('aria-label', label);
		meter.setAttribute('aria-valuemin', '0');
		meter.setAttribute('aria-valuemax', '100');
		if (remainingPercent === undefined) {
			meter.classList.add('unknown');
			return;
		}
		meter.setAttribute('aria-valuenow', String(remainingPercent));
		const fill = DOM.append(meter, $('.subscription-usage-meter-fill'));
		fill.style.width = `${remainingPercent}%`;
		fill.classList.toggle('low', remainingPercent > 0 && remainingPercent < LOW_REMAINING_PERCENT);
		meter.classList.toggle('empty', remainingPercent === 0);
	}
}

type DisplayStatus = SubscriptionAccountStatus | 'usedUp';

function getDisplayStatus(account: ISubscriptionAccount): DisplayStatus {
	return account.status === 'signedIn' && getRemainingPercent(account) === 0 ? 'usedUp' : account.status;
}

function getStatusLabel(status: DisplayStatus): string {
	switch (status) {
		case 'signedIn': return localize('subscriptionUsage.status.available', "Available");
		case 'usedUp': return localize('subscriptionUsage.status.usedUp', "Used Up");
		case 'limited': return localize('subscriptionUsage.status.limited', "Limit Reached");
		case 'signingIn': return localize('subscriptionUsage.status.signingIn', "Signing In");
		case 'signedOut': return localize('subscriptionUsage.status.signedOut', "Signed Out");
		case 'error': return localize('subscriptionUsage.status.error', "Error");
	}
}
