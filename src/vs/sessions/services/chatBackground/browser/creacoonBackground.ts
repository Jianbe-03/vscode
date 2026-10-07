/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Creacoon chat backgrounds of the Agents window: a starry night whose stars are
// Creacoon marks (the default background) and a calm pattern of Creacoon marks. They are drawn by
// the chat background renderer, so they stay behind the new-session view and open chats alike.

import './media/creacoonBackground.css';
import { $, clearNode } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/**
 * The Creacoon backgrounds.
 */
export type CreacoonBackgroundKind = 'starryNight' | 'pattern';

/** Star density: one star per this many square pixels, within {@link MIN_STARS} and {@link MAX_STARS}. */
const PIXELS_PER_STAR = 7000;
const MIN_STARS = 40;
const MAX_STARS = 150;

/** Duration of one drift of the pattern by a full tile; matches `agents-creacoon-drift` in the CSS. */
const PATTERN_DRIFT_DURATION_S = 120;

/** Delay range between two shooting stars. */
const SHOOTING_STAR_MIN_DELAY_MS = 3500;
const SHOOTING_STAR_MAX_DELAY_MS = 9000;

/** Seed of the sky, so every copy of the background (such as the sticky scroll replica) shows the same stars. */
const STAR_SEED = 0x0c4ea;

interface IStar {
	readonly left: number;
	readonly top: number;
	readonly size: number;
	readonly tone: 'light' | 'green' | 'deep';
	readonly rotation: number;
	readonly opacity: number;
	readonly twinkleDuration: number;
	readonly twinkleOffset: number;
}

/**
 * A small deterministic pseudo random generator (mulberry32).
 */
function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = Math.imul(state ^ (state >>> 15), state | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

function randomBetween(random: () => number, min: number, max: number): number {
	return min + random() * (max - min);
}

let sky: readonly IStar[] | undefined;

/**
 * The stars of the sky. A smaller view shows a prefix of them, so resizing the view adds or
 * removes stars without moving the others.
 */
function getSky(): readonly IStar[] {
	if (!sky) {
		const random = createSeededRandom(STAR_SEED);
		const stars: IStar[] = [];
		for (let i = 0; i < MAX_STARS; i++) {
			const roll = random();
			const tone = random();
			stars.push({
				left: randomBetween(random, 0, 100),
				top: randomBetween(random, 0, 100),
				// Mostly small stars, some medium ones and a few bright large ones.
				size: roll < 0.7 ? randomBetween(random, 5, 8) : roll < 0.93 ? randomBetween(random, 10, 14) : randomBetween(random, 16, 22),
				tone: tone < 0.55 ? 'light' : tone < 0.85 ? 'green' : 'deep',
				rotation: Math.floor(random() * 4) * 90,
				opacity: randomBetween(random, 0.45, 0.95),
				twinkleDuration: randomBetween(random, 2.5, 6),
				twinkleOffset: randomBetween(random, 0, 6),
			});
		}
		sky = stars;
	}
	return sky;
}

/**
 * The number of stars shown in a view of the given size.
 */
function getStarCount(width: number, height: number): number {
	return Math.round(Math.min(MAX_STARS, Math.max(MIN_STARS, (width || 1200) * (height || 800) / PIXELS_PER_STAR)));
}

/**
 * Renders a Creacoon background into a layer of the chat background. Animations are phased by
 * the page clock, so copies of the background created at different times twinkle and drift in step.
 */
export class CreacoonBackgroundLayer extends Disposable {

	readonly element: HTMLElement;
	private readonly shootingStars = this._register(new MutableDisposable<IDisposable>());
	private kind: CreacoonBackgroundKind | undefined;
	private readonly stars: HTMLElement[] = [];
	private shootingStarsEnabled = false;

	constructor(private readonly targetWindow: Window) {
		super();
		this.element = $('.agents-creacoon-background');
		this.element.ariaHidden = 'true';
		this.element.hidden = true;
	}

	/**
	 * Shows the given background, or nothing, sized for a view of the given size.
	 */
	setKind(kind: CreacoonBackgroundKind | undefined, width: number, height: number): void {
		if (kind !== this.kind) {
			this.kind = kind;
			this.shootingStars.clear();
			clearNode(this.element);
			this.stars.length = 0;
			this.element.hidden = !kind;
			this.element.classList.toggle('starry-night', kind === 'starryNight');
			this.element.classList.toggle('pattern', kind === 'pattern');
			if (kind === 'pattern') {
				const pattern = $('.agents-creacoon-pattern');
				pattern.style.animationDelay = `${-(this.getClockSeconds() % PATTERN_DRIFT_DURATION_S)}s`;
				this.element.appendChild(pattern);
			}
		}
		this.layout(width, height);
		this.updateShootingStars();
	}

	/**
	 * Adapts the number of stars to the size of the view.
	 */
	layout(width: number, height: number): void {
		if (this.kind !== 'starryNight') {
			return;
		}
		const count = getStarCount(width, height);
		const clock = this.getClockSeconds();
		while (this.stars.length < count) {
			const star = this.createStar(this.stars.length, clock);
			this.stars.push(star);
			this.element.appendChild(star);
		}
		while (this.stars.length > count) {
			this.stars.pop()?.remove();
		}
	}

	/**
	 * Enables shooting stars, which are off until the host enables them (for example once it knows
	 * that the user does not prefer reduced motion).
	 */
	setShootingStarsEnabled(enabled: boolean): void {
		this.shootingStarsEnabled = enabled;
		this.updateShootingStars();
	}

	private updateShootingStars(): void {
		if (this.kind === 'starryNight' && this.shootingStarsEnabled) {
			if (!this.shootingStars.value) {
				this.shootingStars.value = this.scheduleShootingStars();
			}
		} else {
			this.shootingStars.clear();
		}
	}

	private getClockSeconds(): number {
		return this.targetWindow.performance.now() / 1000;
	}

	private createStar(index: number, clock: number): HTMLElement {
		const star = getSky()[index];
		const element = $('.agents-creacoon-star');
		element.dataset.tone = star.tone;
		element.style.left = `${star.left}%`;
		element.style.top = `${star.top}%`;
		element.style.width = `${star.size}px`;
		element.style.height = `${star.size}px`;
		element.style.setProperty('--star-rotation', `${star.rotation}deg`);
		element.style.setProperty('--star-opacity', `${star.opacity}`);
		element.style.setProperty('--star-twinkle-duration', `${star.twinkleDuration}s`);
		element.style.setProperty('--star-twinkle-delay', `${-((clock + star.twinkleOffset) % star.twinkleDuration)}s`);
		return element;
	}

	/**
	 * Sends a Creacoon mark across the sky every few seconds, trailing a fading tail.
	 */
	private scheduleShootingStars(): IDisposable {
		const store = new DisposableStore();
		let timeout: number | undefined;
		const scheduleNext = (delay: number) => {
			timeout = this.targetWindow.setTimeout(() => {
				this.launchShootingStar(store);
				scheduleNext(randomBetween(Math.random, SHOOTING_STAR_MIN_DELAY_MS, SHOOTING_STAR_MAX_DELAY_MS));
			}, delay);
		};
		scheduleNext(randomBetween(Math.random, 1500, 4000));
		store.add(toDisposable(() => this.targetWindow.clearTimeout(timeout)));
		return store;
	}

	private launchShootingStar(store: DisposableStore): void {
		const shootingStar = $('.agents-creacoon-shooting-star');
		shootingStar.appendChild($('.agents-creacoon-shooting-star-head'));
		shootingStar.style.left = `${randomBetween(Math.random, 30, 95)}%`;
		shootingStar.style.top = `${randomBetween(Math.random, 0, 35)}%`;
		shootingStar.style.setProperty('--shooting-angle', `${randomBetween(Math.random, 140, 162)}deg`);
		shootingStar.style.setProperty('--shooting-distance', `${randomBetween(Math.random, 380, 620)}px`);
		shootingStar.style.setProperty('--shooting-duration', `${randomBetween(Math.random, 1.1, 1.7)}s`);
		const removal = store.add(toDisposable(() => shootingStar.remove()));
		// The head and tail run their own animations, whose animationend events bubble up here.
		const onAnimationEnd = (e: AnimationEvent) => {
			if (e.target === shootingStar) {
				shootingStar.removeEventListener('animationend', onAnimationEnd);
				store.delete(removal);
			}
		};
		shootingStar.addEventListener('animationend', onAnimationEnd);
		this.element.appendChild(shootingStar);
	}
}
