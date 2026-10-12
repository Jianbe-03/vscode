/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: live dictation with a non-streaming model (Whisper) cuts the microphone audio into
// utterances at pauses and transcribes each utterance as a whole.

/** A finished utterance: PCM16 mono samples, ready to be transcribed. */
export interface ISpeechSegment {
	readonly samples: Int16Array;
	/** How much of the segment was speech (above the speech threshold), in milliseconds. */
	readonly speechMs: number;
}

export interface ISpeechSegmenterOptions {
	readonly sampleRate: number;
	/** Analysis frame length. */
	readonly frameMs?: number;
	/** Silence after speech that ends the segment. */
	readonly endSilenceMs?: number;
	/** Longest segment; a longer utterance is cut at its quietest recent frame. */
	readonly maxSegmentMs?: number;
	/** Audio kept from before speech starts, so the first syllable is not clipped. */
	readonly preRollMs?: number;
	/** Segments with less speech than this are dropped (clicks, a cough, the mic switching on). */
	readonly minSpeechMs?: number;
	/** Lowest RMS (0..1) that can count as speech, however quiet the room is. */
	readonly minSpeechLevel?: number;
}

const DEFAULT_FRAME_MS = 30;
/**
 * Short enough that sentences usually become their own segment: Whisper drops a whole sentence in
 * another language when a segment switches language between sentences (it keeps English words inside
 * a Dutch sentence, though).
 */
const DEFAULT_END_SILENCE_MS = 600;
const DEFAULT_MAX_SEGMENT_MS = 24_000;
const DEFAULT_PRE_ROLL_MS = 300;
const DEFAULT_MIN_SPEECH_MS = 200;
const DEFAULT_MIN_SPEECH_LEVEL = 0.012;

/** Speech is this many times louder than the room's noise floor. */
const NOISE_FLOOR_FACTOR = 3;

/** How quickly the noise floor follows the room while nobody is speaking. */
const NOISE_FLOOR_ADAPTATION = 0.05;

/** How far back a too-long segment looks for a quiet frame to cut at. */
const MAX_SEGMENT_CUT_SEARCH_MS = 4000;

/** RMS of one frame, normalized to 0..1. */
function frameLevel(frame: Int16Array): number {
	if (!frame.length) {
		return 0;
	}
	let sum = 0;
	for (const sample of frame) {
		const value = sample / 0x8000;
		sum += value * value;
	}
	return Math.sqrt(sum / frame.length);
}

function concatFrames(frames: readonly Int16Array[]): Int16Array {
	let length = 0;
	for (const frame of frames) {
		length += frame.length;
	}
	const samples = new Int16Array(length);
	let offset = 0;
	for (const frame of frames) {
		samples.set(frame, offset);
		offset += frame.length;
	}
	return samples;
}

/**
 * Energy-based end-of-speech detection: cuts captured audio into utterances at pauses. The noise floor
 * adapts to the room while nobody speaks; a frame counts as speech when it is clearly louder than that
 * floor. A segment ends after {@link ISpeechSegmenterOptions.endSilenceMs} of silence, or at
 * {@link ISpeechSegmenterOptions.maxSegmentMs}, cut at the quietest frame of its last seconds so a word
 * is rarely split. {@link flush} hands out whatever was said last, when dictation stops.
 */
export class SpeechSegmenter {

	private readonly _frameSamples: number;
	private readonly _endSilenceFrames: number;
	private readonly _maxSegmentFrames: number;
	private readonly _preRollFrames: number;
	private readonly _minSpeechFrames: number;
	private readonly _cutSearchFrames: number;
	private readonly _frameMs: number;
	private readonly _minSpeechLevel: number;

	/** Samples that do not fill a frame yet. */
	private _remainder = new Int16Array(0);
	/** Frames before speech starts (at most the pre-roll). */
	private _preRoll: Int16Array[] = [];
	/** Frames of the segment being spoken, with their levels. */
	private _frames: Int16Array[] = [];
	private _levels: number[] = [];
	private _trailingSilenceFrames = 0;
	private _noiseFloor: number | undefined;

	constructor(options: ISpeechSegmenterOptions) {
		this._frameMs = options.frameMs ?? DEFAULT_FRAME_MS;
		this._frameSamples = Math.max(1, Math.round(options.sampleRate * this._frameMs / 1000));
		const frames = (ms: number) => Math.max(1, Math.round(ms / this._frameMs));
		this._endSilenceFrames = frames(options.endSilenceMs ?? DEFAULT_END_SILENCE_MS);
		this._maxSegmentFrames = frames(options.maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS);
		this._preRollFrames = frames(options.preRollMs ?? DEFAULT_PRE_ROLL_MS);
		this._minSpeechFrames = frames(options.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS);
		this._cutSearchFrames = Math.min(this._maxSegmentFrames - 1, frames(MAX_SEGMENT_CUT_SEARCH_MS));
		this._minSpeechLevel = options.minSpeechLevel ?? DEFAULT_MIN_SPEECH_LEVEL;
	}

	/** Feed captured samples; returns the segments they completed (usually none). */
	push(samples: Int16Array): ISpeechSegment[] {
		const segments: ISpeechSegment[] = [];
		let input = samples;
		if (this._remainder.length) {
			input = concatFrames([this._remainder, samples]);
		}
		let offset = 0;
		while (input.length - offset >= this._frameSamples) {
			const frame = input.slice(offset, offset + this._frameSamples);
			offset += this._frameSamples;
			const segment = this._pushFrame(frame);
			if (segment) {
				segments.push(segment);
			}
		}
		this._remainder = input.slice(offset);
		return segments;
	}

	/** End of dictation: the segment still being spoken (if it had enough speech). */
	flush(): ISpeechSegment | undefined {
		if (this._remainder.length && this._frames.length) {
			this._frames.push(this._remainder);
			this._levels.push(frameLevel(this._remainder));
		}
		this._remainder = new Int16Array(0);
		const segment = this._takeSegment(this._frames.length);
		this._reset();
		return segment;
	}

	private _pushFrame(frame: Int16Array): ISpeechSegment | undefined {
		const level = frameLevel(frame);
		const isSpeech = level >= this._threshold();

		if (!this._frames.length) {
			if (!isSpeech) {
				// Nobody speaking: follow the room's noise floor and keep a short pre-roll.
				this._noiseFloor = this._noiseFloor === undefined ? level : this._noiseFloor + (level - this._noiseFloor) * NOISE_FLOOR_ADAPTATION;
				this._preRoll.push(frame);
				if (this._preRoll.length > this._preRollFrames) {
					this._preRoll.shift();
				}
				return undefined;
			}
			// Speech starts: the segment begins with the pre-roll.
			for (const preRollFrame of this._preRoll) {
				this._frames.push(preRollFrame);
				this._levels.push(0);
			}
			this._preRoll = [];
		}

		this._frames.push(frame);
		this._levels.push(level);
		if (isSpeech) {
			this._trailingSilenceFrames = 0;
		} else {
			this._trailingSilenceFrames++;
		}

		if (this._trailingSilenceFrames >= this._endSilenceFrames) {
			const segment = this._takeSegment(this._frames.length);
			this._reset();
			return segment;
		}
		if (this._frames.length >= this._maxSegmentFrames) {
			return this._cutLongSegment();
		}
		return undefined;
	}

	/** Cut a segment that reached the maximum length at its quietest recent frame; the rest carries on. */
	private _cutLongSegment(): ISpeechSegment | undefined {
		let cut = this._frames.length;
		let quietest = Number.POSITIVE_INFINITY;
		for (let i = this._frames.length - 1; i >= this._frames.length - this._cutSearchFrames; i--) {
			if (this._levels[i] < quietest) {
				quietest = this._levels[i];
				cut = i + 1;
			}
		}
		const restFrames = this._frames.slice(cut);
		const restLevels = this._levels.slice(cut);
		const segment = this._takeSegment(cut);
		this._reset();
		this._frames = restFrames;
		this._levels = restLevels;
		const threshold = this._threshold();
		let trailing = 0;
		for (let i = restLevels.length - 1; i >= 0 && restLevels[i] < threshold; i--) {
			trailing++;
		}
		this._trailingSilenceFrames = trailing;
		return segment;
	}

	/** The first `frameCount` frames as a segment, or `undefined` when they hold too little speech. */
	private _takeSegment(frameCount: number): ISpeechSegment | undefined {
		const frames = this._frames.slice(0, frameCount);
		const threshold = this._threshold();
		const speechFrames = this._levels.slice(0, frameCount).filter(level => level >= threshold).length;
		if (!frames.length || speechFrames < this._minSpeechFrames) {
			return undefined;
		}
		return { samples: concatFrames(frames), speechMs: speechFrames * this._frameMs };
	}

	private _reset(): void {
		this._frames = [];
		this._levels = [];
		this._trailingSilenceFrames = 0;
	}

	/** Level a frame needs to count as speech, relative to the room's noise floor. */
	private _threshold(): number {
		return Math.max(this._minSpeechLevel, (this._noiseFloor ?? 0) * NOISE_FLOOR_FACTOR);
	}
}

/**
 * Whisper writes something for every bit of audio, also for silence or noise: dots, asterisks, or a
 * stock phrase from its training subtitles. Drops those, so a pause never types "you" or
 * "Ondertiteling door ..." into the input, and collapses a word repeated over and over (a decoding loop).
 */
export function cleanWhisperSegmentText(text: string): string {
	let cleaned = text.replace(/\s+/g, ' ').trim();
	if (!/[\p{L}\p{N}]/u.test(cleaned)) {
		return '';
	}
	// A token repeated more than four times in a row is a loop, not speech.
	cleaned = cleaned.replace(/(?<token>\b[\p{L}\p{N}']+\b[,.!?]?)(?:\s+\k<token>){4,}/gu, '$<token>');
	const normalized = cleaned.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
	if (WHISPER_SILENCE_PHRASES.has(normalized) || /^(?:ondertitel(?:ing|d)|subtitles by|ondertiteling door)\b/.test(normalized) || /\bamara\s*org\b/.test(normalized)) {
		return '';
	}
	return cleaned;
}

/** What Whisper says when nobody does (lowercase, without punctuation). */
const WHISPER_SILENCE_PHRASES = new Set([
	'you',
	'thanks for watching',
	'thank you for watching',
	'bedankt voor het kijken',
]);
