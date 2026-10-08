/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: warns before a Claude or Codex subscription account hits its limit. When an account's
// tightest window passes the usage warning threshold (80% by default) and again at 95%, a notification
// says so once per window and reset period, in one window: the editor window, or the Agents window
// when it is the only one that sees it first. Chats running on the account get a note from the agent
// host (see `takeUsageNote` there), which also reads the usage more often near the limit.

import { disposableTimeout } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import Severity from '../../../../../base/common/severity.js';
import { localize } from '../../../../../nls.js';
import { ISubscriptionAccount, ISubscriptionUsageWarning, formatUsageWarning, getUsageWarning } from '../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ISubscriptionAccountsService, SubscriptionAccountsUsageWarningThresholdSettingId } from '../../../../services/agentHost/browser/subscriptionAccountsService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { SHOW_SUBSCRIPTION_USAGE_COMMAND_ID } from './subscriptionAccountsLimit.js';

/** Application storage: the warnings already shown, shared by all windows. */
const SHOWN_WARNINGS_STORAGE_KEY = 'chat.subscriptionAccounts.shownUsageWarnings';
/** A warning without a known reset is forgotten after this long. */
const SHOWN_WARNING_FALLBACK_MS = 8 * 24 * 60 * 60 * 1000;
/** The Agents window waits this long, so a warning the editor window shows is not shown twice. */
const SESSIONS_WINDOW_DELAY_MS = 1500;

/** A warning already shown, until the period it belongs to is over. */
export interface IShownUsageWarning {
	readonly key: string;
	readonly until: number;
}

/** The accounts whose current warning was not shown yet, with that warning. */
export function getNewUsageWarnings(accounts: readonly ISubscriptionAccount[], threshold: number, shown: readonly IShownUsageWarning[]): { readonly account: ISubscriptionAccount; readonly warning: ISubscriptionUsageWarning }[] {
	const shownKeys = new Set(shown.map(entry => entry.key));
	const result: { account: ISubscriptionAccount; warning: ISubscriptionUsageWarning }[] = [];
	for (const account of accounts) {
		const warning = getUsageWarning(account, threshold);
		if (warning && !shownKeys.has(warning.key)) {
			result.push({ account, warning });
		}
	}
	return result;
}

/** The shown warnings whose period is not over yet. */
export function pruneShownUsageWarnings(shown: readonly IShownUsageWarning[], now: number): IShownUsageWarning[] {
	return shown.filter(entry => entry.until > now);
}

export class SubscriptionUsageWarningsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.subscriptionUsageWarnings';

	constructor(
		@ISubscriptionAccountsService private readonly _subscriptionAccountsService: ISubscriptionAccountsService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		this._register(autorun(reader => {
			const accounts = this._subscriptionAccountsService.accounts.read(reader);
			const threshold = this._subscriptionAccountsService.warningThreshold.read(reader);
			if (!getNewUsageWarnings(accounts, threshold, this._readShown()).length) {
				return;
			}
			if (this._environmentService.isSessionsWindow) {
				reader.store.add(disposableTimeout(() => this._warn(), SESSIONS_WINDOW_DELAY_MS));
			} else {
				this._warn();
			}
		}));
	}

	private _warn(): void {
		const now = Date.now();
		const shown = pruneShownUsageWarnings(this._readShown(), now);
		const warnings = getNewUsageWarnings(this._subscriptionAccountsService.accounts.get(), this._subscriptionAccountsService.warningThreshold.get(), shown);
		if (!warnings.length) {
			return;
		}
		for (const { warning } of warnings) {
			shown.push({ key: warning.key, until: warning.window.resetsAt ?? now + SHOWN_WARNING_FALLBACK_MS });
		}
		this._storageService.store(SHOWN_WARNINGS_STORAGE_KEY, JSON.stringify(shown), StorageScope.APPLICATION, StorageTarget.MACHINE);
		for (const { account, warning } of warnings) {
			this._notificationService.prompt(warning.level === 2 ? Severity.Warning : Severity.Info, formatUsageWarning(account, warning, now), [
				{
					label: localize('subscriptionUsageWarning.showUsage', "Show Usage"),
					run: () => this._commandService.executeCommand(SHOW_SUBSCRIPTION_USAGE_COMMAND_ID),
				},
				{
					label: localize('subscriptionUsageWarning.dontWarnAgain', "Don't Warn Again"),
					isSecondary: true,
					run: () => this._configurationService.updateValue(SubscriptionAccountsUsageWarningThresholdSettingId, 0),
				},
			]);
		}
	}

	private _readShown(): IShownUsageWarning[] {
		try {
			const value: unknown = JSON.parse(this._storageService.get(SHOWN_WARNINGS_STORAGE_KEY, StorageScope.APPLICATION, '[]'));
			return Array.isArray(value)
				? value.filter((entry): entry is IShownUsageWarning => !!entry && typeof entry.key === 'string' && typeof entry.until === 'number')
				: [];
		} catch {
			return [];
		}
	}
}
