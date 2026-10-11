/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: opens the CreaEditor Guide, the help pages of the built-in `creaeditor-features`
// extension, in the Markdown preview (see `../common/creaeditorHelp.ts`).

import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { CREAEDITOR_HELP_EXTENSION_ID, CREAEDITOR_HELP_FOLDER, CREAEDITOR_HELP_INDEX_PAGE, OPEN_CREAEDITOR_HELP_COMMAND_ID, resolveCreaEditorHelpPage } from '../common/creaeditorHelp.js';

/** Opens a page of the CreaEditor Guide; an unknown or missing page name opens the index. */
registerAction2(class OpenCreaEditorHelpAction extends Action2 {
	constructor() {
		super({
			id: OPEN_CREAEDITOR_HELP_COMMAND_ID,
			title: localize2('creaeditorHelp.open', "Open CreaEditor Guide Page"),
			category: Categories.Help,
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, page?: unknown): Promise<void> {
		const extensionService = accessor.get(IExtensionService);
		const commandService = accessor.get(ICommandService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);

		const extension = await extensionService.getExtension(CREAEDITOR_HELP_EXTENSION_ID);
		if (!extension) {
			notificationService.warn(localize('creaeditorHelp.missing', "The CreaEditor Guide is not part of this build."));
			return;
		}
		const resource = joinPath(extension.extensionLocation, CREAEDITOR_HELP_FOLDER, `${resolveCreaEditorHelpPage(page)}.md`);
		try {
			await commandService.executeCommand('markdown.showPreview', resource);
		} catch (error) {
			// Without the built-in Markdown extension, show the page as text.
			logService.warn('[CreaEditor Guide] Markdown preview unavailable, opening the page as text', error);
			await editorService.openEditor({ resource, options: { pinned: true } });
		}
	}
});

/** Help > CreaEditor Guide: the index of the help pages. */
registerAction2(class ShowCreaEditorGuideAction extends Action2 {
	constructor() {
		super({
			id: 'creaeditor.help.showGuide',
			title: localize2('creaeditorHelp.showGuide', "CreaEditor Guide"),
			category: Categories.Help,
			f1: true,
			menu: {
				id: MenuId.MenubarHelpMenu,
				group: '1_welcome',
				order: 2,
			},
		});
	}

	run(accessor: ServicesAccessor): Promise<unknown> {
		return accessor.get(ICommandService).executeCommand(OPEN_CREAEDITOR_HELP_COMMAND_ID, CREAEDITOR_HELP_INDEX_PAGE);
	}
});
