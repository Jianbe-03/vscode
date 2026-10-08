/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the texts of AI budgets, shared by the alerts, the AI Costs page and the hard stop.

import * as l10n from '@vscode/l10n';
import { CostBudgetPeriod, ICostBudget, ICostBudgetStatus } from './gatewayCostsAnalysis';
import { formatUsd } from './gatewayKeyStatus';

/** The setting with the AI budgets, see {@link parseCostBudgets}. */
export const BUDGETS_SETTING = 'creaeditor.aiCosts.budgets';

/** "daily", "weekly" or "monthly". */
export function formatBudgetPeriod(period: CostBudgetPeriod): string {
	switch (period) {
		case 'day': return l10n.t('daily');
		case 'week': return l10n.t('weekly');
		case 'month': return l10n.t('monthly');
	}
}

/** What a budget is for, e.g. "the Personal key", "issue acme/web#42" or "repository acme/web". */
export function formatBudgetScope(budget: Pick<ICostBudget, 'scope' | 'value'>): string {
	switch (budget.scope) {
		case 'key': return l10n.t('the {0} key', budget.value);
		case 'issue': return l10n.t('issue {0}', budget.value);
		case 'repo': return l10n.t('repository {0}', budget.value);
	}
}

/** Like {@link formatBudgetScope}, at the start of a sentence. */
function formatBudgetScopeStart(budget: Pick<ICostBudget, 'scope' | 'value'>): string {
	switch (budget.scope) {
		case 'key': return l10n.t('The {0} key', budget.value);
		case 'issue': return l10n.t('Issue {0}', budget.value);
		case 'repo': return l10n.t('Repository {0}', budget.value);
	}
}

/** The alert of a reached threshold, e.g. "The Personal key has used 80% of its $50 monthly budget." */
export function formatBudgetAlert(status: ICostBudgetStatus, threshold: number): string {
	const { budget } = status;
	if (threshold < 100) {
		return l10n.t('{0} has used {1}% of its {2} {3} budget.', formatBudgetScopeStart(budget), threshold, formatUsd(budget.amount), formatBudgetPeriod(budget.period));
	}
	return budget.hardStop
		? l10n.t('{0} has used its {1} {2} budget ({3} spent). Its requests are refused until the budget resets or is raised.', formatBudgetScopeStart(budget), formatUsd(budget.amount), formatBudgetPeriod(budget.period), formatUsd(status.spent))
		: l10n.t('{0} has used its {1} {2} budget ({3} spent).', formatBudgetScopeStart(budget), formatUsd(budget.amount), formatBudgetPeriod(budget.period), formatUsd(status.spent));
}

/** The chat error of a request refused by a hard stop. */
export function formatBudgetRefusal(status: ICostBudgetStatus): string {
	const { budget } = status;
	return l10n.t('The {0} budget of {1} for {2} is used up. Raise it on the AI Costs page.', formatBudgetPeriod(budget.period), formatUsd(budget.amount), formatBudgetScope(budget));
}
