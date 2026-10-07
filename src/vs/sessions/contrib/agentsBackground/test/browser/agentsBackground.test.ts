/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../browser/media/agentsBackground.css';
import '../../../../browser/parts/media/sessionsPart.css';
import assert from 'assert';
import { getWindow } from '../../../../../base/browser/dom.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { mock, upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestAccessibilityService } from '../../../../../platform/accessibility/test/common/testAccessibilityService.js';
import { IConfigurationChangeEvent } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { IWorkbenchLayoutService, Parts } from '../../../../../workbench/services/layout/browser/layoutService.js';
import { AGENTS_BACKGROUND_SETTING, AgentsBackground, AgentsBackgroundService } from '../../browser/agentsBackground.js';

suite('AgentsBackgroundService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(background?: AgentsBackground) {
		const mainContainer = document.createElement('div');
		mainContainer.className = 'monaco-workbench';
		const sessionsContainer = document.createElement('div');
		sessionsContainer.className = 'part sessionspart';
		const content = document.createElement('div');
		content.className = 'content';
		sessionsContainer.append(content);
		mainContainer.append(sessionsContainer);
		document.body.appendChild(mainContainer);
		store.add(toDisposable(() => mainContainer.remove()));

		const layoutService = new class extends mock<IWorkbenchLayoutService>() {
			override readonly mainContainer = mainContainer;
			override getContainer(_targetWindow: Window, part?: Parts): HTMLElement {
				return part === Parts.SESSIONS_PART ? sessionsContainer : mainContainer;
			}
			override isVisible(): boolean {
				return true;
			}
		}();
		const configurationService = new TestConfigurationService(background ? { [AGENTS_BACKGROUND_SETTING]: background } : {});
		store.add(configurationService.onDidChangeConfigurationEmitter);
		// The test accessibility service reports reduced motion, so no shooting star timers run.
		const service = store.add(new AgentsBackgroundService(layoutService, new MockContextKeyService(), configurationService, new TestAccessibilityService()));
		const changeBackground = async (value: AgentsBackground) => {
			await configurationService.setUserConfiguration(AGENTS_BACKGROUND_SETTING, value);
			configurationService.onDidChangeConfigurationEmitter.fire(upcastPartial<IConfigurationChangeEvent>({
				affectsConfiguration: key => key === AGENTS_BACKGROUND_SETTING,
			}));
		};
		const describe = () => {
			const background = sessionsContainer.querySelector<HTMLElement>(':scope > .agents-creacoon-background');
			return background ? {
				kind: background.classList.contains('starry-night') ? 'starryNight' : background.classList.contains('pattern') ? 'pattern' : 'unknown',
				hasStars: background.querySelectorAll('.agents-creacoon-star').length >= 40,
				hasPattern: !!background.querySelector('.agents-creacoon-pattern'),
			} : undefined;
		};
		return { service, sessionsContainer, content, changeBackground, describe };
	}

	test('shows the starry night by default and follows the setting', async () => {
		const { service, changeBackground, describe } = createService();
		const host = store.add(service.mountHost());

		const states: unknown[] = [service.background, describe()];
		await changeBackground(AgentsBackground.Pattern);
		states.push(describe());
		host.setHostVisible(false);
		states.push(describe());
		host.setHostVisible(true);
		states.push(describe());

		assert.deepStrictEqual(states, [
			AgentsBackground.StarryNight,
			{ kind: 'starryNight', hasStars: true, hasPattern: false },
			{ kind: 'pattern', hasStars: false, hasPattern: true },
			undefined,
			{ kind: 'pattern', hasStars: false, hasPattern: true },
		]);
	});

	test('shows nothing when the background is none', () => {
		const { service, describe } = createService(AgentsBackground.None);
		store.add(service.mountHost());
		assert.deepStrictEqual(describe(), undefined);
	});

	test('layers the background below sessions content', () => {
		const { service, sessionsContainer, content } = createService();
		store.add(service.mountHost());

		const background = sessionsContainer.querySelector<HTMLElement>(':scope > .agents-creacoon-background');
		const targetWindow = getWindow(sessionsContainer);
		assert.deepStrictEqual({
			active: sessionsContainer.classList.contains('agents-background-active'),
			backgroundZIndex: background ? targetWindow.getComputedStyle(background).zIndex : undefined,
			contentZIndex: targetWindow.getComputedStyle(content).zIndex,
		}, {
			active: true,
			backgroundZIndex: '1',
			contentZIndex: '2',
		});
	});
});
