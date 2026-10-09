/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Remote Access dialog: on/off, the address, a QR code to pair a device, the
// paired devices with Sign Out, the password and public access.

import './media/remoteAccess.css';
import * as DOM from '../../../../base/browser/dom.js';
import { createQrCodeSvg } from '../../../../base/browser/qrCodeElement.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IRemoteAccessPairing, IRemoteAccessService, IRemoteAccessStatus, RemoteAccessEnabledSettingId, RemoteAccessNetwork, RemoteAccessNetworkSettingId, RemoteAccessState, TAILSCALE_DOWNLOAD_URL } from '../../../../platform/agentHost/common/remoteAccess.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultButtonStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../services/host/browser/host.js';

const $ = DOM.$;

/** Shows the Remote Access dialog until the user closes it. */
export class RemoteAccessDialog {

	private _status: IRemoteAccessStatus | undefined;
	private _pairing: IRemoteAccessPairing | undefined;
	private _message: string | undefined;
	private _busy = false;

	constructor(
		@IRemoteAccessService private readonly _remoteAccessService: IRemoteAccessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
		@ILayoutService private readonly _layoutService: ILayoutService,
		@IHostService private readonly _hostService: IHostService,
	) { }

	async show(): Promise<void> {
		const disposables = new DisposableStore();
		const renderStore = disposables.add(new DisposableStore());
		let root: HTMLElement | undefined;
		let passwordInput: InputBox | undefined;

		const render = () => {
			if (!root) {
				return;
			}
			renderStore.clear();
			DOM.clearNode(root);
			const status = this._status;
			if (!status) {
				return;
			}
			this._renderStatus(root, status, renderStore, render);
			if (status.state === RemoteAccessState.On) {
				this._renderPairing(root, status, renderStore, render);
				this._renderDevices(root, status, renderStore, render);
				passwordInput ??= disposables.add(new InputBox($('div'), this._contextViewService, {
					type: 'password',
					placeholder: localize('remoteAccess.passwordPlaceholder', "New password (at least 8 characters)"),
					ariaLabel: localize('remoteAccess.passwordAria', "Remote Access password"),
					inputBoxStyles: defaultInputBoxStyles,
				}));
				this._renderPublicAccess(root, status, passwordInput, renderStore, render);
			}
			if (this._message) {
				this._renderMessage(root, this._message, renderStore);
			}
		};

		const update = (status: IRemoteAccessStatus) => {
			const wasOn = this._status?.state === RemoteAccessState.On;
			const urlChanged = this._status?.url !== status.url || this._status?.publicUrl !== status.publicUrl;
			this._status = status;
			if (status.state === RemoteAccessState.On && (!wasOn || urlChanged || !this._pairing)) {
				void this._newPairing(render);
			} else if (status.state !== RemoteAccessState.On) {
				this._pairing = undefined;
			}
			render();
		};

		disposables.add(this._remoteAccessService.onDidChangeStatus(update));
		update(await this._remoteAccessService.getStatus());

		const dialog = disposables.add(new Dialog(
			this._layoutService.activeContainer,
			localize('remoteAccess.dialogTitle', "Remote Access"),
			[localize('remoteAccess.close', "Close")],
			createWorkbenchDialogOptions({
				type: 'none',
				extraClasses: ['remote-access-dialog'],
				cancelId: 0,
				dialogStyles: defaultDialogStyles,
				renderBody: container => {
					root = DOM.append(container, $('.remote-access'));
					render();
				},
			}, this._keybindingService, this._layoutService, this._hostService),
		));
		// Refresh "Last seen" and the code's expiry while the dialog is open.
		const timer = DOM.getWindow(this._layoutService.activeContainer).setInterval(() => render(), 30_000);
		try {
			await dialog.show();
		} finally {
			DOM.getWindow(this._layoutService.activeContainer).clearInterval(timer);
			disposables.dispose();
		}
	}

	// ---- Sections -----------------------------------------------------------

	private _renderStatus(root: HTMLElement, status: IRemoteAccessStatus, store: DisposableStore, render: () => void): void {
		const section = DOM.append(root, $('.remote-access-section.remote-access-status'));
		const headline = DOM.append(section, $('.remote-access-headline'));
		const on = status.state === RemoteAccessState.On;
		DOM.append(headline, $(`span${ThemeIcon.asCSSSelector(on ? Codicon.radioTower : status.state === RemoteAccessState.Error ? Codicon.warning : Codicon.circleSlash)}`));
		DOM.append(headline, $('span', undefined, this._headline(status)));

		const details: string[] = [];
		if (on && status.network === RemoteAccessNetwork.Localhost) {
			details.push(localize('remoteAccess.localhostDetail', "Only this Mac can connect (127.0.0.1), for trying it out."));
		}
		if (on && status.magicDnsUrl) {
			details.push(localize('remoteAccess.magicDns', "Also at {0} when MagicDNS is on.", status.magicDnsUrl));
		}
		if (on && status.connections > 0) {
			details.push(status.connections === 1
				? localize('remoteAccess.oneConnection', "1 device connection is open.")
				: localize('remoteAccess.connections', "{0} device connections are open.", status.connections));
		}
		if (status.keepingAwake) {
			details.push(localize('remoteAccess.keepingAwake', "Keeping this Mac awake while chats run."));
		}
		if (status.state === RemoteAccessState.Error && status.error) {
			details.push(status.error);
		}
		if (status.state === RemoteAccessState.Off) {
			details.push(localize('remoteAccess.offDetail', "Use the Agents window of this Mac from your phone or another computer over Tailscale: see your chats live, send messages, approve tools and stop chats."));
		}
		for (const detail of details) {
			DOM.append(section, $('p.remote-access-detail', undefined, detail));
		}

		const actions = DOM.append(section, $('.remote-access-actions'));
		if (status.state === RemoteAccessState.Off) {
			this._button(actions, localize('remoteAccess.allow', "Allow Remote Access"), false, store, () => this._configurationService.updateValue(RemoteAccessEnabledSettingId, true), render);
		} else {
			this._button(actions, localize('remoteAccess.turnOff', "Turn Off Remote Access"), true, store, () => this._configurationService.updateValue(RemoteAccessEnabledSettingId, false), render);
		}
		if (status.state === RemoteAccessState.Error && status.network === RemoteAccessNetwork.Tailscale) {
			if (!status.tailscale.installed) {
				this._button(actions, localize('remoteAccess.downloadTailscale', "Download Tailscale"), true, store, () => this._openerService.open(URI.parse(TAILSCALE_DOWNLOAD_URL)), render);
			} else {
				this._button(actions, localize('remoteAccess.tryAgain', "Try Again"), true, store, () => this._remoteAccessService.refresh(), render);
			}
		}
		if (status.state !== RemoteAccessState.Off) {
			if (status.network === RemoteAccessNetwork.Tailscale) {
				this._button(actions, localize('remoteAccess.useLocalhost', "Use Localhost Only"), true, store, () => this._configurationService.updateValue(RemoteAccessNetworkSettingId, RemoteAccessNetwork.Localhost), render);
			} else {
				this._button(actions, localize('remoteAccess.useTailscale', "Use Tailscale"), true, store, () => this._configurationService.updateValue(RemoteAccessNetworkSettingId, RemoteAccessNetwork.Tailscale), render);
			}
		}
	}

	private _renderPairing(root: HTMLElement, status: IRemoteAccessStatus, store: DisposableStore, render: () => void): void {
		const section = DOM.append(root, $('.remote-access-section'));
		DOM.append(section, $('h3.remote-access-heading', undefined, localize('remoteAccess.pairHeading', "Pair a Device")));
		if (!status.webUi) {
			DOM.append(section, $('p.remote-access-detail.remote-access-warning', undefined, localize('remoteAccess.noWebUi', "This build does not include the web Agents window, so paired devices only see a pairing page. Build the app with scripts/creaeditor-build-macos.sh.")));
		}
		const pairing = this._pairing;
		if (!pairing) {
			DOM.append(section, $('p.remote-access-detail', undefined, localize('remoteAccess.creatingCode', "Creating a pairing code…")));
			return;
		}

		const row = DOM.append(section, $('.remote-access-pairing'));
		row.appendChild(this._renderQrCode(pairing.url));
		const info = DOM.append(row, $('.remote-access-pairing-info'));
		DOM.append(info, $('p.remote-access-detail', undefined, status.publicAccess
			? localize('remoteAccess.scanPublic', "Scan this code with the device's camera. It opens the public address and asks for the password.")
			: localize('remoteAccess.scan', "Scan this code with the device's camera. The device must be signed in to the same Tailscale network.")));
		DOM.append(info, $('.remote-access-code', undefined, pairing.code));
		const expired = pairing.expiresAt <= Date.now();
		DOM.append(info, $('p.remote-access-detail', undefined, expired
			? localize('remoteAccess.codeExpired', "This code expired.")
			: localize('remoteAccess.codeExpires', "Single use, expires {0}.", fromNow(pairing.expiresAt, false, true))));
		DOM.append(info, $('p.remote-access-detail.remote-access-url', undefined, pairing.url.replace(/#.*$/, '')));
		const actions = DOM.append(info, $('.remote-access-actions'));
		this._button(actions, localize('remoteAccess.newCode', "New Code"), true, store, () => this._newPairing(render), render);
		this._button(actions, localize('remoteAccess.copyLink', "Copy Link"), true, store, () => this._clipboardService.writeText(pairing.url), render);
	}

	private _renderDevices(root: HTMLElement, status: IRemoteAccessStatus, store: DisposableStore, render: () => void): void {
		const section = DOM.append(root, $('.remote-access-section'));
		DOM.append(section, $('h3.remote-access-heading', undefined, localize('remoteAccess.devicesHeading', "Devices")));
		if (status.devices.length === 0) {
			DOM.append(section, $('p.remote-access-detail', undefined, localize('remoteAccess.noDevices', "No devices are paired yet.")));
			return;
		}
		const list = DOM.append(section, $('ul.remote-access-devices'));
		for (const device of status.devices) {
			const item = DOM.append(list, $('li.remote-access-device'));
			const text = DOM.append(item, $('.remote-access-device-text'));
			DOM.append(text, $('.remote-access-device-name', undefined, device.name));
			const lastSeen = localize('remoteAccess.lastSeen', "Last seen {0}", fromNow(device.lastSeenAt, true, true));
			DOM.append(text, $('.remote-access-detail', undefined, device.pairedPublicly ? localize('remoteAccess.pairedPublicly', "{0} · paired over public access", lastSeen) : lastSeen));
			this._button(item, localize('remoteAccess.signOut', "Sign Out"), true, store, () => this._remoteAccessService.signOutDevice(device.id), render);
		}
	}

	private _renderPublicAccess(root: HTMLElement, status: IRemoteAccessStatus, passwordInput: InputBox, store: DisposableStore, render: () => void): void {
		const section = DOM.append(root, $('.remote-access-section'));
		DOM.append(section, $('h3.remote-access-heading', undefined, localize('remoteAccess.publicHeading', "Public Access")));
		if (status.publicAccess) {
			DOM.append(section, $('p.remote-access-detail', undefined, status.publicUrl
				? localize('remoteAccess.publicOn', "Reachable from the internet at {0}.", status.publicUrl)
				: localize('remoteAccess.publicWaiting', "Public access is on, but Tailscale does not report a Funnel address. Turn it off and on again.")));
		} else {
			DOM.append(section, $('p.remote-access-detail.remote-access-warning', undefined, localize('remoteAccess.publicWarning', "Public access makes the pairing page reachable from the whole internet over HTTPS (Tailscale Funnel). Devices then need a pairing code and the password. Only turn it on when you need it.")));
		}

		const passwordRow = DOM.append(section, $('.remote-access-password'));
		DOM.append(passwordRow, $('p.remote-access-detail', undefined, status.hasPassword
			? localize('remoteAccess.passwordSet', "A password is set.")
			: localize('remoteAccess.passwordNotSet', "No password is set. Set one before turning on public access.")));
		passwordRow.appendChild(passwordInput.element);
		const passwordActions = DOM.append(passwordRow, $('.remote-access-actions'));
		this._button(passwordActions, status.hasPassword ? localize('remoteAccess.changePassword', "Change Password") : localize('remoteAccess.setPassword', "Set Password"), true, store, async () => {
			await this._remoteAccessService.setPassword(passwordInput.value);
			passwordInput.value = '';
		}, render);
		if (status.hasPassword && !status.publicAccess) {
			this._button(passwordActions, localize('remoteAccess.removePassword', "Remove Password"), true, store, () => this._remoteAccessService.setPassword(undefined), render);
		}

		const actions = DOM.append(section, $('.remote-access-actions'));
		if (status.publicAccess) {
			this._button(actions, localize('remoteAccess.publicOff', "Turn Off Public Access"), false, store, () => this._remoteAccessService.setPublicAccess(false), render);
		} else {
			const button = this._button(actions, localize('remoteAccess.publicOnButton', "Turn On Public Access"), true, store, () => this._remoteAccessService.setPublicAccess(true), render);
			button.enabled = !this._busy && status.hasPassword && status.network === RemoteAccessNetwork.Tailscale;
		}
	}

	private _renderMessage(root: HTMLElement, message: string, store: DisposableStore): void {
		const element = DOM.append(root, $('p.remote-access-detail.remote-access-error', { role: 'alert' }));
		// Messages from Tailscale may carry a link to act on.
		const link = /https:\/\/\S+/.exec(message)?.[0];
		if (!link) {
			element.textContent = message;
			return;
		}
		const index = message.indexOf(link);
		element.append(message.slice(0, index));
		const anchor = DOM.append(element, $('a', { href: '#' }, link));
		store.add(DOM.addDisposableListener(anchor, DOM.EventType.CLICK, e => {
			DOM.EventHelper.stop(e, true);
			void this._openerService.open(URI.parse(link));
		}));
		element.append(message.slice(index + link.length));
	}

	// ---- Helpers ------------------------------------------------------------

	private _headline(status: IRemoteAccessStatus): string {
		switch (status.state) {
			case RemoteAccessState.Off:
				return localize('remoteAccess.headlineOff', "Remote Access is off");
			case RemoteAccessState.Starting:
				return localize('remoteAccess.headlineStarting', "Starting Remote Access…");
			case RemoteAccessState.Error:
				return status.tailscale.installed || status.network === RemoteAccessNetwork.Localhost
					? localize('remoteAccess.headlineError', "Remote Access is not running")
					: localize('remoteAccess.headlineInstallTailscale', "Install and sign in to Tailscale");
			case RemoteAccessState.On:
				if (status.publicAccess && status.publicUrl) {
					return localize('remoteAccess.headlinePublic', "On publicly at {0}", status.publicUrl);
				}
				if (status.network === RemoteAccessNetwork.Localhost) {
					return localize('remoteAccess.headlineLocalhost', "On for this Mac only at {0}", status.url ?? '');
				}
				return localize('remoteAccess.headlineTailscale', "On via Tailscale at {0}", status.url ?? '');
		}
	}

	private _renderQrCode(text: string): HTMLElement {
		const container = $('.remote-access-qr', { role: 'img', 'aria-label': localize('remoteAccess.qrAria', "QR code of the pairing link") });
		container.appendChild(createQrCodeSvg(text));
		return container;
	}

	private _button(container: HTMLElement, label: string, secondary: boolean, store: DisposableStore, run: () => unknown, render: () => void): Button {
		const button = store.add(new Button(container, { ...defaultButtonStyles, secondary }));
		button.label = label;
		button.enabled = !this._busy;
		store.add(button.onDidClick(async () => {
			this._busy = true;
			this._message = undefined;
			render();
			try {
				await run();
			} catch (error) {
				this._message = error instanceof Error ? error.message.replace(/^Error: /, '') : String(error);
			} finally {
				this._busy = false;
				render();
			}
		}));
		return button;
	}

	private async _newPairing(render: () => void): Promise<void> {
		try {
			this._pairing = await this._remoteAccessService.createPairing();
		} catch (error) {
			this._pairing = undefined;
			this._message = error instanceof Error ? error.message : String(error);
		}
		render();
	}
}
