/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: commands, setting, status bar entry and usage page of pooled Claude and Codex
// subscription accounts. Loaded in the editor window and in the Agents window.

import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { IWorkbenchContribution, WorkbenchPhase, registerWorkbenchContribution2 } from '../../../../common/contributions.js';
import { EditorExtensions } from '../../../../common/editor.js';
import { ISubscriptionAccountsService, SUBSCRIPTION_PROVIDERS, SubscriptionAccountsAutoSwitchSettingId, formatAccountLine, formatAvailability, formatPoolsStatusText, formatRemaining, getSubscriptionProviderLabel } from '../../../../services/agentHost/browser/subscriptionAccountsService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { CHAT_CATEGORY } from '../actions/chatActions.js';
import { SubscriptionAccountsFlows } from './subscriptionAccountsFlows.js';
import { ADD_CLAUDE_ACCOUNT_COMMAND_ID, ADD_CODEX_ACCOUNT_COMMAND_ID, MANAGE_SUBSCRIPTION_ACCOUNTS_COMMAND_ID, SHOW_SUBSCRIPTION_USAGE_COMMAND_ID, SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID } from './subscriptionAccountsLimit.js';
import { SubscriptionUsageEditor, SubscriptionUsageEditorInput } from './subscriptionUsageEditor.js';

/** Maximizes the editor area of the Agents window over the chat (see the sessions editor contribution). */
const MAXIMIZE_MAIN_EDITOR_PART_COMMAND_ID = 'workbench.action.agentSessions.maximizeMainEditorPart';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'chatSidebar',
	title: localize('chatConfigurationTitle', "Chat"),
	type: 'object',
	properties: {
		[SubscriptionAccountsAutoSwitchSettingId]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('chat.subscriptionAccounts.autoSwitch', "Like \"allow all\" for subscription limits: when a Claude or Codex account is used up, its chat continues on the next account of the pool without asking. When off, the chat shows the limit and asks before it switches. Manage the accounts with **Manage Subscription Accounts**."),
		},
	},
});

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(SubscriptionUsageEditor, SubscriptionUsageEditor.ID, localize('subscriptionUsage.editor', "Subscription Usage")),
	[new SyncDescriptor(SubscriptionUsageEditorInput)],
);

async function showSubscriptionUsage(editorService: IEditorService, commandService: ICommandService, environmentService: IWorkbenchEnvironmentService): Promise<void> {
	await editorService.openEditor(SubscriptionUsageEditorInput.getOrCreate(), { pinned: true });
	if (environmentService.isSessionsWindow) {
		// Like AI Costs: full screen over the chat in the Agents window.
		await commandService.executeCommand(MAXIMIZE_MAIN_EDITOR_PART_COMMAND_ID);
	}
}

registerAction2(class AddClaudeAccountAction extends Action2 {
	constructor() {
		super({
			id: ADD_CLAUDE_ACCOUNT_COMMAND_ID,
			title: localize2('addClaudeAccount', "Add Claude Account"),
			category: CHAT_CATEGORY,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IInstantiationService).createInstance(SubscriptionAccountsFlows).addAccount('claude');
	}
});

registerAction2(class AddCodexAccountAction extends Action2 {
	constructor() {
		super({
			id: ADD_CODEX_ACCOUNT_COMMAND_ID,
			title: localize2('addCodexAccount', "Add Codex Account"),
			category: CHAT_CATEGORY,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IInstantiationService).createInstance(SubscriptionAccountsFlows).addAccount('codex');
	}
});

registerAction2(class ManageSubscriptionAccountsAction extends Action2 {
	constructor() {
		super({
			id: MANAGE_SUBSCRIPTION_ACCOUNTS_COMMAND_ID,
			title: localize2('manageSubscriptionAccounts', "Manage Subscription Accounts"),
			category: CHAT_CATEGORY,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);
		const environmentService = accessor.get(IWorkbenchEnvironmentService);
		return accessor.get(IInstantiationService).createInstance(SubscriptionAccountsFlows).manage(() => showSubscriptionUsage(editorService, commandService, environmentService));
	}
});

registerAction2(class ShowSubscriptionUsageAction extends Action2 {
	constructor() {
		super({
			id: SHOW_SUBSCRIPTION_USAGE_COMMAND_ID,
			title: localize2('showSubscriptionUsage', "Show Subscription Usage"),
			category: CHAT_CATEGORY,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return showSubscriptionUsage(accessor.get(IEditorService), accessor.get(ICommandService), accessor.get(IWorkbenchEnvironmentService));
	}
});

/** Behind the Codex "Continue on ..." buttons of a limit error: the agent host starts the continuation turn. */
CommandsRegistry.registerCommand(SWITCH_SUBSCRIPTION_ACCOUNT_COMMAND_ID, async (accessor, chat: unknown, accountId: unknown, alwaysSwitch: unknown) => {
	if (typeof chat !== 'string' || !chat || typeof accountId !== 'string') {
		return;
	}
	const subscriptionAccountsService = accessor.get(ISubscriptionAccountsService);
	if (alwaysSwitch === true) {
		await subscriptionAccountsService.setAutoSwitch(true);
	}
	subscriptionAccountsService.switchChat(chat, accountId);
});

/**
 * The compact pool indicator in the status bar of the editor window, e.g. "Claude 62% · Codex 80%".
 * Its hover lists every account; a click opens the usage page.
 */
class SubscriptionUsageStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.subscriptionUsageStatusBar';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@ISubscriptionAccountsService subscriptionAccountsService: ISubscriptionAccountsService,
		@IStatusbarService statusbarService: IStatusbarService,
		@IWorkbenchEnvironmentService environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		if (environmentService.isSessionsWindow) {
			return;
		}
		this._register(autorun(reader => {
			const pools = subscriptionAccountsService.pools.read(reader);
			const accounts = subscriptionAccountsService.accounts.read(reader);
			if (!pools.length) {
				this._entry.clear();
				return;
			}
			const now = Date.now();
			const tooltip = new MarkdownString(undefined, { isTrusted: { enabledCommands: [SHOW_SUBSCRIPTION_USAGE_COMMAND_ID, MANAGE_SUBSCRIPTION_ACCOUNTS_COMMAND_ID] }, supportThemeIcons: true });
			for (const provider of SUBSCRIPTION_PROVIDERS) {
				const pool = pools.find(candidate => candidate.provider === provider);
				if (!pool) {
					continue;
				}
				tooltip.appendMarkdown(`**${getSubscriptionProviderLabel(provider)}** \u00b7 `);
				tooltip.appendText(`${formatRemaining(pool.remainingPercent)} \u00b7 ${formatAvailability(pool)}`);
				tooltip.appendMarkdown('\n\n');
				for (const account of accounts.filter(candidate => candidate.provider === provider)) {
					tooltip.appendMarkdown('- ');
					tooltip.appendText(formatAccountLine(account, now));
					tooltip.appendMarkdown('\n');
				}
				tooltip.appendMarkdown('\n');
			}
			tooltip.appendMarkdown(`[${localize('subscriptionStatus.showUsage', "Show Subscription Usage")}](command:${SHOW_SUBSCRIPTION_USAGE_COMMAND_ID}) \u00b7 [${localize('subscriptionStatus.manage', "Manage Accounts")}](command:${MANAGE_SUBSCRIPTION_ACCOUNTS_COMMAND_ID})`);
			const text = formatPoolsStatusText(pools);
			const props: IStatusbarEntry = {
				name: localize('subscriptionStatus.name', "Subscription Usage"),
				text: `$(pulse) ${text}`,
				ariaLabel: localize('subscriptionStatus.ariaLabel', "Subscription usage: {0}", text),
				tooltip,
				command: SHOW_SUBSCRIPTION_USAGE_COMMAND_ID,
			};
			if (this._entry.value) {
				this._entry.value.update(props);
			} else {
				this._entry.value = statusbarService.addEntry(props, 'chat.subscriptionUsage', StatusbarAlignment.RIGHT, 100.05);
			}
		}));
	}
}

registerWorkbenchContribution2(SubscriptionUsageStatusBarContribution.ID, SubscriptionUsageStatusBarContribution, WorkbenchPhase.AfterRestored);
