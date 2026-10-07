/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { isDirectorAgentUri } from '../../browser/directorAgent.js';

suite('isDirectorAgentUri', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches agent files whose name ends in director.agent.md', () => {
		const uris = [
			'file:///Applications/CreaEditor.app/extensions/creaeditor-features/agents/director.agent.md',
			'file:///project/.github/agents/issues-director.agent.md',
			'file:///project/.github/agents/Release.Director.agent.md',
			'vscode-remote://ssh/project/.github/agents/director.agent.md?version=2',
			'file:///project/.github/agents/directorate.agent.md',
			'file:///project/.github/agents/codirector.agent.md',
			'file:///project/.github/agents/reviewer.agent.md',
			undefined,
		];
		assert.deepStrictEqual(uris.map(isDirectorAgentUri), [true, true, true, true, false, false, false, false]);
	});
});
