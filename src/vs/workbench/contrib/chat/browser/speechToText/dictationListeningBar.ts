/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: a slim bar docked directly above the chat input while dictation is listening, with a
// live audio-level graph, what dictation is doing ("Listening…" or "Transcribing…") and, for Whisper,
// the spoken language as a chip that switches it.

import * as dom from '../../../../../base/browser/dom.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { language as displayLanguage } from '../../../../../base/common/platform.js';
import { ChatInputStackSlot, setChatInputStackSlot } from '../widget/input/chatInputStack.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from './chatSpeechToTextService.js';
import { readMicrophoneLevel } from './dictationOnboarding.js';
import './media/dictationListeningBar.css';

/** CreaEditor: the command that switches the spoken dictation language (its shortcut shows in the chip's hover). */
export const TOGGLE_DICTATION_LANGUAGE_COMMAND = 'workbench.action.chat.toggleDictationLanguage';

/** The name of a language code in the display language, such as `nl` → "Dutch". */
function getLanguageName(code: string): string {
	try {
		return new Intl.DisplayNames([displayLanguage], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** One stroke and the air beside it, the same rhythm as the dictation introduction's waveform. */
const BAR_WIDTH = 1;
const BAR_GAP = 2;

/** About 30 updates a second: smooth enough to follow a voice, light enough for a chat input. */
const PAINT_INTERVAL_MS = 33;

/** With reduced motion the meter steps instead of scrolling, at a readable pace. */
const REDUCED_MOTION_PAINT_INTERVAL_MS = 150;

/** Height of a stroke with nothing being said: a thin line, so the graph still reads as present. */
const SILENT_LEVEL = 0.08;

export interface IDictationListeningBarOptions {
	/** The slot (in the chat input stack) the bar renders into. */
	readonly container: HTMLElement;
	/** Whether the current dictation types into this bar's chat input. */
	readonly isDictatingHere: () => boolean;
	/** Fires when dictation moves to another input. */
	readonly onDidChangeDictationTarget: Event<unknown>;
}

/**
 * Shown only while dictation listens into this input: a level graph that scrolls with the microphone
 * (newest on the right), so the user sees at a glance that they are being heard, and a short label.
 * The graph only paints while the bar is visible. With reduced motion it is a static level meter.
 */
export class DictationListeningBar extends Disposable {

	private readonly graph: HTMLElement;
	private readonly meterFill: HTMLElement;
	private readonly label: HTMLElement;
	private readonly languageChip: HTMLButtonElement;
	private readonly animationFrame = this._register(new MutableDisposable<IDisposable>());

	private bars: HTMLElement[] = [];
	private levels: number[] = [];
	private analyser: AnalyserNode | undefined;
	private waveform: Uint8Array<ArrayBuffer> | undefined;
	private visible = false;
	private lastPaint = 0;

	constructor(
		private readonly options: IDictationListeningBarOptions,
		observerCtor: typeof ResizeObserver | undefined,
		@IChatSpeechToTextService private readonly speechToTextService: IChatSpeechToTextService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IHoverService hoverService: IHoverService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();

		const container = options.container;
		const root = dom.append(container, dom.$('.chat-input-notice.dictation-listening-bar'));
		this.graph = dom.append(root, dom.$('.dictation-listening-graph'));
		this.graph.setAttribute('aria-hidden', 'true');
		const meter = dom.append(root, dom.$('.dictation-listening-meter'));
		meter.setAttribute('aria-hidden', 'true');
		this.meterFill = dom.append(meter, dom.$('.dictation-listening-meter-fill'));
		this.label = dom.append(root, dom.$('span.dictation-listening-label'));
		this.label.setAttribute('role', 'status');
		this.label.setAttribute('aria-live', 'polite');
		this.languageChip = dom.append(root, dom.$<HTMLButtonElement>('button.dictation-listening-language'));
		this.languageChip.type = 'button';
		// Keep the focus (and the caret) in the input the user is dictating into.
		this._register(dom.addDisposableListener(this.languageChip, dom.EventType.MOUSE_DOWN, e => e.preventDefault()));
		this._register(dom.addDisposableListener(this.languageChip, dom.EventType.CLICK, () => this.speechToTextService.toggleSpokenLanguage()));
		this._register(hoverService.setupManagedHover(getDefaultHoverDelegate('element'), this.languageChip, () => this.getLanguageTooltip()));
		this._register(toDisposable(() => {
			setChatInputStackSlot(container, ChatInputStackSlot.Empty);
			root.remove();
		}));

		// The stroke count follows the width, so the rhythm holds as the panel resizes.
		const observer = new (observerCtor ?? dom.getWindow(container).ResizeObserver)(() => this.layoutGraph());
		observer.observe(this.graph);
		this._register(toDisposable(() => observer.disconnect()));

		this._register(Event.any(
			this.speechToTextService.onDidChangeState,
			this.speechToTextService.onDidChangePreparingModel,
			this.speechToTextService.onDidChangeTranscribingSegment,
			this.speechToTextService.onDidChangeSpokenLanguage,
			this.options.onDidChangeDictationTarget,
		)(() => this.update()));
		this._register(this.accessibilityService.onDidChangeReducedMotion(() => this.update()));
		this._register(toDisposable(() => this.stop()));
		this.update();
	}

	private update(): void {
		const service = this.speechToTextService;
		const visible = service.state === ChatSpeechToTextState.Recording && !service.isPreparingModel && this.options.isDictatingHere();
		if (visible !== this.visible) {
			this.visible = visible;
			setChatInputStackSlot(this.options.container, visible ? ChatInputStackSlot.Docked : ChatInputStackSlot.Empty);
		}
		if (!visible) {
			this.stop();
			this.label.textContent = '';
			return;
		}
		const reducedMotion = this.accessibilityService.isMotionReduced();
		this.options.container.classList.toggle('reduced-motion', reducedMotion);
		this.label.textContent = service.isTranscribingSegment
			? localize('dictation.listeningBar.transcribing', "Transcribing…")
			: localize('dictation.listeningBar.listening', "Listening…");
		const spokenLanguage = service.spokenLanguage;
		this.languageChip.hidden = !spokenLanguage;
		if (spokenLanguage) {
			this.languageChip.textContent = spokenLanguage.toUpperCase();
			this.languageChip.setAttribute('aria-label', localize('dictation.listeningBar.languageAria', "Spoken language: {0}. Switch Language", getLanguageName(spokenLanguage)));
		}
		this.layoutGraph();
		this.start();
	}

	private getLanguageTooltip(): string {
		const name = getLanguageName(this.speechToTextService.spokenLanguage ?? 'en');
		const keybinding = this.keybindingService.lookupKeybinding(TOGGLE_DICTATION_LANGUAGE_COMMAND)?.getLabel();
		return keybinding
			? localize('dictation.listeningBar.languageTooltipKey', "Spoken language: {0}. Click or press {1} to switch; it applies from the next sentence.", name, keybinding)
			: localize('dictation.listeningBar.languageTooltip', "Spoken language: {0}. Click to switch; it applies from the next sentence.", name);
	}

	/** Rebuild the strokes for the current width, keeping the most recent levels. */
	private layoutGraph(): void {
		const width = this.graph.clientWidth;
		if (!width) {
			return;
		}
		const count = Math.max(1, Math.floor((width + BAR_GAP) / (BAR_WIDTH + BAR_GAP)));
		if (count === this.bars.length) {
			return;
		}
		dom.clearNode(this.graph);
		this.bars = [];
		for (let i = 0; i < count; i++) {
			this.bars.push(dom.append(this.graph, dom.$('span.dictation-listening-stroke')));
		}
		this.levels = this.levels.slice(-count);
		while (this.levels.length < count) {
			this.levels.unshift(0);
		}
	}

	private start(): void {
		if (this.animationFrame.value) {
			return;
		}
		const targetWindow = dom.getWindow(this.graph);
		const tick = () => {
			if (!this.visible) {
				this.animationFrame.clear();
				return;
			}
			this.paint(targetWindow.performance.now());
			this.animationFrame.value = dom.scheduleAtNextAnimationFrame(targetWindow, tick);
		};
		this.animationFrame.value = dom.scheduleAtNextAnimationFrame(targetWindow, tick);
	}

	private stop(): void {
		this.animationFrame.clear();
		this.levels = this.levels.map(() => 0);
		this.analyser = undefined;
		this.waveform = undefined;
	}

	private readLevel(): number {
		const analyser = this.speechToTextService.analyserNode;
		if (analyser !== this.analyser) {
			// A switched microphone comes with its own analyser.
			this.analyser = analyser;
			this.waveform = analyser ? new Uint8Array(analyser.fftSize) : undefined;
		}
		return readMicrophoneLevel(this.analyser, this.waveform);
	}

	private paint(timestamp: number): void {
		const reducedMotion = this.accessibilityService.isMotionReduced();
		if (timestamp - this.lastPaint < (reducedMotion ? REDUCED_MOTION_PAINT_INTERVAL_MS : PAINT_INTERVAL_MS)) {
			return;
		}
		this.lastPaint = timestamp;
		const level = this.readLevel();
		if (reducedMotion) {
			// A static meter: one fill that follows the level, no scrolling history.
			this.meterFill.style.transform = `scaleX(${Math.max(0.02, level).toFixed(3)})`;
			return;
		}
		// Scroll: the newest level enters on the right.
		this.levels.push(level);
		this.levels.shift();
		for (let i = 0; i < this.bars.length; i++) {
			const amount = Math.max(SILENT_LEVEL, Math.min(1, this.levels[i] ?? 0));
			// Transform only, so the strokes never reflow the input beneath them.
			this.bars[i].style.transform = `scaleY(${amount.toFixed(3)})`;
		}
	}
}
