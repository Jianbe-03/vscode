/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: Set Up Notifications: picks an ntfy topic (a new unguessable one on ntfy.sh, or on the
// user's own ntfy server with an access token), keeps it in secret storage, shows it as a QR code to
// subscribe to in the ntfy app, and sends a test notification.

import './media/creaeditorNotifications.css';
import * as DOM from '../../../../base/browser/dom.js';
import { createQrCodeSvg } from '../../../../base/browser/qrCodeElement.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY, CREAEDITOR_SET_UP_NOTIFICATIONS_COMMAND_ID, CreaEditorNotificationsRootKey, createNtfyTopicUrl, ICreaEditorNotificationTarget, NTFY_DEFAULT_SERVER, parseNotificationTarget } from '../../../../platform/agentHost/common/creaeditorNotifications.js';
import { ICreaEditorServerHttpService } from '../../../../platform/agentHost/common/creaeditorServerHttp.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { defaultDialogStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../services/host/browser/host.js';

type SetupChoice = 'ntfy' | 'ownServer' | 'show' | 'test' | 'newTopic' | 'off';

interface ISetupPick extends IQuickPickItem {
	readonly choice: SetupChoice;
}

async function readTarget(secretStorageService: ISecretStorageService): Promise<ICreaEditorNotificationTarget | undefined> {
	const raw = await secretStorageService.get(CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY);
	try {
		return raw ? parseNotificationTarget(JSON.parse(raw)) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Sends one test notification from this computer (through the main process: renderer fetch is blocked
 * by CORS and the window CSP); resolves with an error message, or undefined when it went out.
 */
async function sendTestNotification(httpService: ICreaEditorServerHttpService, target: ICreaEditorNotificationTarget): Promise<string | undefined> {
	try {
		const status = await httpService.sendNtfyTestNotification(target,
			localize('creaeditorNotifications.testTitle', "CreaEditor"),
			localize('creaeditorNotifications.testMessage', "Notifications work. You get one when a chat finishes, fails or needs your approval."));
		if (status >= 200 && status < 300) {
			return undefined;
		}
		return status === 401 || status === 403
			? localize('creaeditorNotifications.testDenied', "The ntfy server refused the notification ({0}). Check the access token.", status)
			: localize('creaeditorNotifications.testStatus', "The ntfy server answered {0}.", status);
	} catch (error) {
		return localize('creaeditorNotifications.testFailed', "Could not reach the ntfy server: {0}", error instanceof Error ? error.message : String(error));
	}
}

/** Asks for the user's own ntfy server and its access token; undefined when cancelled. */
async function pickOwnServer(quickInputService: IQuickInputService): Promise<{ server: string; token?: string } | undefined> {
	const server = await quickInputService.input({
		title: localize('creaeditorNotifications.ownServerTitle', "Your ntfy Server"),
		prompt: localize('creaeditorNotifications.ownServerPrompt', "The address of your ntfy server. CreaEditor makes a new topic on it."),
		placeHolder: 'https://ntfy.example.com',
		validateInput: async value => /^https?:\/\/[^\s/]+(\/[^\s?#]*)?$/i.test(value.trim()) ? undefined : localize('creaeditorNotifications.ownServerInvalid', "Enter an address that starts with https:// (or http:// inside your own network)."),
	});
	if (!server) {
		return undefined;
	}
	const token = await quickInputService.input({
		title: localize('creaeditorNotifications.tokenTitle', "Access Token"),
		prompt: localize('creaeditorNotifications.tokenPrompt', "An ntfy access token that may publish to the topic (tk_...). Leave it empty when the server needs none."),
		password: true,
	});
	if (token === undefined) {
		return undefined;
	}
	return { server: server.trim(), ...(token.trim() ? { token: token.trim() } : {}) };
}

/** Shows the topic as a QR code, with Send Test Notification; loops until Done. */
async function showTopicDialog(accessor: ServicesAccessor, target: ICreaEditorNotificationTarget): Promise<void> {
	const layoutService = accessor.get(ILayoutService);
	const keybindingService = accessor.get(IKeybindingService);
	const hostService = accessor.get(IHostService);
	const clipboardService = accessor.get(IClipboardService);
	const httpService = accessor.get(ICreaEditorServerHttpService);
	const notificationService = accessor.get(INotificationService);
	const topic = new URL(target.url).pathname.split('/').pop() ?? '';

	for (let shown = 0; shown < 20; shown++) {
		const store = new DisposableStore();
		const dialog = store.add(new Dialog(
			layoutService.activeContainer,
			localize('creaeditorNotifications.dialogTitle', "Subscribe on Your Phone"),
			[
				localize('creaeditorNotifications.sendTest', "Send Test Notification"),
				localize('creaeditorNotifications.copyTopic', "Copy Topic Address"),
				localize('creaeditorNotifications.done', "Done"),
			],
			createWorkbenchDialogOptions({
				type: 'none',
				extraClasses: ['creaeditor-notifications-dialog'],
				cancelId: 2,
				dialogStyles: defaultDialogStyles,
				renderBody: container => {
					const body = DOM.append(container, DOM.$('.creaeditor-notifications'));
					const qr = DOM.append(body, DOM.$('.creaeditor-notifications-qr', { role: 'img', 'aria-label': localize('creaeditorNotifications.qrAria', "QR code of the notification topic {0}", target.url) }));
					qr.appendChild(createQrCodeSvg(target.url));
					DOM.append(body, DOM.$('p', undefined, localize('creaeditorNotifications.steps', "Install the free ntfy app on your phone, tap + (Subscribe to Topic), and scan this code or enter the topic below. Keep the topic private: anyone who knows it can read your notifications.")));
					DOM.append(body, DOM.$('p.creaeditor-notifications-topic', undefined, target.url));
					if (new URL(target.url).origin !== NTFY_DEFAULT_SERVER) {
						DOM.append(body, DOM.$('p', undefined, localize('creaeditorNotifications.ownServerHint', "In the app, use your server's address as the server and {0} as the topic.", topic)));
					}
				},
			}, keybindingService, layoutService, hostService),
		));
		let button: number;
		try {
			button = (await dialog.show()).button;
		} finally {
			store.dispose();
		}
		if (button === 0) {
			const error = await sendTestNotification(httpService, target);
			if (error) {
				notificationService.error(error);
			} else {
				notificationService.info(localize('creaeditorNotifications.testSent', "Test notification sent. It shows on your phone within a few seconds once you subscribed."));
			}
			continue;
		}
		if (button === 1) {
			await clipboardService.writeText(target.url);
		}
		return;
	}
}

registerAction2(class SetUpNotificationsAction extends Action2 {
	constructor() {
		super({
			id: CREAEDITOR_SET_UP_NOTIFICATIONS_COMMAND_ID,
			title: localize2('creaeditorNotifications.setUp', "Set Up Notifications"),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const secretStorageService = accessor.get(ISecretStorageService);
		const configurationService = accessor.get(IConfigurationService);
		const httpService = accessor.get(ICreaEditorServerHttpService);
		const notificationService = accessor.get(INotificationService);
		const instantiationService = accessor.get(IInstantiationService);
		const current = await readTarget(secretStorageService);
		const enabled = configurationService.getValue<boolean>(CreaEditorNotificationsRootKey.Enabled) === true;

		const picks: ISetupPick[] = current
			? [
				{ choice: 'show', label: localize('creaeditorNotifications.showQr', "Show the QR Code"), detail: current.url },
				{ choice: 'test', label: localize('creaeditorNotifications.sendTest', "Send Test Notification") },
				{ choice: 'newTopic', label: localize('creaeditorNotifications.newTopic', "Use a New Topic"), detail: localize('creaeditorNotifications.newTopicDetail', "Your phone needs to subscribe again.") },
				{ choice: 'ownServer', label: localize('creaeditorNotifications.useOwnServer', "Use My Own ntfy Server...") },
				{ choice: 'off', label: enabled ? localize('creaeditorNotifications.turnOff', "Turn Off Notifications") : localize('creaeditorNotifications.forget', "Forget the Topic") },
			]
			: [
				{ choice: 'ntfy', label: localize('creaeditorNotifications.useNtfy', "Use ntfy.sh (Recommended)"), detail: localize('creaeditorNotifications.useNtfyDetail', "Free, no account. CreaEditor makes a topic with a random name only you know.") },
				{ choice: 'ownServer', label: localize('creaeditorNotifications.useOwnServer', "Use My Own ntfy Server...") },
			];
		const picked = await quickInputService.pick(picks, {
			title: localize('creaeditorNotifications.pickTitle', "Notifications on Your Phone"),
			placeHolder: current
				? (enabled ? localize('creaeditorNotifications.onPlaceholder', "Notifications are on") : localize('creaeditorNotifications.offPlaceholder', "Notifications are off (a topic is set)"))
				: localize('creaeditorNotifications.setUpPlaceholder', "Where should notifications go?"),
		});
		if (!picked) {
			return;
		}

		let target: ICreaEditorNotificationTarget | undefined;
		switch (picked.choice) {
			case 'show':
				await configurationService.updateValue(CreaEditorNotificationsRootKey.Enabled, true);
				await instantiationService.invokeFunction(showTopicDialog, current!);
				return;
			case 'test': {
				const error = await sendTestNotification(httpService, current!);
				if (error) {
					notificationService.error(error);
				} else {
					notificationService.info(localize('creaeditorNotifications.testSent', "Test notification sent. It shows on your phone within a few seconds once you subscribed."));
				}
				return;
			}
			case 'off':
				await secretStorageService.delete(CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY);
				await configurationService.updateValue(CreaEditorNotificationsRootKey.Enabled, false);
				notificationService.info(localize('creaeditorNotifications.turnedOff', "Notifications are off. Your CreaEditor Servers forget the topic the next time this computer connects to them."));
				return;
			case 'ntfy':
				target = { url: createNtfyTopicUrl(NTFY_DEFAULT_SERVER) };
				break;
			case 'newTopic':
				target = { url: createNtfyTopicUrl(new URL(current!.url).origin + new URL(current!.url).pathname.replace(/\/[^/]*$/, '')), ...(current!.token ? { token: current!.token } : {}) };
				break;
			case 'ownServer': {
				const own = await pickOwnServer(quickInputService);
				if (!own) {
					return;
				}
				target = { url: createNtfyTopicUrl(own.server), ...(own.token ? { token: own.token } : {}) };
				break;
			}
		}
		await secretStorageService.set(CREAEDITOR_NOTIFICATIONS_TARGET_SECRET_KEY, JSON.stringify(target));
		await configurationService.updateValue(CreaEditorNotificationsRootKey.Enabled, true);
		await instantiationService.invokeFunction(showTopicDialog, target);
	}
});
