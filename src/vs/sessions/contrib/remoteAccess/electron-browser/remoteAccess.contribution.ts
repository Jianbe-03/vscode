/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: a Remote Access button in the Agents window title bar; it shows as on while Remote
// Access is allowed and opens the Remote Access dialog.

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IsAuxiliaryWindowContext, IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { RemoteAccessEnabledContext, SHOW_REMOTE_ACCESS_COMMAND_ID } from '../../../../workbench/contrib/remoteAccess/electron-browser/remoteAccess.contribution.js';
import { Menus } from '../../../browser/menus.js';

MenuRegistry.appendMenuItem(Menus.TitleBarRightLayout, {
	command: {
		id: SHOW_REMOTE_ACCESS_COMMAND_ID,
		title: localize('remoteAccess.titleBar', "Remote Access"),
		icon: Codicon.deviceMobile,
		toggled: RemoteAccessEnabledContext,
	},
	group: 'navigation',
	order: 89,
	when: ContextKeyExpr.and(IsSessionsWindowContext, IsAuxiliaryWindowContext.toNegated()),
});
