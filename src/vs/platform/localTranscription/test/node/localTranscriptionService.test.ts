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
import { seedBundledDictationModel, selectCachedModelVariant } from '../../node/localTranscriptionService.js';

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

	test('seeds the bundled dictation model into the cache once, and keeps a model already there', async () => {
		const root = getRandomTestPath(tmpdir(), 'vsctests', 'dictation-seed');
		const bundled = join(root, 'dictation-model');
		const cache = join(root, 'cache');
		fs.mkdirSync(join(bundled, 'Microsoft', 'model-cpu-3', 'v3'), { recursive: true });
		fs.writeFileSync(join(bundled, 'Microsoft', 'model-cpu-3', 'v3', 'encoder.onnx'), 'bundled');
		fs.mkdirSync(join(cache, 'Microsoft', 'other-cpu-1', 'v1'), { recursive: true });
		fs.writeFileSync(join(cache, 'Microsoft', 'other-cpu-1', 'v1', 'encoder.onnx'), 'downloaded');
		fs.mkdirSync(join(bundled, 'Microsoft', 'other-cpu-1', 'v1'), { recursive: true });
		fs.writeFileSync(join(bundled, 'Microsoft', 'other-cpu-1', 'v1', 'encoder.onnx'), 'bundled');
		try {
			await seedBundledDictationModel(bundled, cache);
			await seedBundledDictationModel(join(root, 'missing'), cache);
			assert.deepStrictEqual({
				seeded: fs.readFileSync(join(cache, 'Microsoft', 'model-cpu-3', 'v3', 'encoder.onnx'), 'utf8'),
				kept: fs.readFileSync(join(cache, 'Microsoft', 'other-cpu-1', 'v1', 'encoder.onnx'), 'utf8'),
				entries: fs.readdirSync(join(cache, 'Microsoft')).sort(),
			}, { seeded: 'bundled', kept: 'downloaded', entries: ['model-cpu-3', 'other-cpu-1'] });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
