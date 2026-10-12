/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../base/test/node/testUtils.js';
import { hasCachedModelFiles, parseAppleLanguages, selectCachedModelVariant, toWhisperLanguage } from '../../node/localTranscriptionService.js';

suite('LocalTranscriptionService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('selects a persisted model variant when catalog metadata selected an uncached variant', () => {
		const uncached = { id: 'model-cpu:2', isCached: false };
		const cached = { id: 'model-cpu:1', isCached: true };
		let selected = uncached;
		const model = {
			get isCached() { return selected.isCached; },
			variants: [uncached, cached],
			selectVariant: (variant: typeof uncached) => selected = variant,
		};

		selectCachedModelVariant(model);

		assert.strictEqual(selected.id, cached.id);
	});

	test('preserves the selected model variant when it is already cached', () => {
		const selected = { id: 'model-cpu:2', isCached: true };
		let selectionCount = 0;
		const model = {
			isCached: true,
			variants: [selected, { id: 'model-cpu:1', isCached: true }],
			selectVariant: () => selectionCount++,
		};

		selectCachedModelVariant(model);

		assert.strictEqual(selectionCount, 0);
	});

	test('finds an installed model in the cache by its alias, without the catalog', async () => {
		const cache = getRandomTestPath(tmpdir(), 'vsctests', 'dictation-cache');
		fs.mkdirSync(join(cache, 'Microsoft', 'openai-whisper-large-v3-turbo-generic-cpu-4', 'v4'), { recursive: true });
		fs.mkdirSync(join(cache, 'Microsoft', 'openai-whisper-small-generic-cpu-4'), { recursive: true });
		fs.writeFileSync(join(cache, 'foundry.modelinfo.json'), '{}');
		try {
			assert.deepStrictEqual({
				whisper: await hasCachedModelFiles(cache, 'whisper-large-v3-turbo'),
				emptyVariant: await hasCachedModelFiles(cache, 'whisper-small'),
				missing: await hasCachedModelFiles(cache, 'nemotron-3.5-asr-streaming-0.6b'),
				noCache: await hasCachedModelFiles(join(cache, 'missing'), 'whisper-large-v3-turbo'),
			}, { whisper: true, emptyVariant: false, missing: false, noCache: false });
		} finally {
			fs.rmSync(cache, { recursive: true, force: true });
		}
	});

	test('passes Whisper a bare language code, and no hint for automatic', () => {
		assert.deepStrictEqual(['nl-NL', 'en', 'pt_BR', 'auto', '', undefined, 'not a language'].map(toWhisperLanguage), ['nl', 'en', 'pt', undefined, undefined, undefined, undefined]);
	});

	test('reads the macOS preferred languages list', () => {
		assert.deepStrictEqual(parseAppleLanguages('(\n    "en-US",\n    "nl-NL",\n    fr\n)\n'), ['en-US', 'nl-NL', 'fr']);
	});
});
