/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { NullHoverService } from '../../../../../../platform/hover/test/browser/nullHoverService.js';
import { ChatReadOnlyBanner } from '../../../browser/widget/chatReadOnlyBanner.js';

suite('ChatReadOnlyBanner - CreaEditor lock notice', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('shows a lock notice with its actions and goes back to its own message', () => {
		const banner = store.add(new ChatReadOnlyBanner('Archived sessions are read-only.', NullHoverService));
		const ran: string[] = [];
		const read = () => ({
			text: banner.domNode.querySelector('.chat-readonly-banner-text')?.textContent,
			actions: [...banner.domNode.querySelectorAll('.chat-readonly-banner-action')].map(action => action.textContent),
		});
		banner.setNotice({ message: 'This chat continues on Office.', actions: [{ label: 'Open on Server', run: () => ran.push('open') }, { label: 'Take Back Here', run: () => ran.push('back') }] });
		const locked = read();
		(banner.domNode.querySelectorAll('.chat-readonly-banner-action')[1] as HTMLElement).click();
		banner.setNotice(undefined);
		assert.deepStrictEqual({ locked, ran, unlocked: read() }, {
			locked: { text: 'This chat continues on Office.', actions: ['Open on Server', 'Take Back Here'] },
			ran: ['back'],
			unlocked: { text: 'Archived sessions are read-only.', actions: [] },
		});
	});
});
