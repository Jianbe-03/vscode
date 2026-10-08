/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the interactive steps around subscription accounts (adding, renaming, removing,
// signing in), shared by the commands, the usage page and the chat's limit prompt.

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { waitForState } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { ISubscriptionAccount, SubscriptionProvider } from '../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { INotificationService, IPromptChoice, Severity } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ISubscriptionAccountsService, SUBSCRIPTION_PROVIDERS, formatAccountState, getCliLoginCommand, getSubscriptionProviderLabel, openClaudeAuthUrl } from '../../../../services/agentHost/browser/subscriptionAccountsService.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';

/** How long a new or signing-in account is followed for a sign-in page or an outcome. */
const SIGN_IN_START_TIMEOUT = 60_000;
/** How long a browser sign-in may take before the account is no longer followed. */
const SIGN_IN_FINISH_TIMEOUT = 5 * 60_000;

interface IAccountActionItem extends IQuickPickItem {
	readonly run: () => Promise<unknown> | void;
}

export class SubscriptionAccountsFlows {

	constructor(
		@ISubscriptionAccountsService private readonly _subscriptionAccountsService: ISubscriptionAccountsService,
		@IQuickInputService private readonly _quickInputService: IQuickInputService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) { }

	async addAccount(provider: SubscriptionProvider): Promise<void> {
		const providerLabel = getSubscriptionProviderLabel(provider);
		const count = this._subscriptionAccountsService.accounts.get().filter(account => account.provider === provider).length;
		const label = await this._quickInputService.input({
			title: provider === 'claude' ? localize('addClaudeAccount.title', "Add Claude Account") : localize('addCodexAccount.title', "Add Codex Account"),
			prompt: localize('addAccount.namePrompt', "A name for this {0} account, such as Work or Personal", providerLabel),
			value: localize('addAccount.defaultName', "{0} {1}", providerLabel, count + 1),
			validateInput: async value => value.trim() ? undefined : localize('addAccount.nameRequired', "Enter a name."),
		});
		if (!label?.trim()) {
			return;
		}
		if (provider === 'codex') {
			await this._addLoginAccount(provider, label.trim());
			return;
		}

		const tokenItem: IQuickPickItem = {
			id: 'token',
			label: localize('addClaudeAccount.token', "Paste a Setup-Token"),
			detail: localize('addClaudeAccount.tokenDetail', "Run `claude setup-token` in a terminal, sign in with this account, then paste the token it prints."),
		};
		const loginItem: IQuickPickItem = {
			id: 'login',
			label: localize('addClaudeAccount.login', "Sign In with the Browser"),
			detail: localize('addClaudeAccount.loginDetail', "Sign in on claude.ai in your browser."),
		};
		const kind = await this._quickInputService.pick([tokenItem, loginItem], {
			title: localize('addClaudeAccount.kindTitle', "How Should {0} Sign In?", label.trim()),
		});
		if (!kind) {
			return;
		}
		if (kind.id === 'login') {
			await this._addLoginAccount(provider, label.trim());
			return;
		}
		const token = await this._quickInputService.input({
			title: localize('addClaudeAccount.tokenTitle', "Paste the Setup-Token of {0}", label.trim()),
			prompt: localize('addClaudeAccount.tokenPrompt', "Run `claude setup-token` in a terminal and paste the token it prints. It is kept in your keychain."),
			password: true,
			ignoreFocusLost: true,
			validateInput: async value => value.trim() ? undefined : localize('addClaudeAccount.tokenRequired', "Paste the setup-token."),
		});
		if (!token?.trim()) {
			return;
		}
		const accountId = await this._subscriptionAccountsService.add(provider, 'token', label.trim(), token.trim());
		const account = await this._followAccount(accountId, candidate => candidate.status === 'signedIn' || !!candidate.error, SIGN_IN_START_TIMEOUT);
		if (account && account.status !== 'signedIn') {
			this._notificationService.error(localize('addClaudeAccount.tokenError', "The setup-token of {0} did not work: {1}", account.label, account.error ?? ''));
		}
	}

	async signIn(account: ISubscriptionAccount): Promise<void> {
		this._subscriptionAccountsService.signIn(account.id);
		// Wait until the agent host started over, so an error of an earlier attempt is not taken for this one.
		await this._followAccount(account.id, candidate => candidate.status === 'signingIn' || candidate.status === 'signedIn', 15_000);
		await this._followSignIn(account.id);
	}

	async rename(account: ISubscriptionAccount): Promise<void> {
		const label = await this._quickInputService.input({
			title: localize('renameAccount.title', "Rename {0}", account.label),
			value: account.label,
			validateInput: async value => value.trim() ? undefined : localize('addAccount.nameRequired', "Enter a name."),
		});
		if (label?.trim() && label.trim() !== account.label) {
			this._subscriptionAccountsService.rename(account.id, label.trim());
		}
	}

	async remove(account: ISubscriptionAccount): Promise<void> {
		const { confirmed } = await this._dialogService.confirm({
			message: localize('removeAccount.message', "Remove the {0} account {1}?", getSubscriptionProviderLabel(account.provider), account.label),
			detail: localize('removeAccount.detail', "Chats on this account continue on the next account of the pool."),
			primaryButton: localize({ key: 'removeAccount.button', comment: ['&& denotes a mnemonic'] }, "&&Remove"),
		});
		if (confirmed) {
			await this._subscriptionAccountsService.remove(account.id);
		}
	}

	/** Moves an account one place up (-1) or down (1) among the accounts of its provider. */
	move(account: ISubscriptionAccount, direction: -1 | 1): void {
		const accounts = this._subscriptionAccountsService.accounts.get();
		const own = accounts.filter(candidate => candidate.provider === account.provider);
		// The index counts the accounts of the provider, the default account included.
		const index = own.findIndex(candidate => candidate.id === account.id) + direction;
		if (index >= 0 && index < own.length) {
			this._subscriptionAccountsService.move(account.id, index);
		}
	}

	async manage(showUsage: () => Promise<void>): Promise<void> {
		const accounts = this._subscriptionAccountsService.accounts.get();
		const now = Date.now();
		const items: (IAccountActionItem | IQuickPickSeparator)[] = [];
		for (const provider of SUBSCRIPTION_PROVIDERS) {
			const own = accounts.filter(account => account.provider === provider);
			items.push({ type: 'separator', label: getSubscriptionProviderLabel(provider) });
			for (const account of own) {
				items.push({
					label: account.label,
					description: formatAccountState(account, now),
					detail: [account.email, account.planType].filter(Boolean).join(' \u00b7 ') || undefined,
					run: () => this._manageAccount(account),
				});
			}
			items.push({
				label: provider === 'claude' ? `$(add) ${localize('manage.addClaude', "Add Claude Account")}` : `$(add) ${localize('manage.addCodex', "Add Codex Account")}`,
				run: () => this.addAccount(provider),
			});
		}
		items.push({ type: 'separator' });
		items.push({ label: `$(pulse) ${localize('manage.showUsage', "Show Subscription Usage")}`, run: showUsage });
		const picked = await this._quickInputService.pick(items, {
			title: localize('manage.title', "Manage Subscription Accounts"),
			placeHolder: localize('manage.placeholder', "Pick an account to change it, or add one"),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		await picked?.run();
	}

	private async _manageAccount(account: ISubscriptionAccount): Promise<void> {
		const own = this._subscriptionAccountsService.accounts.get().filter(candidate => candidate.provider === account.provider);
		const index = own.findIndex(candidate => candidate.id === account.id);
		const items: IAccountActionItem[] = [];
		if (account.status !== 'signedIn' && account.status !== 'limited' && account.kind !== 'default') {
			items.push({ label: `$(sign-in) ${localize('manageAccount.signIn', "Sign In")}`, run: () => this.signIn(account) });
		}
		items.push({ label: `$(refresh) ${localize('manageAccount.refresh', "Refresh Usage")}`, run: () => this._subscriptionAccountsService.refreshUsage(account.provider) });
		if (account.kind !== 'default') {
			items.push({ label: `$(edit) ${localize('manageAccount.rename', "Rename")}`, run: () => this.rename(account) });
		}
		if (index > 0) {
			items.push({ label: `$(arrow-up) ${localize('manageAccount.moveUp', "Move Up")}`, description: localize('manageAccount.moveUpDetail', "Try this account earlier"), run: () => this.move(account, -1) });
		}
		if (index < own.length - 1) {
			items.push({ label: `$(arrow-down) ${localize('manageAccount.moveDown', "Move Down")}`, description: localize('manageAccount.moveDownDetail', "Try this account later"), run: () => this.move(account, 1) });
		}
		if (account.kind !== 'default') {
			items.push({ label: `$(trash) ${localize('manageAccount.remove', "Remove")}`, run: () => this.remove(account) });
		}
		const picked = await this._quickInputService.pick(items, { title: account.label });
		await picked?.run();
	}

	private async _addLoginAccount(provider: SubscriptionProvider, label: string): Promise<void> {
		const accountId = await this._subscriptionAccountsService.add(provider, 'login', label);
		await this._followSignIn(accountId);
	}

	/**
	 * Follows a browser sign-in. Codex sign-in pages are opened by the service; the Claude CLI opens its
	 * page itself, so it is only offered again. An error that asks to run a CLI login in a terminal gets
	 * a button for that.
	 */
	private async _followSignIn(accountId: string): Promise<void> {
		let account = await this._followAccount(accountId, candidate => candidate.status === 'signedIn' || !!candidate.authUrl || (candidate.status !== 'signingIn' && !!candidate.error), SIGN_IN_START_TIMEOUT);
		if (account?.status === 'signingIn') {
			const authUrl = account.authUrl;
			if (account.provider === 'claude' && authUrl) {
				this._notificationService.prompt(Severity.Info, localize('signIn.finishInBrowser', "Finish signing in to {0} in your browser.", account.label), [{
					label: localize('signIn.openPage', "Open Sign-in Page"),
					run: () => openClaudeAuthUrl(this._openerService, authUrl),
				}]);
			}
			account = await this._followAccount(accountId, candidate => candidate.status !== 'signingIn', SIGN_IN_FINISH_TIMEOUT);
		}
		if (!account || account.status === 'signedIn' || !account.error) {
			return;
		}
		const failed = account;
		const command = getCliLoginCommand(failed.error);
		if (!command) {
			this._notificationService.error(localize('signIn.error', "Signing in to {0} failed: {1}", failed.label, failed.error ?? ''));
			return;
		}
		const offerRefresh = () => this._notificationService.prompt(Severity.Info, localize('signIn.refreshAfterTerminal', "When the sign-in in the terminal is done, refresh {0}.", failed.label), [{
			label: localize('signIn.refresh', "Refresh Account"),
			run: () => this._subscriptionAccountsService.refreshUsage(failed.provider),
		}], { sticky: true });
		const choices: IPromptChoice[] = [];
		if (!this._environmentService.isSessionsWindow) {
			choices.push({ label: localize('signIn.openTerminal', "Open Terminal"), run: async () => { await this._runInTerminal(command, failed.label); offerRefresh(); } });
		}
		choices.push({ label: localize('signIn.copyCommand', "Copy Command"), run: async () => { await this._clipboardService.writeText(command); offerRefresh(); } });
		this._notificationService.prompt(Severity.Info, localize('signIn.runCommand', "To sign in to {0}, run `{1}` in a terminal.", failed.label, command), choices, { sticky: true });
	}

	private async _runInTerminal(command: string, label: string): Promise<void> {
		const terminal = await this._terminalService.createTerminal({ config: { name: localize('signIn.terminalName', "Sign In: {0}", label) } });
		this._terminalService.setActiveInstance(terminal);
		await this._terminalService.revealActiveTerminal();
		await terminal.sendText(command, true);
	}

	private async _followAccount(accountId: string, predicate: (account: ISubscriptionAccount) => boolean, timeout: number): Promise<ISubscriptionAccount | undefined> {
		const source = new CancellationTokenSource();
		const timer = setTimeout(() => source.cancel(), timeout);
		try {
			const accounts = await waitForState(this._subscriptionAccountsService.accounts, candidates => candidates.some(candidate => candidate.id === accountId && predicate(candidate)), undefined, source.token);
			return accounts.find(candidate => candidate.id === accountId);
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
			source.dispose();
		}
	}
}

