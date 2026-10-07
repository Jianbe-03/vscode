/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the background of the Agents window's new-session view: a starry night whose stars
// are Creacoon marks (the default), a calm pattern of Creacoon marks, or none.

import { $, getWindow, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchLayoutService, Parts } from '../../../../workbench/services/layout/browser/layoutService.js';
import { SessionsBackgroundActiveContext } from '../../../common/contextkeys.js';

export const AGENTS_BACKGROUND_SETTING = 'sessions.background';

/**
 * The backgrounds the Agents window offers.
 */
export const enum AgentsBackground {
	StarryNight = 'starryNight',
	Pattern = 'pattern',
	None = 'none',
}

/**
 * Labels of the backgrounds, shared by the setting, the command and the context menu.
 */
export function getAgentsBackgroundLabel(background: AgentsBackground): string {
	switch (background) {
		case AgentsBackground.StarryNight: return localize('agentsBackground.starryNight', "Starry Night");
		case AgentsBackground.Pattern: return localize('agentsBackground.pattern', "Creacoon Pattern");
		case AgentsBackground.None: return localize('agentsBackground.none', "None");
	}
}

/** Duration of the fade-out before a background is removed. */
const EXIT_DURATION_MS = 400;

/** Star density: one star per this many square pixels, within {@link MIN_STARS} and {@link MAX_STARS}. */
const PIXELS_PER_STAR = 7000;
const MIN_STARS = 40;
const MAX_STARS = 150;

/** Delay range between two shooting stars. */
const SHOOTING_STAR_MIN_DELAY_MS = 3500;
const SHOOTING_STAR_MAX_DELAY_MS = 9000;

export const IAgentsBackgroundService = createDecorator<IAgentsBackgroundService>('agentsBackgroundService');

export interface IAgentsBackgroundService {
	readonly _serviceBrand: undefined;

	/** The configured background. */
	readonly background: AgentsBackground;

	/** Changes the configured background. */
	setBackground(background: AgentsBackground): Promise<void>;

	/**
	 * Registers a view that shows the background while it is visible. The background is mounted in
	 * the sessions part while at least one host is visible. Disposing the handle unregisters the host.
	 */
	mountHost(): IAgentsBackgroundHost;
}

export interface IAgentsBackgroundHost extends IDisposable {
	/**
	 * Informs the service whether the host is visible. When the last visible host goes invisible the
	 * background is removed synchronously (no fade-out) so it cannot flash behind a sibling view.
	 * Hosts start out visible.
	 */
	setHostVisible(visible: boolean): void;
}

interface IBackgroundHost {
	visible: boolean;
}

export class AgentsBackgroundService extends Disposable implements IAgentsBackgroundService {

	declare readonly _serviceBrand: undefined;

	private readonly hosts = new Set<IBackgroundHost>();
	private readonly activeRef = this._register(new MutableDisposable<IActiveBackground>());
	private readonly pendingExit = this._register(new MutableDisposable<IDisposable>());
	private readonly activeContextKey: IContextKey<boolean>;
	private activeKind: AgentsBackground | undefined;

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
	) {
		super();
		this.activeContextKey = SessionsBackgroundActiveContext.bindTo(contextKeyService);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(AGENTS_BACKGROUND_SETTING)) {
				this.reconcile(/* animate */ true);
			}
		}));
		// Shooting stars and twinkling follow the reduced motion preference.
		this._register(this.accessibilityService.onDidChangeReducedMotion(() => {
			if (this.activeRef.value) {
				this.deactivate(/* animate */ false);
				this.reconcile(/* animate */ false);
			}
		}));
	}

	get background(): AgentsBackground {
		const value = this.configurationService.getValue<string>(AGENTS_BACKGROUND_SETTING);
		return value === AgentsBackground.Pattern || value === AgentsBackground.None ? value : AgentsBackground.StarryNight;
	}

	async setBackground(background: AgentsBackground): Promise<void> {
		await this.configurationService.updateValue(AGENTS_BACKGROUND_SETTING, background);
	}

	mountHost(): IAgentsBackgroundHost {
		const host: IBackgroundHost = { visible: true };
		this.hosts.add(host);
		this.reconcile(/* animate */ false);
		return {
			setHostVisible: visible => {
				if (host.visible !== visible) {
					host.visible = visible;
					this.reconcile(/* animate */ false);
				}
			},
			dispose: () => {
				this.hosts.delete(host);
				this.reconcile(/* animate */ false);
			},
		};
	}

	/**
	 * Shows the configured background while a host is visible, and removes it otherwise.
	 * @param animate whether a background that goes away fades out (user changes) or is removed at once (view changes).
	 */
	private reconcile(animate: boolean): void {
		const kind = this.background;
		const wanted = this.hasVisibleHost() && kind !== AgentsBackground.None ? kind : undefined;
		if (wanted === this.activeKind && (wanted === undefined || this.activeRef.value)) {
			return;
		}
		if (this.activeRef.value) {
			this.deactivate(animate && wanted === undefined);
		}
		if (wanted === undefined) {
			if (!animate) {
				this.pendingExit.clear();
			}
			return;
		}
		this.pendingExit.clear();
		const active = createActiveBackground(this.layoutService, wanted, this.accessibilityService.isMotionReduced());
		// No sessions part yet: try again on the next visibility or configuration change.
		if (!active) {
			return;
		}
		this.activeRef.value = active;
		this.activeKind = wanted;
		this.activeContextKey.set(true);
	}

	private hasVisibleHost(): boolean {
		for (const host of this.hosts) {
			if (host.visible) {
				return true;
			}
		}
		return false;
	}

	private deactivate(animate: boolean): void {
		this.activeKind = undefined;
		this.activeContextKey.set(false);
		if (!animate) {
			this.activeRef.clear();
			return;
		}
		// Detach without disposing so the fade-out can run; the handle returned by exit() disposes the
		// background when the fade completes, when the service is disposed, or when it is replaced.
		const active = this.activeRef.clearAndLeak();
		if (!active) {
			return;
		}
		const pending = active.exit(() => {
			if (this.pendingExit.value === pending) {
				this.pendingExit.clear();
			}
		});
		this.pendingExit.value = pending;
	}
}

interface IActiveBackground extends IDisposable {
	/**
	 * Fades the background out and disposes it when done. Disposing the returned handle before the
	 * fade finishes disposes immediately.
	 */
	exit(onDidComplete: () => void): IDisposable;
}

/**
 * Builds a background layer inside the sessions part. Returns `undefined` if the sessions part isn't
 * available.
 */
function createActiveBackground(layoutService: IWorkbenchLayoutService, kind: AgentsBackground.StarryNight | AgentsBackground.Pattern, reducedMotion: boolean): IActiveBackground | undefined {
	const targetWindow = getWindow(layoutService.mainContainer);
	const sessionsContainer = layoutService.getContainer(targetWindow, Parts.SESSIONS_PART);
	if (!sessionsContainer || !layoutService.isVisible(Parts.SESSIONS_PART, targetWindow)) {
		return undefined;
	}

	const store = new DisposableStore();
	const background = $(`.agents-creacoon-background.${kind === AgentsBackground.StarryNight ? 'starry-night' : 'pattern'}`);
	// Decorative: hide the subtree from the accessibility tree.
	background.setAttribute('aria-hidden', 'true');
	if (kind === AgentsBackground.Pattern) {
		background.appendChild($('.agents-creacoon-pattern'));
	} else {
		const rect = sessionsContainer.getBoundingClientRect();
		renderStars(background, (rect.width || 1200) * (rect.height || 800));
		if (!reducedMotion) {
			store.add(scheduleShootingStars(background, targetWindow));
		}
	}
	// First child so the sessions content paints over it.
	sessionsContainer.insertBefore(background, sessionsContainer.firstChild);
	// The Sessions Grid wraps the chat in containers with opaque backgrounds (see
	// sessionsPart.css); this class clears them so the background shows through.
	sessionsContainer.classList.add('agents-background-active');
	store.add(toDisposable(() => {
		background.remove();
		sessionsContainer.classList.remove('agents-background-active');
	}));
	// Fade in on the next frame so the opacity transition runs.
	store.add(scheduleAtNextAnimationFrame(targetWindow, () => background.classList.add('visible')));

	return {
		dispose: () => store.dispose(),
		exit: onDidComplete => {
			background.classList.remove('visible');
			const timeout = targetWindow.setTimeout(() => {
				store.dispose();
				onDidComplete();
			}, EXIT_DURATION_MS);
			return toDisposable(() => {
				targetWindow.clearTimeout(timeout);
				store.dispose();
			});
		},
	};
}

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

/**
 * Scatters Creacoon-mark stars over the background. Positions are percentages so the sky keeps
 * its shape when the window resizes.
 */
function renderStars(background: HTMLElement, area: number): void {
	const count = Math.round(Math.min(MAX_STARS, Math.max(MIN_STARS, area / PIXELS_PER_STAR)));
	for (let i = 0; i < count; i++) {
		const star = $('.agents-creacoon-star');
		const roll = Math.random();
		// Mostly small stars, some medium ones and a few bright large ones.
		const size = roll < 0.7 ? randomBetween(5, 8) : roll < 0.93 ? randomBetween(10, 14) : randomBetween(16, 22);
		const tone = Math.random();
		star.dataset.tone = tone < 0.55 ? 'light' : tone < 0.85 ? 'green' : 'deep';
		star.style.left = `${randomBetween(0, 100)}%`;
		star.style.top = `${randomBetween(0, 100)}%`;
		star.style.width = `${size}px`;
		star.style.height = `${size}px`;
		star.style.setProperty('--star-rotation', `${Math.floor(Math.random() * 4) * 90}deg`);
		star.style.setProperty('--star-opacity', `${randomBetween(0.45, 0.95)}`);
		star.style.setProperty('--star-twinkle-duration', `${randomBetween(2.5, 6)}s`);
		star.style.setProperty('--star-twinkle-delay', `${-randomBetween(0, 6)}s`);
		background.appendChild(star);
	}
}

/**
 * Sends a Creacoon mark across the sky every few seconds, trailing a fading tail.
 */
function scheduleShootingStars(background: HTMLElement, targetWindow: Window): IDisposable {
	const store = new DisposableStore();
	let timeout: number | undefined;
	const scheduleNext = (delay: number) => {
		timeout = targetWindow.setTimeout(() => {
			launchShootingStar(background, store);
			scheduleNext(randomBetween(SHOOTING_STAR_MIN_DELAY_MS, SHOOTING_STAR_MAX_DELAY_MS));
		}, delay);
	};
	scheduleNext(randomBetween(1500, 4000));
	store.add(toDisposable(() => targetWindow.clearTimeout(timeout)));
	return store;
}

function launchShootingStar(background: HTMLElement, store: DisposableStore): void {
	const shootingStar = $('.agents-creacoon-shooting-star');
	shootingStar.appendChild($('.agents-creacoon-shooting-star-head'));
	shootingStar.style.left = `${randomBetween(30, 95)}%`;
	shootingStar.style.top = `${randomBetween(0, 35)}%`;
	shootingStar.style.setProperty('--shooting-angle', `${randomBetween(140, 162)}deg`);
	shootingStar.style.setProperty('--shooting-distance', `${randomBetween(380, 620)}px`);
	shootingStar.style.setProperty('--shooting-duration', `${randomBetween(1.1, 1.7)}s`);
	const listener = store.add(toDisposable(() => shootingStar.remove()));
	// The head and tail run their own animations, whose animationend events bubble up here.
	const onAnimationEnd = (e: AnimationEvent) => {
		if (e.target === shootingStar) {
			shootingStar.removeEventListener('animationend', onAnimationEnd);
			store.delete(listener);
		}
	};
	shootingStar.addEventListener('animationend', onAnimationEnd);
	background.appendChild(shootingStar);
}
