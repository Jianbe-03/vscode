/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: Add CreaEditor Server (by address or pairing link, or installed over SSH), the Servers
// list with each server's status, Open in Browser, Pair Phone, signing in to Claude and Codex accounts
// on a server, and Remove.

import './media/creaeditorServers.css';
import * as DOM from '../../../../../base/browser/dom.js';
import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { createQrCodeSvg } from '../../../../../base/browser/qrCodeElement.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CREAEDITOR_SERVERS_ADD_REQUEST_KEY, getCreaEditorServerWebUrl, readCreaEditorServerChats, readCreaEditorServerMachine } from '../../../../../platform/agentHost/common/creaeditorServer.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { readSubscriptionAccountsState, subscriptionAccountTokenResource, type ISubscriptionAccount, type SubscriptionProvider } from '../../../../../platform/agentHost/common/meta/subscriptionAccounts.js';
import { IRemoteAgentHostService, RemoteAgentHostsEnabledSettingId } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputButton, IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { defaultDialogStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../../workbench/browser/parts/dialogs/dialog.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { IHostService } from '../../../../../workbench/services/host/browser/host.js';
import { dispatchSubscriptionAccountsRequest } from '../../../../../workbench/services/agentHost/browser/subscriptionAccountsService.js';
import { Menus } from '../../../../browser/menus.js';
import { SessionsCategories } from '../../../../common/categories.js';
import { SessionWorkspacePickerGroupContext } from '../../../../common/contextkeys.js';
import { SESSION_WORKSPACE_GROUP_REMOTE } from '../../../../services/sessions/common/session.js';
import { describeCreaEditorServer, ICreaEditorServer, ICreaEditorServerCheck, ICreaEditorServersService } from './creaeditorServers.js';
import { installCreaEditorServerOverSSH } from './creaeditorServerSshInstall.js';
import { pairAgainWithCreaEditorServer, pairAndAddCreaEditorServer } from './creaeditorServerPairFlow.js';

export const CreaEditorServerCommandIds = {
	add: 'creaeditor.servers.add',
	manage: 'creaeditor.servers.manage',
} as const;

/** How long a sign-in on a server may take before the flow stops following it. */
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

async function addByAddress(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const serversService = accessor.get(ICreaEditorServersService);
	const progressService = accessor.get(IProgressService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);

	// The answer of the last address check, so accepting needs no second request (text typed while
	// waiting for one would land in the chat input behind the closed quick input).
	let lastCheck: { readonly value: string; readonly check: ICreaEditorServerCheck | undefined } | undefined;
	const value = await quickInputService.input({
		title: localize('creaeditorServers.addTitle', "Add CreaEditor Server"),
		prompt: localize('creaeditorServers.addressPrompt', "Paste the pairing link from the server, or its address (https://... or http://ip:port)."),
		placeHolder: 'https://agents.example.com/#pair=ABCDE-12345',
		ignoreFocusLost: true,
		validateInput: async input => {
			if (!input.trim()) {
				return localize('creaeditorServers.addressEmpty', "Enter the server's address or pairing link.");
			}
			const check = await serversService.checkAddress(input);
			lastCheck = { value: input, check };
			return check === undefined ? localize('creaeditorServers.addressInvalid', "Enter an address like https://agents.example.com or http://100.64.0.2:31600.") : undefined;
		},
	});
	if (!value) {
		return;
	}
	const check = lastCheck?.value === value && lastCheck.check?.health ? lastCheck.check : await progressService.withProgress(
		{ location: ProgressLocation.Notification, title: localize('creaeditorServers.checking', "Looking for a CreaEditor Server...") },
		() => serversService.checkAddress(value),
	);
	if (!check) {
		return;
	}
	if (!check.health) {
		notificationService.error(localize('creaeditorServers.noServer', "No CreaEditor Server answers at {0}. Check the address, that the server runs, and that this computer can reach it (for example over Tailscale).", check.input.baseUrl));
		return;
	}
	await instantiationService.invokeFunction(pairAndAddCreaEditorServer, check.input, check.health.publicMode);
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CreaEditorServerCommandIds.add,
			title: localize2('creaeditorServers.add', "Add CreaEditor Server..."),
			shortTitle: localize2('creaeditorServers.addShort', "CreaEditor Server"),
			category: SessionsCategories.Sessions,
			f1: true,
			icon: Codicon.server,
			precondition: ContextKeyExpr.equals(`config.${RemoteAgentHostsEnabledSettingId}`, true),
			menu: {
				id: Menus.SessionWorkspaceManage,
				order: 5,
				when: SessionWorkspacePickerGroupContext.isEqualTo(SESSION_WORKSPACE_GROUP_REMOTE),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const instantiationService = accessor.get(IInstantiationService);
		type Choice = IQuickPickItem & { readonly choice: 'address' | 'ssh' };
		const picked = await quickInputService.pick<Choice>([
			{ choice: 'address', label: `$(link) ${localize('creaeditorServers.byAddress', "Connect by Address or Pairing Link")}`, detail: localize('creaeditorServers.byAddressDetail', "The server already runs (Docker, macOS service or Linux service).") },
			{ choice: 'ssh', label: `$(terminal) ${localize('creaeditorServers.bySsh', "Install on a Computer over SSH")}`, detail: localize('creaeditorServers.bySshDetail', "Installs the server as a service (or starts it with Docker), then pairs this computer.") },
		], { title: localize('creaeditorServers.addTitle', "Add CreaEditor Server"), placeHolder: localize('creaeditorServers.addPlaceholder', "How do you want to add the server?") });
		if (picked?.choice === 'address') {
			await instantiationService.invokeFunction(addByAddress);
		} else if (picked?.choice === 'ssh') {
			await instantiationService.invokeFunction(installCreaEditorServerOverSSH);
		}
	}
});

// ---- Servers list ----------------------------------------------------------

/** The agent host connection of a server while connected. */
function getServerConnection(remoteAgentHostService: IRemoteAgentHostService, serversService: ICreaEditorServersService, server: ICreaEditorServer): IAgentConnection | undefined {
	return remoteAgentHostService.getConnection(serversService.getAgentHostAddress(server));
}

/**
 * Shows a QR code a phone scans to pair with the server: the server's web page with a new one-time
 * pairing code from the server's API, or (an older or unreachable server) just the page.
 */
async function showPairPhoneDialog(accessor: ServicesAccessor, server: ICreaEditorServer): Promise<void> {
	const layoutService = accessor.get(ILayoutService);
	const keybindingService = accessor.get(IKeybindingService);
	const hostService = accessor.get(IHostService);
	const clipboardService = accessor.get(IClipboardService);
	const serversService = accessor.get(ICreaEditorServersService);
	const progressService = accessor.get(IProgressService);
	const pairing = await progressService.withProgress({ location: ProgressLocation.Notification, title: localize('creaeditorServers.creatingPairing', "Asking {0} for a pairing code...", server.name), delay: 500 }, () => serversService.createPairing(server.id));
	const url = pairing?.link ?? getCreaEditorServerWebUrl(server.serverUrl);
	const store = new DisposableStore();
	const dialog = store.add(new Dialog(
		layoutService.activeContainer,
		localize('creaeditorServers.pairPhoneTitle', "Pair a Phone with {0}", server.name),
		[localize('creaeditorServers.copyLink', "Copy Link"), localize('creaeditorServers.close', "Close")],
		createWorkbenchDialogOptions({
			type: 'none',
			extraClasses: ['creaeditor-server-pair-dialog'],
			cancelId: 1,
			dialogStyles: defaultDialogStyles,
			renderBody: container => {
				const body = DOM.append(container, DOM.$('.creaeditor-server-pair'));
				const qr = DOM.append(body, DOM.$('.creaeditor-server-qr', { role: 'img', 'aria-label': localize('creaeditorServers.qrAria', "QR code of {0}", url) }));
				qr.appendChild(createQrCodeSvg(url));
				if (pairing) {
					DOM.append(body, DOM.$('p', undefined, localize('creaeditorServers.pairPhoneScanCode', "Scan this with your phone's camera: it opens the server's Agents window and pairs with code {0}. The code works once, for 10 minutes.", pairing.code)));
					DOM.append(body, DOM.$('p', undefined, localize('creaeditorServers.pairPhonePassword', "Over the internet the page also asks for the server's password.")));
				} else {
					DOM.append(body, DOM.$('p', undefined, localize('creaeditorServers.pairPhoneScan', "Scan this with your phone's camera to open the server's Agents window.")));
					DOM.append(body, DOM.$('p', undefined, localize('creaeditorServers.pairPhoneCode', "The page asks for a pairing code: run `creaeditor-server pair` on the server for one. Over the internet it also asks for the server's password.")));
				}
				DOM.append(body, DOM.$('p.creaeditor-server-url', undefined, url));
			},
		}, keybindingService, layoutService, hostService),
	));
	try {
		const result = await dialog.show();
		if (result.button === 0) {
			await clipboardService.writeText(url);
		}
	} finally {
		store.dispose();
	}
}

/**
 * Signs a new Claude or Codex account in on the server, from this computer: the server's agent runs the
 * sign-in, this computer opens the page (and passes back the code Claude's page shows).
 */
async function signInAccountOnServer(accessor: ServicesAccessor, server: ICreaEditorServer, connection: IAgentConnection): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const notificationService = accessor.get(INotificationService);
	const openerService = accessor.get(IOpenerService);
	const clipboardService = accessor.get(IClipboardService);
	const title = localize('creaeditorServers.signInTitle', "Sign In on {0}", server.name);

	type ProviderPick = IQuickPickItem & { readonly provider: SubscriptionProvider; readonly kind: 'login' | 'token' };
	const picked = await quickInputService.pick<ProviderPick>([
		{ provider: 'claude', kind: 'login', label: localize('creaeditorServers.claudeLogin', "Claude: Sign In with a Browser"), detail: localize('creaeditorServers.claudeLoginDetail', "Sign in on the Claude page, then paste the code it shows.") },
		{ provider: 'claude', kind: 'token', label: localize('creaeditorServers.claudeToken', "Claude: Paste a Setup-Token"), detail: localize('creaeditorServers.claudeTokenDetail', "A token from `claude setup-token`; the server keeps it encrypted.") },
		{ provider: 'codex', kind: 'login', label: localize('creaeditorServers.codexLogin', "Codex: Sign In with a Device Code"), detail: localize('creaeditorServers.codexLoginDetail', "Open the ChatGPT page and enter the code shown here.") },
	], { title });
	if (!picked) {
		return;
	}
	const label = (await quickInputService.input({
		title,
		prompt: localize('creaeditorServers.accountLabel', "Name the account, for example Work or Personal."),
		ignoreFocusLost: true,
		validateInput: async value => value.trim() ? undefined : localize('creaeditorServers.accountLabelEmpty', "Enter a name."),
	}))?.trim();
	if (!label) {
		return;
	}
	const accountId = generateUuid();

	if (picked.kind === 'token') {
		const token = (await quickInputService.input({ title, prompt: localize('creaeditorServers.tokenPrompt', "Paste the token from `claude setup-token`."), password: true, ignoreFocusLost: true }))?.trim();
		if (!token) {
			return;
		}
		// The token first: the server keeps it for the account the request then adds.
		await connection.authenticate({ resource: subscriptionAccountTokenResource(accountId), token });
		dispatchSubscriptionAccountsRequest(connection, { type: 'add', provider: 'claude', kind: 'token', label, accountId });
		notificationService.info(localize('creaeditorServers.tokenAdded', "The Claude account {0} is added to {1}.", label, server.name));
		return;
	}

	dispatchSubscriptionAccountsRequest(connection, { type: 'add', provider: picked.provider, kind: 'login', label, accountId });
	const account = await followAccount(connection, accountId, candidate => !!candidate.authUrl || candidate.status === 'signedIn' || candidate.status === 'error', 60_000);
	if (!account?.authUrl) {
		if (account?.status !== 'signedIn') {
			notificationService.error(localize('creaeditorServers.signInNotStarted', "The sign-in on {0} did not start: {1}", server.name, account?.error ?? localize('creaeditorServers.noAnswer', "no answer")));
		}
		return;
	}
	const authUrl = account.authUrl;
	if (account.authCode) {
		const authCode = account.authCode;
		await clipboardService.writeText(authCode);
		notificationService.prompt(Severity.Info, localize('creaeditorServers.deviceCode', "To sign {0} in on {1}, open the sign-in page and enter the code {2} (copied).", label, server.name, authCode), [
			{ label: localize('creaeditorServers.openSignIn', "Open Sign-in Page"), run: () => openerService.open(URI.parse(authUrl), { openExternal: true }) },
			{ label: localize('creaeditorServers.copyCode', "Copy Code"), run: () => clipboardService.writeText(authCode) },
		], { sticky: true });
	} else {
		await openerService.open(URI.parse(authUrl), { openExternal: true });
		const withCode = account.acceptsAuthCode ? account : await followAccount(connection, accountId, candidate => !!candidate.acceptsAuthCode || candidate.status !== 'signingIn', 15_000);
		if (withCode?.acceptsAuthCode) {
			const code = (await quickInputService.input({
				title,
				prompt: localize('creaeditorServers.authCodePrompt', "Sign in on the page that opened, then paste the code it shows."),
				ignoreFocusLost: true,
			}))?.trim();
			if (!code) {
				return;
			}
			dispatchSubscriptionAccountsRequest(connection, { type: 'submitAuthCode', accountId, code });
		}
	}
	const done = await followAccount(connection, accountId, candidate => candidate.status !== 'signingIn', SIGN_IN_TIMEOUT_MS);
	if (done?.status === 'signedIn' || done?.status === 'limited') {
		notificationService.info(localize('creaeditorServers.signedIn', "{0} is signed in on {1}.", label, server.name));
	} else if (done) {
		notificationService.error(localize('creaeditorServers.signInFailed', "Signing {0} in on {1} failed: {2}", label, server.name, done.error ?? done.status));
	}
}

/** Resolves with the account once `predicate` holds for it, or undefined after `timeoutMs`. */
function followAccount(connection: IAgentConnection, accountId: string, predicate: (account: ISubscriptionAccount) => boolean, timeoutMs: number): Promise<ISubscriptionAccount | undefined> {
	const read = () => {
		const state = connection.rootState.value;
		return state && !(state instanceof Error) ? readSubscriptionAccountsState(state).accounts.find(account => account.id === accountId) : undefined;
	};
	return new Promise(resolve => {
		const store = new DisposableStore();
		const finish = (account: ISubscriptionAccount | undefined) => {
			store.dispose();
			resolve(account);
		};
		const check = () => {
			const account = read();
			if (account && predicate(account)) {
				finish(account);
			}
		};
		const timer = setTimeout(() => finish(read()), timeoutMs);
		store.add({ dispose: () => clearTimeout(timer) });
		store.add(connection.rootState.onDidChange(check));
		check();
	});
}

type ServerAction = 'pairAgain' | 'open' | 'phone' | 'signIn' | 'check' | 'remove';

async function showServerActions(accessor: ServicesAccessor, server: ICreaEditorServer): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const serversService = accessor.get(ICreaEditorServersService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const openerService = accessor.get(IOpenerService);
	const instantiationService = accessor.get(IInstantiationService);
	const connection = getServerConnection(remoteAgentHostService, serversService, server);
	const needsPairing = serversService.needsPairing.get().has(server.id);

	type ActionPick = IQuickPickItem & { readonly action: ServerAction };
	const items: ActionPick[] = [
		...(needsPairing ? [{ action: 'pairAgain' as const, label: `$(key) ${localize('creaeditorServers.pairAgain', "Pair Again...")}`, description: localize('creaeditorServers.pairAgainDetail', "The server no longer knows this computer") }] : []),
		{ action: 'open', label: `$(link-external) ${localize('creaeditorServers.openInBrowser', "Open in Browser")}`, description: server.serverUrl },
		{ action: 'phone', label: `$(device-mobile) ${localize('creaeditorServers.pairPhone', "Pair Phone")}` },
		...(connection ? [{ action: 'signIn' as const, label: `$(account) ${localize('creaeditorServers.signInAccount', "Sign In to an Account on This Server...")}`, description: localize('creaeditorServers.signInAccountDetail', "Claude or Codex") }] : []),
		{ action: 'check', label: `$(refresh) ${localize('creaeditorServers.checkNow', "Check Now")}` },
		{ action: 'remove', label: `$(trash) ${localize('creaeditorServers.remove', "Remove")}` },
	];
	const picked = await quickInputService.pick(items, { title: server.name });
	switch (picked?.action) {
		case 'pairAgain':
			await instantiationService.invokeFunction(pairAgainWithCreaEditorServer, server);
			break;
		case 'open':
			await openerService.open(URI.parse(getCreaEditorServerWebUrl(server.serverUrl)), { openExternal: true });
			break;
		case 'phone':
			await instantiationService.invokeFunction(showPairPhoneDialog, server);
			break;
		case 'signIn':
			if (connection) {
				await instantiationService.invokeFunction(signInAccountOnServer, server, connection);
			}
			break;
		case 'check':
			await serversService.refreshHealth();
			await instantiationService.invokeFunction(showServersList);
			break;
		case 'remove':
			await instantiationService.invokeFunction(confirmAndRemoveServer, server);
			break;
	}
}

interface IServerPick extends IQuickPickItem {
	readonly server?: ICreaEditorServer;
	readonly add?: true;
}

/** The Servers list: every paired server with its status, and Add CreaEditor Server. */
async function showServersList(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const serversService = accessor.get(ICreaEditorServersService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const openerService = accessor.get(IOpenerService);
	const instantiationService = accessor.get(IInstantiationService);
	const commandService = accessor.get(ICommandService);

	const openButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.linkExternal), tooltip: localize('creaeditorServers.openInBrowser', "Open in Browser") };
	const phoneButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.deviceMobile), tooltip: localize('creaeditorServers.pairPhone', "Pair Phone") };
	const removeButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.trash), tooltip: localize('creaeditorServers.remove', "Remove") };
	const pairAgainButton: IQuickInputButton = { iconClass: ThemeIcon.asClassName(Codicon.key), tooltip: localize('creaeditorServers.pairAgainButton', "Pair Again") };

	const store = new DisposableStore();
	const picker = store.add(quickInputService.createQuickPick<IServerPick>({ useSeparators: true }));
	picker.title = localize('creaeditorServers.listTitle', "CreaEditor Servers");
	picker.placeholder = localize('creaeditorServers.listPlaceholder', "Select a server to manage it");
	picker.matchOnDetail = true;

	const render = () => {
		const healthStates = serversService.healthStates.get();
		const needsPairing = serversService.needsPairing.get();
		const items: (IServerPick | IQuickPickSeparator)[] = serversService.servers.get().map(server => {
			const address = serversService.getAgentHostAddress(server);
			const connection = remoteAgentHostService.getConnection(address);
			const rootState = connection?.rootState.value;
			const root = rootState && !(rootState instanceof Error) ? rootState : undefined;
			const view = describeCreaEditorServer({
				health: healthStates.get(server.id),
				connection: remoteAgentHostService.connections.find(candidate => candidate.address === address)?.status,
				machine: readCreaEditorServerMachine(root?.config?.values),
				runningChats: root?.activeSessions,
				chats: readCreaEditorServerChats(root?.config?.values),
				needsPairing: needsPairing.has(server.id),
			}, Date.now());
			return {
				server,
				label: `$(${view.icon.id}) ${server.name}`,
				description: view.status,
				detail: [...view.details, server.serverUrl].join(' · '),
				buttons: needsPairing.has(server.id) ? [pairAgainButton, openButton, removeButton] : [openButton, phoneButton, removeButton],
			};
		});
		if (items.length) {
			items.push({ type: 'separator' });
		}
		items.push({ add: true, label: `$(add) ${localize('creaeditorServers.add', "Add CreaEditor Server...")}` });
		picker.items = items;
	};

	store.add(autorun(reader => {
		serversService.servers.read(reader);
		serversService.healthStates.read(reader);
		serversService.needsPairing.read(reader);
		render();
	}));
	store.add(remoteAgentHostService.onDidChangeConnections(() => render()));
	void serversService.refreshHealth();

	store.add(picker.onDidTriggerItemButton(async event => {
		const server = event.item.server;
		if (!server) {
			return;
		}
		if (event.button === openButton) {
			await openerService.open(URI.parse(getCreaEditorServerWebUrl(server.serverUrl)), { openExternal: true });
		} else if (event.button === phoneButton) {
			picker.hide();
			await instantiationService.invokeFunction(showPairPhoneDialog, server);
		} else if (event.button === pairAgainButton) {
			picker.hide();
			await instantiationService.invokeFunction(pairAgainWithCreaEditorServer, server);
		} else if (event.button === removeButton) {
			picker.hide();
			await instantiationService.invokeFunction(confirmAndRemoveServer, server);
		}
	}));
	store.add(picker.onDidAccept(() => {
		const selected = picker.selectedItems[0];
		picker.hide();
		if (selected?.server) {
			void instantiationService.invokeFunction(showServerActions, selected.server);
		} else if (selected?.add) {
			void commandService.executeCommand(CreaEditorServerCommandIds.add);
		}
	}));
	store.add(picker.onDidHide(() => store.dispose()));
	picker.show();
}

async function confirmAndRemoveServer(accessor: ServicesAccessor, server: ICreaEditorServer): Promise<void> {
	const dialogService = accessor.get(IDialogService);
	const serversService = accessor.get(ICreaEditorServersService);
	const { confirmed } = await dialogService.confirm({
		message: localize('creaeditorServers.removeConfirm', "Remove {0}?", server.name),
		detail: localize('creaeditorServers.removeDetail', "This computer signs out of the server. The server and its chats keep running; pair again to use it."),
		primaryButton: localize('creaeditorServers.removeButton', "Remove"),
	});
	if (confirmed) {
		await serversService.removeServer(server.id);
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CreaEditorServerCommandIds.manage,
			title: localize2('creaeditorServers.manage', "CreaEditor Servers"),
			shortTitle: localize2('creaeditorServers.manageShort', "CreaEditor Servers"),
			category: SessionsCategories.Sessions,
			f1: true,
			icon: Codicon.server,
			precondition: ContextKeyExpr.equals(`config.${RemoteAgentHostsEnabledSettingId}`, true),
			menu: {
				id: Menus.SessionWorkspaceManage,
				order: 6,
				when: SessionWorkspacePickerGroupContext.isEqualTo(SESSION_WORKSPACE_GROUP_REMOTE),
			},
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IInstantiationService).invokeFunction(showServersList);
	}
});

/** Tells once per server and window when a server no longer knows this computer, with Pair Again. */
class CreaEditorServersNeedsPairingContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.creaeditorServersNeedsPairing';

	private readonly _notified = new Set<string>();

	constructor(
		@ICreaEditorServersService serversService: ICreaEditorServersService,
		@INotificationService notificationService: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(autorun(reader => {
			const needsPairing = serversService.needsPairing.read(reader);
			for (const server of serversService.servers.read(reader)) {
				if (!needsPairing.has(server.id)) {
					this._notified.delete(server.id);
					continue;
				}
				if (this._notified.has(server.id)) {
					continue;
				}
				this._notified.add(server.id);
				notificationService.prompt(Severity.Warning, localize('creaeditorServers.needsPairingNotice', "{0} no longer knows this computer (it was signed out, or its data was reset). Pair again to use its chats.", server.name), [
					{ label: localize('creaeditorServers.pairAgainButton', "Pair Again"), run: () => instantiationService.invokeFunction(pairAgainWithCreaEditorServer, server) },
				]);
			}
		}));
	}
}

registerWorkbenchContribution2(CreaEditorServersNeedsPairingContribution.ID, CreaEditorServersNeedsPairingContribution, WorkbenchPhase.AfterRestored);

/** How long a request from the editor window to add a server stays valid. */
const ADD_REQUEST_LIFETIME_MS = 2 * 60 * 1000;

/** Runs Add CreaEditor Server when the editor window asked for it (see `OPEN_ADD_CREAEDITOR_SERVER_COMMAND_ID`). */
class CreaEditorServersAddRequestContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.creaeditorServersAddRequest';

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, CREAEDITOR_SERVERS_ADD_REQUEST_KEY, this._store)(() => this._handleRequest()));
		this._handleRequest();
	}

	private _handleRequest(): void {
		const requestedAt = this._storageService.getNumber(CREAEDITOR_SERVERS_ADD_REQUEST_KEY, StorageScope.APPLICATION);
		if (requestedAt === undefined) {
			return;
		}
		this._storageService.remove(CREAEDITOR_SERVERS_ADD_REQUEST_KEY, StorageScope.APPLICATION);
		if (Date.now() - requestedAt < ADD_REQUEST_LIFETIME_MS) {
			void this._commandService.executeCommand(CreaEditorServerCommandIds.add);
		}
	}
}

registerWorkbenchContribution2(CreaEditorServersAddRequestContribution.ID, CreaEditorServersAddRequestContribution, WorkbenchPhase.AfterRestored);
