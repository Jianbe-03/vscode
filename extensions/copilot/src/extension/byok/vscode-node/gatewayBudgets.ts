/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import { commands, ConfigurationTarget, QuickPickItem, window, workspace } from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { formatIssue } from '../../../platform/endpoint/common/gatewayTracking';
import { IGatewayTrackingService } from '../../../platform/endpoint/common/gatewayTrackingService';
import { RunOnceScheduler } from '../../../util/vs/base/common/async';
import { Emitter, Event } from '../../../util/vs/base/common/event';
import { Disposable, DisposableStore } from '../../../util/vs/base/common/lifecycle';
import { generateUuid } from '../../../util/vs/base/common/uuid';
import { BUDGETS_SETTING, formatBudgetAlert, formatBudgetScope } from '../common/gatewayBudgetMessages';
import { formatUsd } from '../common/gatewayKeyStatus';
import { computeBudgetStatuses, CostBudgetPeriod, CostBudgetScope, DEFAULT_BUDGET_WARN_AT, getBudgetAlertKeys, getNewBudgetAlerts, ICostBudget, ICostBudgetStatus, parseCostBudgets } from '../common/gatewayCostsAnalysis';
import { GatewayKeyStatusMonitor } from './gatewayKeyStatusMonitor';

/** Command "CreaEditor: Add AI Budget". */
export const ADD_BUDGET_COMMAND_ID = 'creaeditor.aiCosts.addBudget';
const SHOW_AI_COSTS_COMMAND_ID = 'creaeditor.showAiCosts';
/** Global state with the keys of the budget alerts that were shown. */
const RAISED_ALERTS_KEY = 'creaeditor.aiCosts.raisedBudgetAlerts';
const MAX_RAISED_ALERTS = 500;
/** Requests are recorded and then updated with their cost in quick succession. */
const ALERT_CHECK_DELAY = 2_000;

interface IValueItem extends QuickPickItem {
	readonly value: string;
}

/**
 * CreaEditor: the AI budgets of the `creaeditor.aiCosts.budgets` setting. A setting rather than global
 * state, so budgets sync with Settings Sync and can be edited as JSON; it is application scoped, so a
 * workspace cannot change them. Shows an alert once per threshold per period, and adds and edits budgets.
 * The hard stop itself is in the BYOK endpoint, see `OpenAIEndpoint.makeChatRequest2`.
 */
export class GatewayBudgets extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	/** Fires when the budgets or their spend changed. */
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _alertCheck = this._register(new RunOnceScheduler(() => this._checkAlerts(), ALERT_CHECK_DELAY));

	constructor(
		private readonly _keyStatus: GatewayKeyStatusMonitor,
		@IGatewayTrackingService private readonly _trackingService: IGatewayTrackingService,
		@IVSCodeExtensionContext private readonly _extensionContext: IVSCodeExtensionContext,
	) {
		super();
		this._register(commands.registerCommand(ADD_BUDGET_COMMAND_ID, () => this.editBudget(undefined)));
		this._register(workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(BUDGETS_SETTING)) {
				this._onDidChange.fire();
				this._alertCheck.schedule();
			}
		}));
		this._register(this._trackingService.onDidChangeEntries(() => {
			if (this.getBudgets().length) {
				this._alertCheck.schedule();
			}
		}));
		this._alertCheck.schedule();
	}

	getBudgets(): ICostBudget[] {
		return parseCostBudgets(workspace.getConfiguration().get<unknown>(BUDGETS_SETTING));
	}

	/** The spend of every budget in its current period. */
	getStatuses(): ICostBudgetStatus[] {
		return computeBudgetStatuses(this.getBudgets(), this._trackingService.entries, Date.now());
	}

	async removeBudget(id: string): Promise<void> {
		const budget = this.getBudgets().find(budget => budget.id === id);
		if (!budget) {
			return;
		}
		const remove = l10n.t('Remove');
		const answer = await window.showWarningMessage(l10n.t('Remove the budget of {0} for {1}?', formatUsd(budget.amount), formatBudgetScope(budget)), { modal: true }, remove);
		if (answer === remove) {
			await this._save(this.getBudgets().filter(other => other.id !== id));
		}
	}

	/** Asks for a new budget, or changes the budget with the id. */
	async editBudget(id: string | undefined): Promise<void> {
		const budgets = this.getBudgets();
		const existing = id ? budgets.find(budget => budget.id === id) : undefined;
		const scope = await this._pickScope(existing?.scope);
		if (!scope) {
			return;
		}
		const value = await this._pickValue(scope, existing?.scope === scope ? existing.value : undefined);
		if (!value) {
			return;
		}
		const amountText = await window.showInputBox({
			title: l10n.t('Budget in US Dollars'),
			prompt: l10n.t('The amount per period, e.g. 50.'),
			value: existing ? String(existing.amount) : undefined,
			ignoreFocusOut: true,
			validateInput: text => parseAmount(text) === undefined ? l10n.t('Enter an amount above 0.') : undefined,
		});
		const amount = parseAmount(amountText);
		if (amount === undefined) {
			return;
		}
		const period = await this._pickPeriod(existing?.period ?? 'month');
		if (!period) {
			return;
		}
		const hardStop = await this._pickHardStop(existing?.hardStop ?? false);
		if (hardStop === undefined) {
			return;
		}
		const budget: ICostBudget = { id: existing?.id ?? generateUuid(), scope, value, amount, period, warnAt: existing?.warnAt ?? [...DEFAULT_BUDGET_WARN_AT], hardStop };
		await this._save(existing ? budgets.map(other => other.id === existing.id ? budget : other) : [...budgets, budget]);
	}

	private async _save(budgets: readonly ICostBudget[]): Promise<void> {
		await workspace.getConfiguration().update(BUDGETS_SETTING, budgets.map(budget => ({ ...budget })), ConfigurationTarget.Global);
	}

	private async _pickScope(current: CostBudgetScope | undefined): Promise<CostBudgetScope | undefined> {
		const items: (QuickPickItem & { readonly scope: CostBudgetScope })[] = [
			{ scope: 'key', label: l10n.t('Key'), description: l10n.t('An OpenRouter or LiteLLM key') },
			{ scope: 'issue', label: l10n.t('Issue'), description: l10n.t('The chats that work on an issue') },
			{ scope: 'repo', label: l10n.t('Repository'), description: l10n.t('The requests made in a repository') },
		];
		const picked = await window.showQuickPick(items.map(item => ({ ...item, picked: item.scope === current })), { title: l10n.t('What Is the Budget For?'), ignoreFocusOut: true });
		return picked?.scope;
	}

	/** Offers the keys, issues or repositories of the ledger, most used first; any other value can be typed. */
	private async _pickValue(scope: CostBudgetScope, current: string | undefined): Promise<string | undefined> {
		const counts = new Map<string, number>();
		const add = (value: string | undefined) => {
			if (value) {
				counts.set(value, (counts.get(value) ?? 0) + 1);
			}
		};
		for (const entry of this._trackingService.entries) {
			add(scope === 'key' ? entry.providerGroup : scope === 'issue' ? formatIssue(entry.issue, entry.repo) : entry.repo);
		}
		if (scope === 'key') {
			for (const status of this._keyStatus.getStatuses()) {
				add(status.group);
			}
		}
		const known: IValueItem[] = [...counts].sort((a, b) => b[1] - a[1]).map(([value]) => ({ value, label: value }));
		const disposables = new DisposableStore();
		try {
			return await new Promise<string | undefined>(resolve => {
				const quickPick = disposables.add(window.createQuickPick<IValueItem>());
				quickPick.title = scope === 'key' ? l10n.t('Which Key?') : scope === 'issue' ? l10n.t('Which Issue?') : l10n.t('Which Repository?');
				quickPick.placeholder = scope === 'key' ? l10n.t('Pick a key or type its name') : scope === 'issue' ? l10n.t('Pick an issue or type it, e.g. acme/web#42 or PROJ-7') : l10n.t('Pick a repository or type it, e.g. acme/web');
				quickPick.ignoreFocusOut = true;
				quickPick.value = current ?? '';
				const update = () => {
					const typed = quickPick.value.trim();
					quickPick.items = typed && !known.some(item => item.value === typed)
						? [{ value: typed, label: typed, description: l10n.t('Use this value') }, ...known]
						: known;
				};
				update();
				disposables.add(quickPick.onDidChangeValue(update));
				disposables.add(quickPick.onDidAccept(() => {
					resolve(quickPick.selectedItems[0]?.value ?? (quickPick.value.trim() || undefined));
					quickPick.hide();
				}));
				disposables.add(quickPick.onDidHide(() => resolve(undefined)));
				quickPick.show();
			});
		} finally {
			disposables.dispose();
		}
	}

	private async _pickPeriod(current: CostBudgetPeriod): Promise<CostBudgetPeriod | undefined> {
		const items: (QuickPickItem & { readonly period: CostBudgetPeriod })[] = [
			{ period: 'day', label: l10n.t('Per Day') },
			{ period: 'week', label: l10n.t('Per Week'), description: l10n.t('From Monday') },
			{ period: 'month', label: l10n.t('Per Month') },
		];
		const picked = await window.showQuickPick(items.map(item => ({ ...item, picked: item.period === current })), { title: l10n.t('How Often Does the Budget Start Over?'), ignoreFocusOut: true });
		return picked?.period;
	}

	private async _pickHardStop(current: boolean): Promise<boolean | undefined> {
		const items: (QuickPickItem & { readonly hardStop: boolean })[] = [
			{ hardStop: false, label: l10n.t('Warn Only'), description: l10n.t('Notify at 80% and 100%') },
			{ hardStop: true, label: l10n.t('Warn and Stop'), description: l10n.t('Also refuse requests once the budget is used up') },
		];
		const picked = await window.showQuickPick(items.map(item => ({ ...item, picked: item.hardStop === current })), { title: l10n.t('When the Budget Is Used Up'), ignoreFocusOut: true });
		return picked?.hardStop;
	}

	private _checkAlerts(): void {
		const statuses = this.getStatuses();
		this._onDidChange.fire();
		if (!statuses.length) {
			return;
		}
		const raised = new Set(this._extensionContext.globalState.get<string[]>(RAISED_ALERTS_KEY) ?? []);
		const alerts = getNewBudgetAlerts(statuses, raised);
		if (!alerts.length) {
			return;
		}
		for (const alert of alerts) {
			for (const key of getBudgetAlertKeys(alert.status)) {
				raised.add(key);
			}
			void this._showAlert(alert.status, alert.threshold);
		}
		void this._extensionContext.globalState.update(RAISED_ALERTS_KEY, [...raised].slice(-MAX_RAISED_ALERTS));
	}

	private async _showAlert(status: ICostBudgetStatus, threshold: number): Promise<void> {
		const open = l10n.t('Open AI Costs');
		const edit = l10n.t('Edit Budget');
		const message = formatBudgetAlert(status, threshold);
		const answer = threshold >= 100
			? await window.showWarningMessage(message, open, edit)
			: await window.showInformationMessage(message, open, edit);
		if (answer === open) {
			await commands.executeCommand(SHOW_AI_COSTS_COMMAND_ID);
		} else if (answer === edit) {
			await this.editBudget(status.budget.id);
		}
	}
}

function parseAmount(text: string | undefined): number | undefined {
	const amount = text ? Number(text.trim().replace(/^\$/, '').replace(',', '.')) : NaN;
	return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}
