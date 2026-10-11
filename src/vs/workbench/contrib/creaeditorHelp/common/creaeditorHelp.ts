/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the CreaEditor Guide, Markdown help pages bundled in the built-in
// `creaeditor-features` extension (`extensions/creaeditor-features/help/<page>.md`).

/** The built-in extension that holds the help pages. */
export const CREAEDITOR_HELP_EXTENSION_ID = 'vscode.creaeditor-features';

/** The folder of the help pages inside the extension. */
export const CREAEDITOR_HELP_FOLDER = 'help';

/** The page shown when no page or an unknown page is asked for. */
export const CREAEDITOR_HELP_INDEX_PAGE = 'index';

/** Opens a help page; its optional argument is the page name, such as `'delegate-to-server'`. */
export const OPEN_CREAEDITOR_HELP_COMMAND_ID = 'creaeditor.help.open';

/** Every help page, by file name without `.md`. */
export const CREAEDITOR_HELP_PAGES: readonly string[] = [
	CREAEDITOR_HELP_INDEX_PAGE,
	'models-and-keys',
	'costs-and-budgets',
	'subscription-accounts',
	'agents-window',
	'remote-access',
	'creaeditor-server',
	'delegate-to-server',
	'notifications',
];

/**
 * Returns the help page to open for `page`: the page itself when it is a known page name (lower
 * case letters, digits and dashes only), otherwise the index.
 */
export function resolveCreaEditorHelpPage(page: unknown): string {
	if (typeof page !== 'string' || !/^[a-z0-9-]+$/.test(page) || !CREAEDITOR_HELP_PAGES.includes(page)) {
		return CREAEDITOR_HELP_INDEX_PAGE;
	}
	return page;
}
