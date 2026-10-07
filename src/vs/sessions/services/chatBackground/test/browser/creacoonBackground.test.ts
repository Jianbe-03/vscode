/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../../browser/parts/media/sessionsPart.css';
import assert from 'assert';
import { $, append, getWindow } from '../../../../../base/browser/dom.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SessionsChatBackgroundRenderer, SessionsChatBackgroundReplica } from '../../browser/chatBackgroundRenderer.js';
import { CreacoonBackgroundLayer } from '../../browser/creacoonBackground.js';

suite('Creacoon Chat Background', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createPart(width: number, height: number) {
		const workbench = $('.monaco-workbench.agent-sessions-workbench');
		const part = append(workbench, $('.part.sessionspart'));
		part.style.position = 'relative';
		part.style.width = `${width}px`;
		part.style.height = `${height}px`;
		const content = append(part, $('.content'));
		getWindow(workbench).document.body.appendChild(workbench);
		store.add(toDisposable(() => workbench.remove()));
		return { workbench, part, content };
	}

	function getStarPositions(element: Element | null | undefined): string[] {
		return Array.from(element?.querySelectorAll<HTMLElement>('.agents-creacoon-star') ?? [], star => `${star.style.left} ${star.style.top}`);
	}

	test('renders the Starry Night and Creacoon Pattern backgrounds behind sessions content', () => {
		const { part, content } = createPart(700, 500);
		const renderer = store.add(new SessionsChatBackgroundRenderer(part));
		const backgroundLayer = part.querySelector<HTMLElement>(':scope > .sessions-chat-background');
		const layer = backgroundLayer?.querySelector<HTMLElement>(':scope > .agents-creacoon-background');
		const describe = () => ({
			hasChatBackground: part.classList.contains('has-chat-background'),
			backgroundHidden: backgroundLayer?.hidden,
			layerHidden: layer?.hidden,
			kind: layer?.classList.contains('starry-night') ? 'starryNight' : layer?.classList.contains('pattern') ? 'pattern' : undefined,
			stars: layer?.querySelectorAll('.agents-creacoon-star').length,
			hasPattern: !!layer?.querySelector('.agents-creacoon-pattern'),
		});

		renderer.setBackground({ kind: 'starryNight' });
		const starryNight = describe();
		const targetWindow = getWindow(part);
		const layering = {
			ariaHidden: layer?.ariaHidden,
			pointerEvents: layer ? targetWindow.getComputedStyle(layer).pointerEvents : undefined,
			backgroundZIndex: backgroundLayer ? targetWindow.getComputedStyle(backgroundLayer).zIndex : undefined,
			contentZIndex: targetWindow.getComputedStyle(content).zIndex,
		};
		renderer.setBackground({ kind: 'pattern' });
		const pattern = describe();
		renderer.setBackground({ kind: 'codicons' });
		const codicons = describe();
		renderer.setBackground(undefined);

		assert.deepStrictEqual({ starryNight, layering, pattern, codicons, none: describe() }, {
			starryNight: { hasChatBackground: true, backgroundHidden: false, layerHidden: false, kind: 'starryNight', stars: 50, hasPattern: false },
			layering: { ariaHidden: 'true', pointerEvents: 'none', backgroundZIndex: '0', contentZIndex: '2' },
			pattern: { hasChatBackground: true, backgroundHidden: false, layerHidden: false, kind: 'pattern', stars: 0, hasPattern: true },
			codicons: { hasChatBackground: true, backgroundHidden: false, layerHidden: true, kind: undefined, stars: 0, hasPattern: false },
			none: { hasChatBackground: false, backgroundHidden: true, layerHidden: true, kind: undefined, stars: 0, hasPattern: false },
		});
	});

	test('shows the same sky in the sticky scroll replica and keeps stars in place as the view grows', () => {
		const { part, workbench } = createPart(700, 500);
		const renderer = store.add(new SessionsChatBackgroundRenderer(part));
		renderer.setBackground({ kind: 'starryNight' });
		const source = part.querySelector<HTMLElement>(':scope > .sessions-chat-background')!;
		const stickyContainer = append(workbench, $('.sticky-container'));
		const replica = store.add(new SessionsChatBackgroundReplica(source, stickyContainer));
		replica.setBackground({ kind: 'starryNight' });
		const sourceStars = getStarPositions(source);
		const replicaStars = getStarPositions(stickyContainer);

		const layer = store.add(new CreacoonBackgroundLayer(getWindow(part)));
		layer.setKind('starryNight', 700, 500);
		const smallSky = getStarPositions(layer.element);
		layer.layout(1400, 1000);
		const largeSky = getStarPositions(layer.element);

		assert.deepStrictEqual({
			replicaMatchesSource: replicaStars.length === sourceStars.length && replicaStars.every((star, index) => star === sourceStars[index]),
			smallSky: smallSky.length,
			largeSky: largeSky.length,
			largeSkyKeepsSmallSky: smallSky.every((star, index) => star === largeSky[index]),
		}, {
			replicaMatchesSource: true,
			smallSky: 50,
			largeSky: 150,
			largeSkyKeepsSmallSky: true,
		});
	});

	test('only sends shooting stars across the Starry Night while they are enabled', () => {
		const timeouts = new Set<number>();
		let nextTimeout = 0;
		const targetWindow = upcastPartial<Window>({
			performance: upcastPartial<Performance>({ now: () => 0 }),
			setTimeout: () => {
				timeouts.add(++nextTimeout);
				return nextTimeout;
			},
			clearTimeout: (id?: number) => {
				if (id !== undefined) {
					timeouts.delete(id);
				}
			},
		});
		const layer = store.add(new CreacoonBackgroundLayer(targetWindow));
		const scheduled: number[] = [];

		layer.setKind('starryNight', 700, 500);
		scheduled.push(timeouts.size);
		layer.setShootingStarsEnabled(true);
		scheduled.push(timeouts.size);
		layer.setKind('pattern', 700, 500);
		scheduled.push(timeouts.size);
		layer.setKind('starryNight', 700, 500);
		scheduled.push(timeouts.size);
		layer.setShootingStarsEnabled(false);
		scheduled.push(timeouts.size);

		assert.deepStrictEqual(scheduled, [0, 1, 0, 1, 0]);
	});
});
