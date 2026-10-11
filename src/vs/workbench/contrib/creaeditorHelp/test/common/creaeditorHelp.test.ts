/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveCreaEditorHelpPage } from '../../common/creaeditorHelp.js';

suite('CreaEditor Help', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves known pages and falls back to the index', () => {
		const inputs: unknown[] = ['delegate-to-server', 'index', undefined, '', 'unknown-page', '../secret', 'Remote-Access', 'notifications.md', 42];
		assert.deepStrictEqual(inputs.map(resolveCreaEditorHelpPage), ['delegate-to-server', 'index', 'index', 'index', 'index', 'index', 'index', 'index', 'index']);
	});
});
