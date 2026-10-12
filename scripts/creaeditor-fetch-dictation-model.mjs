/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: downloads the on-device dictation model once into a model cache folder (default
// `.build/dictation-model`), so `creaeditor-build-macos.sh` can bundle it and dictation never
// downloads it at runtime (see `seedBundledDictationModel` in `localTranscriptionService.ts`).
// Usage: node scripts/creaeditor-fetch-dictation-model.mjs [cacheDir]

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cacheDir = path.resolve(root, process.argv[2] ?? '.build/dictation-model');

// The same model dictation uses (DEFAULT_LOCAL_TRANSCRIPTION_MODEL).
const source = fs.readFileSync(path.join(root, 'src/vs/platform/localTranscription/common/localTranscription.ts'), 'utf8');
const modelId = /DEFAULT_LOCAL_TRANSCRIPTION_MODEL\s*=\s*'(?<id>[^']+)'/.exec(source)?.groups?.id;
if (!modelId) {
	console.error('Could not find DEFAULT_LOCAL_TRANSCRIPTION_MODEL.');
	process.exit(1);
}

fs.mkdirSync(cacheDir, { recursive: true });
const { FoundryLocalManager } = await import('foundry-local-sdk');
const manager = await FoundryLocalManager.createAsync({ appName: 'creaeditor-build', modelCacheDir: cacheDir, logLevel: 'warn' });
const model = await manager.catalog.getModel(modelId);
// Dictation picks the cached CPU variant (`selectCachedModelVariant`); fetch that one.
const cpuVariant = (model.variants ?? []).find(variant => /generic-cpu/.test(variant.id));
if (cpuVariant && typeof model.selectVariant === 'function') {
	model.selectVariant(cpuVariant);
}
if (model.isCached) {
	console.log(`${modelId} is already in ${cacheDir}`);
} else {
	console.log(`Downloading ${modelId} into ${cacheDir}...`);
	let last = -10;
	await model.download(percent => {
		if (percent - last >= 10) {
			last = percent;
			console.log(`  ${Math.round(percent)}%`);
		}
	});
}
process.exit(0);
