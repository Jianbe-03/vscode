/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileSecretStore, SecretDecryptionError, readOrCreateMasterKey } from '../../../node/shared/fileSecretStore.js';

suite('FileSecretStore', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;

	setup(() => {
		dir = fs.mkdtempSync(join(tmpdir(), 'creaeditor-secrets-'));
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('keeps values encrypted on disk and reads them back after a reopen', async () => {
		const store = new FileSecretStore(dir);
		await store.set('claude-token:a', 'fake-token-123');
		await store.set('gateway-key:openrouter', 'fake-key-456');
		await store.delete('gateway-key:openrouter');

		const onDisk = fs.readFileSync(join(dir, 'secrets.json'), 'utf8');
		const reopened = new FileSecretStore(dir);
		assert.deepStrictEqual({
			leaked: onDisk.includes('fake-token-123'),
			keys: reopened.keys(),
			claudeKeys: reopened.keys('claude-token:'),
			value: reopened.get('claude-token:a'),
			missing: reopened.get('nope'),
		}, {
			leaked: false,
			keys: ['claude-token:a'],
			claudeKeys: ['claude-token:a'],
			value: 'fake-token-123',
			missing: undefined,
		});
	});

	test('a different master key cannot read the values', async () => {
		await new FileSecretStore(dir).set('claude-token:a', 'fake-token');
		const wrong = new FileSecretStore(dir, Buffer.alloc(32, 7));
		assert.throws(() => wrong.get('claude-token:a'), SecretDecryptionError);
	});

	test('a value moved to another name does not decrypt', async () => {
		await new FileSecretStore(dir).set('claude-token:a', 'fake-token');
		const file = join(dir, 'secrets.json');
		const content = JSON.parse(fs.readFileSync(file, 'utf8'));
		content.entries['claude-token:b'] = content.entries['claude-token:a'];
		fs.writeFileSync(file, JSON.stringify(content));
		assert.throws(() => new FileSecretStore(dir).get('claude-token:b'), SecretDecryptionError);
	});

	test('creates the master key once, readable by the owner only', async () => {
		const first = readOrCreateMasterKey(dir);
		const second = readOrCreateMasterKey(dir);
		await new FileSecretStore(dir).set('x', 'y');
		const modes = isWindows ? undefined : {
			folder: fs.statSync(dir).mode & 0o777,
			key: fs.statSync(join(dir, 'master.key')).mode & 0o777,
			secrets: fs.statSync(join(dir, 'secrets.json')).mode & 0o777,
		};
		assert.deepStrictEqual({ length: first.length, same: first.equals(second), modes }, {
			length: 32,
			same: true,
			modes: isWindows ? undefined : { folder: 0o700, key: 0o600, secrets: 0o600 },
		});
	});
});
