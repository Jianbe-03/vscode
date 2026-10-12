/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { cleanWhisperSegmentText, ISpeechSegment, SpeechSegmenter } from '../../common/speechSegmenter.js';

const SAMPLE_RATE = 16000;

/** `ms` of a 220 Hz tone (speech) at `amplitude` (0..1), or a faint hiss when `amplitude` is 0. */
function audio(ms: number, amplitude: number): Int16Array {
	const samples = new Int16Array(Math.round(SAMPLE_RATE * ms / 1000));
	for (let i = 0; i < samples.length; i++) {
		samples[i] = amplitude
			? Math.round(Math.sin(2 * Math.PI * 220 * i / SAMPLE_RATE) * amplitude * 0x7FFF)
			: Math.round(Math.sin(i * 12.9898) * 40);
	}
	return samples;
}

/** Push `parts` in capture-sized chunks (the renderer posts 4096 samples at a time). */
function feed(segmenter: SpeechSegmenter, ...parts: Int16Array[]): ISpeechSegment[] {
	const all = new Int16Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		all.set(part, offset);
		offset += part.length;
	}
	const segments: ISpeechSegment[] = [];
	for (let i = 0; i < all.length; i += 4096) {
		segments.push(...segmenter.push(all.subarray(i, i + 4096)));
	}
	return segments;
}

function describe(segments: readonly (ISpeechSegment | undefined)[]): { ms: number; speechMs: number }[] {
	return segments.filter((segment): segment is ISpeechSegment => !!segment).map(segment => ({ ms: Math.round(segment.samples.length / SAMPLE_RATE * 1000), speechMs: segment.speechMs }));
}

suite('SpeechSegmenter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ends a segment at a pause, with a short pre-roll and the silence that ended it', () => {
		const segmenter = new SpeechSegmenter({ sampleRate: SAMPLE_RATE });
		const segments = feed(segmenter, audio(1020, 0), audio(990, 0.3), audio(510, 0), audio(990, 0.3), audio(1500, 0));
		assert.deepStrictEqual({ segments: describe(segments), flushed: describe([segmenter.flush()]) }, {
			// 300 ms pre-roll, both utterances (the 510 ms pause is too short to cut) and the 600 ms of silence that ended it.
			segments: [{ ms: 3390, speechMs: 1980 }],
			flushed: [],
		});
	});

	test('cuts a long utterance at its quietest recent moment, before the maximum length', () => {
		const segmenter = new SpeechSegmenter({ sampleRate: SAMPLE_RATE, maxSegmentMs: 10_000 });
		// 7.5 s of speech, a short breath, then 6 s more: together past the 10 s maximum.
		const segments = feed(segmenter, audio(7500, 0.3), audio(240, 0.005), audio(6000, 0.3));
		assert.deepStrictEqual({ segments: describe(segments), flushed: describe([segmenter.flush()]) }, {
			// Cut inside the breath, well before the 10 s maximum; the rest starts the next segment.
			segments: [{ ms: 7680, speechMs: 7500 }],
			flushed: [{ ms: 6060, speechMs: 6000 }],
		});
	});

	test('flushes what was said last when dictation stops, and nothing for silence or a click', () => {
		const speaking = new SpeechSegmenter({ sampleRate: SAMPLE_RATE });
		const speakingSegments = feed(speaking, audio(600, 0), audio(1200, 0.3));
		const silent = new SpeechSegmenter({ sampleRate: SAMPLE_RATE });
		feed(silent, audio(3000, 0));
		const click = new SpeechSegmenter({ sampleRate: SAMPLE_RATE });
		const clickSegments = feed(click, audio(600, 0), audio(60, 0.5), audio(1200, 0));
		assert.deepStrictEqual({
			speaking: describe([...speakingSegments, speaking.flush()]),
			afterFlush: describe([speaking.flush()]),
			silent: describe([silent.flush()]),
			click: describe([...clickSegments, click.flush()]),
		}, {
			speaking: [{ ms: 1500, speechMs: 1200 }],
			afterFlush: [],
			silent: [],
			click: [],
		});
	});

	test('drops what Whisper writes for silence and collapses decoding loops', () => {
		assert.deepStrictEqual([
			' ***',
			' . . . . .',
			' you',
			' Thanks for watching!',
			' Ondertiteling door de Amara.org gemeenschap',
			' Hallo, dit is een test van parseConfigFile.',
			' Thank you.',
			' ja ja ja ja ja ja ja ja',
		].map(cleanWhisperSegmentText), [
			'',
			'',
			'',
			'',
			'',
			'Hallo, dit is een test van parseConfigFile.',
			'Thank you.',
			'ja',
		]);
	});
});
