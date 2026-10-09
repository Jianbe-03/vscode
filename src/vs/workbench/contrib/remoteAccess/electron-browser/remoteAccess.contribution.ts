/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Remote Access commands of every window: "Remote Access" (the dialog) and
// "Allow Remote Access" (on/off).

import '../../../../platform/agentHost/electron-browser/remoteAccessService.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { RemoteAccessEnabledSettingId } from '../../../../platform/agentHost/common/remoteAccess.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { RemoteAccessDialog } from './remoteAccessDialog.js';

/** Opens the Remote Access dialog. */
export const SHOW_REMOTE_ACCESS_COMMAND_ID = 'creaeditor.remoteAccess.show';
/** Turns Remote Access on (and opens the dialog to pair a device) or off. */
export const TOGGLE_REMOTE_ACCESS_COMMAND_ID = 'creaeditor.remoteAccess.toggle';
/** True while Remote Access is allowed. */
export const RemoteAccessEnabledContext = ContextKeyExpr.equals(`config.${RemoteAccessEnabledSettingId}`, true);

registerAction2(class ShowRemoteAccessAction extends Action2 {
	constructor() {
		super({
			id: SHOW_REMOTE_ACCESS_COMMAND_ID,
			title: localize2('remoteAccess.show', "Remote Access"),
			icon: Codicon.deviceMobile,
			toggled: RemoteAccessEnabledContext,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IInstantiationService).createInstance(RemoteAccessDialog).show();
	}
});

registerAction2(class ToggleRemoteAccessAction extends Action2 {
	constructor() {
		super({
			id: TOGGLE_REMOTE_ACCESS_COMMAND_ID,
			title: localize2('remoteAccess.toggle', "Allow Remote Access"),
			toggled: RemoteAccessEnabledContext,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		const instantiationService = accessor.get(IInstantiationService);
		const notificationService = accessor.get(INotificationService);
		const enabled = configurationService.getValue<boolean>(RemoteAccessEnabledSettingId) === true;
		await configurationService.updateValue(RemoteAccessEnabledSettingId, !enabled);
		if (enabled) {
			notificationService.info(localize('remoteAccess.turnedOff', "Remote Access is off. Paired devices can no longer connect until you turn it on again."));
			return;
		}
		// Turned on: show the address and the QR code to pair a device.
		await instantiationService.createInstance(RemoteAccessDialog).show();
	}
});
