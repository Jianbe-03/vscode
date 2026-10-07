/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Creacoon pet's crew. While a chat runs subagents, each one gets a small pet
// beside the main pet that acts out what the subagent is doing.

import * as dom from '../../../../../base/browser/dom.js';
import { asCSSUrl } from '../../../../../base/browser/cssValue.js';
import { equals } from '../../../../../base/common/arrays.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { AgentsTreeStatus } from '../../common/agentsTree/agentsTreeModel.js';
import { ChatAgentActivity, CHAT_ROOT_AGENT_ID, getChatAgentActivities, IChatAgentActivityEntry } from '../../common/chatPet/chatAgentActivity.js';
import { IChatService } from '../../common/chatService/chatService.js';
import { IChatModel } from '../../common/model/chatModel.js';
import { ChatPetVariant } from '../chatPetService.js';

/** How long a finished subagent's pet celebrates (or is dizzy) before it leaves. */
export const CHAT_PET_CREW_FINISHED_DURATION = 3_000;
/** How long a crew pet takes to hop out. */
export const CHAT_PET_CREW_LEAVE_DURATION = 300;
/** The maximum number of crew pets shown at once; the rest are summarized in a "+N" chip. */
export const CHAT_PET_CREW_MAX_VISIBLE = 6;
const CHAT_PET_CREW_SIZE = 32;
const CHAT_PET_CREW_NESTED_SIZE = 26;
const CHAT_PET_CREW_SOURCE_SIZE = 96;
const CHAT_PET_CREW_GAP = 4;
const ACTIVITY_REFRESH_DELAY = 100;
/**
 * Hue rotations that give each crew pet its own tint around the brand green (teal, lime,
 * cyan, yellow-green, ...), so subagents working at the same time are easy to tell apart.
 */
export const CHAT_PET_CREW_HUES = [35, -35, 70, -70, 105, 150];
const ACTIVITY_POLL_INTERVAL = 750;

/** A body pose a crew pet can take. */
export type ChatPetCrewPose = 'idle' | 'typing' | 'search' | 'worry' | 'love' | 'dizzy' | 'planning' | 'reviewing' | 'thinking' | 'testing';

/**
 * A horizontal sprite strip: `frameDurations.length` frames of `frameWidth` by `frameHeight`
 * source pixels. A single static frame has no durations.
 */
export interface IChatPetSpriteSheet {
	readonly url: string;
	readonly frameWidth: number;
	readonly frameHeight: number;
	readonly frameDurations: readonly number[];
}

/**
 * Resolves the sprite sheet for a crew pose, in the pet's color variant.
 */
export type ChatPetCrewSpriteSheetProvider = (pose: ChatPetCrewPose, variant: ChatPetVariant, motionReduced: boolean) => IChatPetSpriteSheet;

/**
 * Presentation options shared by every crew pet.
 */
export interface IChatPetCrewOptions {
	readonly visible: boolean;
	readonly variant: ChatPetVariant;
	readonly motionReduced: boolean;
	readonly scale: number;
}

/**
 * Where the main pet stands, in the coordinates of the layer that contains the crew.
 */
export interface IChatPetCrewLayout {
	readonly petLeft: number;
	readonly petRight: number;
	/** The y coordinate of the platform the pets stand on. */
	readonly platformTop: number;
	readonly minimumLeft: number;
	readonly maximumRight: number;
}

/**
 * Returns the pose a pet takes for an activity.
 */
export function getChatPetCrewPose(activity: ChatAgentActivity): ChatPetCrewPose {
	switch (activity) {
		case ChatAgentActivity.Programming:
			return 'typing';
		case ChatAgentActivity.Testing:
			return 'testing';
		case ChatAgentActivity.Researching:
			return 'search';
		case ChatAgentActivity.Planning:
			return 'planning';
		case ChatAgentActivity.Reviewing:
			return 'reviewing';
		case ChatAgentActivity.Thinking:
			return 'thinking';
		case ChatAgentActivity.WaitingForInput:
			return 'worry';
		case ChatAgentActivity.Done:
			return 'love';
		case ChatAgentActivity.Failed:
			return 'dizzy';
		default:
			return 'idle';
	}
}

/**
 * Returns the codicon shown in the activity badge above a pet.
 */
export function getChatPetActivityIcon(activity: ChatAgentActivity): ThemeIcon {
	switch (activity) {
		case ChatAgentActivity.Programming: return Codicon.code;
		case ChatAgentActivity.Testing: return Codicon.terminal;
		case ChatAgentActivity.Researching: return Codicon.search;
		case ChatAgentActivity.Planning: return Codicon.checklist;
		case ChatAgentActivity.Reviewing: return Codicon.eye;
		case ChatAgentActivity.WaitingForInput: return Codicon.question;
		case ChatAgentActivity.Done: return Codicon.check;
		case ChatAgentActivity.Failed: return Codicon.error;
		default: return Codicon.lightbulb;
	}
}

/**
 * Returns the localized label of an activity.
 */
export function getChatPetActivityLabel(activity: ChatAgentActivity): string {
	switch (activity) {
		case ChatAgentActivity.Programming: return localize('chatPet.activity.programming', "Programming");
		case ChatAgentActivity.Testing: return localize('chatPet.activity.testing', "Running Commands");
		case ChatAgentActivity.Researching: return localize('chatPet.activity.researching', "Researching");
		case ChatAgentActivity.Planning: return localize('chatPet.activity.planning', "Planning");
		case ChatAgentActivity.Reviewing: return localize('chatPet.activity.reviewing', "Reviewing");
		case ChatAgentActivity.WaitingForInput: return localize('chatPet.activity.waiting', "Waiting for Input");
		case ChatAgentActivity.Done: return localize('chatPet.activity.done', "Done");
		case ChatAgentActivity.Failed: return localize('chatPet.activity.failed', "Failed");
		default: return localize('chatPet.activity.thinking', "Thinking");
	}
}

/**
 * Returns the display name of an agent, falling back to a generic name.
 */
export function getChatPetAgentName(entry: Pick<IChatAgentActivityEntry, 'id' | 'name'>): string {
	if (entry.name) {
		return entry.name;
	}
	return entry.id === CHAT_ROOT_AGENT_ID
		? localize('chatPet.agent.main', "Main agent")
		: localize('chatPet.agent.subagent', "Subagent");
}

/**
 * Returns the hover text of a pet, such as "Review agent — Reviewing".
 */
export function getChatPetAgentHover(entry: Pick<IChatAgentActivityEntry, 'id' | 'name' | 'description' | 'activity'>): string {
	const name = getChatPetAgentName(entry);
	const activity = getChatPetActivityLabel(entry.activity);
	return entry.description
		? localize('chatPet.agent.hoverWithDescription', "{0} — {1}\n{2}", name, activity, entry.description)
		: localize('chatPet.agent.hover', "{0} — {1}", name, activity);
}

function isFinished(status: AgentsTreeStatus): boolean {
	return status === AgentsTreeStatus.Done || status === AgentsTreeStatus.Failed || status === AgentsTreeStatus.Cancelled;
}

function isSameEntry(a: IChatAgentActivityEntry, b: IChatAgentActivityEntry): boolean {
	return a.id === b.id && a.parentId === b.parentId && a.depth === b.depth && a.name === b.name
		&& a.description === b.description && a.activity === b.activity && a.status === b.status;
}

/**
 * Keeps the list of agents working on a chat up to date: refreshes when the last request or its
 * response changes, and polls while an agent is working to pick up tool state changes and
 * subagents that run as their own chat.
 */
export class ChatPetAgentActivityTracker extends Disposable {

	private readonly _entries = observableValue<readonly IChatAgentActivityEntry[]>(this, []);
	readonly entries: IObservable<readonly IChatAgentActivityEntry[]> = this._entries;

	private _model: IChatModel | undefined;
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => this._refresh(), ACTIVITY_REFRESH_DELAY));
	private readonly _pollTimer = this._register(new MutableDisposable<IntervalTimer>());

	constructor(
		model: IObservable<IChatModel | undefined>,
		enabled: IObservable<boolean>,
		private readonly _chatService: Pick<IChatService, 'getSession'>,
	) {
		super();
		this._register(autorun(reader => {
			const currentModel = enabled.read(reader) ? model.read(reader) : undefined;
			this._model = currentModel;
			if (currentModel) {
				const response = currentModel.lastRequestObs.read(reader)?.response;
				currentModel.hasActiveRequest.read(reader);
				currentModel.requestNeedsInput.read(reader);
				if (response) {
					reader.store.add(response.onDidChange(() => {
						// Throttle rather than debounce: responses change on every streamed token.
						if (!this._refreshScheduler.isScheduled()) {
							this._refreshScheduler.schedule();
						}
					}));
				}
			}
			this._refresh();
		}));
	}

	private _refresh(): void {
		this._refreshScheduler.cancel();
		const entries = this._model ? getChatAgentActivities(this._model, this._chatService) : [];
		if (!equals(entries, this._entries.get(), isSameEntry)) {
			this._entries.set(entries, undefined);
		}
		const working = entries.some(entry => !isFinished(entry.status));
		if (working && !this._pollTimer.value) {
			const timer = new IntervalTimer();
			timer.cancelAndSet(() => this._refresh(), ACTIVITY_POLL_INTERVAL);
			this._pollTimer.value = timer;
		} else if (!working) {
			this._pollTimer.clear();
		}
	}
}

/**
 * A small pet acting out what one subagent is doing.
 */
class ChatPetCrewMember extends Disposable {

	readonly element: HTMLElement;
	private readonly _sprite: HTMLElement;
	private readonly _badge: HTMLElement;
	private _entry: IChatAgentActivityEntry;
	private _phase: 'working' | 'finished' | 'leaving' = 'working';
	private readonly _finishedScheduler = this._register(new RunOnceScheduler(() => this.leave(), CHAT_PET_CREW_FINISHED_DURATION));
	private readonly _leaveScheduler: RunOnceScheduler;

	constructor(
		entry: IChatAgentActivityEntry,
		options: IChatPetCrewOptions,
		private readonly _getSpriteSheet: ChatPetCrewSpriteSheetProvider,
		onDidLeave: () => void,
		hoverService: IHoverService,
		readonly hue: number,
	) {
		super();
		this._entry = entry;
		this.element = dom.$('.chat-pet-crew-member', { 'aria-hidden': 'true' });
		this.element.style.setProperty('--chat-pet-crew-hue', `${hue}deg`);
		this._sprite = dom.append(this.element, dom.$('.chat-pet-crew-sprite'));
		this._badge = dom.append(this.element, dom.$('span.chat-pet-crew-badge'));
		this._register(toDisposable(() => this.element.remove()));
		this._leaveScheduler = this._register(new RunOnceScheduler(onDidLeave, CHAT_PET_CREW_LEAVE_DURATION));
		this._register(hoverService.setupDelayedHover(this.element, () => ({ content: getChatPetAgentHover(this._entry) })));
		if (!options.motionReduced) {
			this.element.classList.add('entering');
			this._register(dom.addDisposableListener(this.element, dom.EventType.ANIMATION_END, event => {
				if (event.target === this.element) {
					this.element.classList.remove('entering');
				}
			}));
		}
		this.update(entry, options);
	}

	get entry(): IChatAgentActivityEntry {
		return this._entry;
	}

	get isWorking(): boolean {
		return this._phase === 'working';
	}

	update(entry: IChatAgentActivityEntry, options: IChatPetCrewOptions): void {
		if (this._phase === 'leaving') {
			return;
		}
		this._entry = entry;
		if (this._phase === 'working' && isFinished(entry.status)) {
			this._phase = 'finished';
			this._finishedScheduler.schedule();
		}

		const sheet = this._getSpriteSheet(getChatPetCrewPose(entry.activity), options.variant, options.motionReduced);
		const size = (entry.depth > 1 ? CHAT_PET_CREW_NESTED_SIZE : CHAT_PET_CREW_SIZE) * options.scale;
		const pixel = size / CHAT_PET_CREW_SOURCE_SIZE;
		const frameCount = Math.max(1, sheet.frameDurations.length);
		const stripWidth = sheet.frameWidth * frameCount * pixel;
		this.element.dataset.activity = entry.activity;
		this.element.style.width = `${size}px`;
		this.element.style.height = `${size}px`;
		this._sprite.style.width = `${sheet.frameWidth * pixel}px`;
		this._sprite.style.height = `${sheet.frameHeight * pixel}px`;
		this._sprite.style.backgroundImage = asCSSUrl(URI.parse(sheet.url));
		this._sprite.style.backgroundSize = `${stripWidth}px ${sheet.frameHeight * pixel}px`;
		this._sprite.style.setProperty('--chat-pet-crew-frames', String(frameCount));
		this._sprite.style.setProperty('--chat-pet-crew-strip-width', `${-stripWidth}px`);
		this._sprite.style.setProperty('--chat-pet-crew-duration', `${sheet.frameDurations.reduce((total, duration) => total + duration, 0)}ms`);
		this._sprite.classList.toggle('animated', frameCount > 1 && !options.motionReduced);
		this._badge.className = `chat-pet-crew-badge ${ThemeIcon.asClassName(getChatPetActivityIcon(entry.activity))}`;
	}

	leave(motionReduced = false): void {
		if (this._phase === 'leaving') {
			return;
		}
		this._phase = 'leaving';
		this._finishedScheduler.cancel();
		this.element.classList.remove('entering');
		this.element.classList.add('leaving');
		this._leaveScheduler.schedule(motionReduced ? 0 : CHAT_PET_CREW_LEAVE_DURATION);
	}
}

/**
 * The crew of small pets standing beside the main pet, one for every running subagent.
 */
export class ChatPetCrew extends Disposable {

	readonly element: HTMLElement;
	private readonly _overflow: HTMLElement;
	private readonly _members = this._register(new DisposableMap<string, ChatPetCrewMember>());
	private _entries: readonly IChatAgentActivityEntry[] = [];
	private _options: IChatPetCrewOptions | undefined;
	private _layout: IChatPetCrewLayout | undefined;

	constructor(
		parent: HTMLElement,
		private readonly _getSpriteSheet: ChatPetCrewSpriteSheetProvider,
		private readonly _hoverService: IHoverService,
	) {
		super();
		this.element = dom.append(parent, dom.$('.chat-pet-crew.hidden', { role: 'img' }));
		this._overflow = dom.append(this.element, dom.$('span.chat-pet-crew-overflow.hidden', { 'aria-hidden': 'true' }));
		this._register(toDisposable(() => this.element.remove()));
	}

	/**
	 * Updates the crew to the agents working on the chat. The root agent is represented by the
	 * main pet, and only contributes to the accessible summary.
	 */
	update(entries: readonly IChatAgentActivityEntry[], options: IChatPetCrewOptions): void {
		this._entries = entries;
		this._options = options;
		if (!options.visible) {
			this._members.clearAndDisposeAll();
			this._render();
			return;
		}

		const subagents = entries.filter(entry => entry.depth > 0);
		const ids = new Set(subagents.map(entry => entry.id));
		for (const [id, member] of this._members) {
			if (!ids.has(id) && member.isWorking) {
				member.leave(options.motionReduced);
			}
		}
		for (const entry of subagents) {
			const member = this._members.get(entry.id);
			if (member) {
				member.update(entry, options);
			} else if (!isFinished(entry.status)) {
				const created = new ChatPetCrewMember(entry, options, this._getSpriteSheet, () => this._removeMember(entry.id), this._hoverService, this._pickHue());
				this._members.set(entry.id, created);
			}
		}
		this._render();
	}

	/**
	 * Places the crew beside the main pet, on its left when there is room, otherwise on its right.
	 */
	layout(layout: IChatPetCrewLayout | undefined): void {
		this._layout = layout;
		if (!layout || this.element.classList.contains('hidden')) {
			return;
		}
		const width = this.element.offsetWidth;
		const leftSide = layout.petLeft - CHAT_PET_CREW_GAP - width >= layout.minimumLeft || layout.petRight + CHAT_PET_CREW_GAP + width > layout.maximumRight;
		this.element.dataset.side = leftSide ? 'left' : 'right';
		this.element.style.left = `${leftSide ? layout.petLeft - CHAT_PET_CREW_GAP - width : layout.petRight + CHAT_PET_CREW_GAP}px`;
		this.element.style.top = `${layout.platformTop - this.element.offsetHeight}px`;
	}

	/** The first tint no current crew pet has, cycling once all are in use. */
	private _pickHue(): number {
		const used = new Set([...this._members].map(([, member]) => member.hue));
		return CHAT_PET_CREW_HUES.find(hue => !used.has(hue)) ?? CHAT_PET_CREW_HUES[this._members.size % CHAT_PET_CREW_HUES.length];
	}

	private _removeMember(id: string): void {
		this._members.deleteAndDispose(id);
		this._render();
	}

	private _render(): void {
		// Order the pets like the agents: the first subagent stands closest to the main pet.
		const order = new Map(this._entries.map((entry, index) => [entry.id, index]));
		const members = [...this._members]
			.sort(([a], [b]) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
			.map(([, member]) => member);
		members.forEach((member, index) => {
			// Only move pets that are out of place: moving an element restarts its animations.
			const current = this.element.children.item(index);
			if (current !== member.element) {
				this.element.insertBefore(member.element, current);
			}
			member.element.classList.toggle('hidden', index >= CHAT_PET_CREW_MAX_VISIBLE);
		});
		const hiddenCount = Math.max(0, members.length - CHAT_PET_CREW_MAX_VISIBLE);
		this._overflow.textContent = localize('chatPet.crew.more', "+{0}", hiddenCount);
		this._overflow.classList.toggle('hidden', hiddenCount === 0);

		const working = this._entries.filter(entry => !isFinished(entry.status));
		this.element.classList.toggle('hidden', !this._options?.visible || (members.length === 0 && working.length === 0));
		const summary = working.map(entry => localize('chatPet.crew.summaryItem', "{0}: {1}", getChatPetAgentName(entry), getChatPetActivityLabel(entry.activity))).join(', ');
		this.element.setAttribute('aria-label', working.length === 1
			? localize('chatPet.crew.summaryOne', "1 agent working: {0}", summary)
			: localize('chatPet.crew.summary', "{0} agents working: {1}", working.length, summary));
		this.layout(this._layout);
	}
}
