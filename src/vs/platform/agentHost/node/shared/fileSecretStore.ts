/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: a secret store in files for an agent host without an OS keychain, such as the CreaEditor
// Server in Docker. Every value is encrypted with AES-256-GCM under a key derived (HKDF-SHA256) from a
// random master key in `master.key`; the entry's name is bound to its ciphertext as additional data, so
// a value cannot be moved to another name. The folder is 0700 and both files are 0600.
//
// Names are namespaced by convention, for example `claude-token:<accountId>` (a Claude setup-token
// account, see `claudeSubscriptionAccounts.ts`) or `gateway-key:<providerId>` (an OpenRouter/LiteLLM key).
//
// The agent host process finds the store through `AGENT_HOST_SECRETS_DIR_ENV_VAR`, which the CreaEditor
// Server sets for the agent host it starts; without it there is no store (the desktop keeps its
// credentials in the workbench's secret storage).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';
import * as fs from 'fs';
import { join } from '../../../../base/common/path.js';

/** The folder of the agent host's file secret store; set by the CreaEditor Server. */
export const AGENT_HOST_SECRETS_DIR_ENV_VAR = 'CREAEDITOR_AGENT_HOST_SECRETS_DIR';

const MASTER_KEY_FILE = 'master.key';
const SECRETS_FILE = 'secrets.json';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const HKDF_SALT = 'creaeditor-server-secrets';
const HKDF_INFO = 'aes-256-gcm v1';

interface IEncryptedEntry {
	readonly iv: string;
	readonly tag: string;
	readonly data: string;
}

interface ISecretsFile {
	readonly version: 1;
	readonly entries: { readonly [name: string]: IEncryptedEntry };
}

/** Thrown when a value cannot be decrypted, for example because `master.key` was replaced. */
export class SecretDecryptionError extends Error {
	constructor(name: string) {
		super(`The secret '${name}' cannot be decrypted with this master key.`);
		this.name = 'SecretDecryptionError';
	}
}

/** Reads or creates the 32-byte master key in `dir` (0600). */
export function readOrCreateMasterKey(dir: string): Buffer {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, MASTER_KEY_FILE);
	try {
		const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
		if (key.length !== KEY_LENGTH) {
			throw new Error(`${file} does not hold a ${KEY_LENGTH}-byte key.`);
		}
		return key;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	const key = randomBytes(KEY_LENGTH);
	// `wx`: never replace a key another process just wrote.
	try {
		fs.writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return readOrCreateMasterKey(dir);
		}
		throw error;
	}
	return key;
}

/**
 * Encrypted name/value secrets kept in a folder. Reads are synchronous (the file is read once); writes
 * are queued and replace the file atomically.
 */
export class FileSecretStore {

	private readonly _key: Buffer;
	private _entries: Map<string, IEncryptedEntry>;
	private _write: Promise<void> = Promise.resolve();

	/**
	 * Opens the store in `dir`, creating the folder and the master key on first use. `masterKey`
	 * replaces the key file, for tests.
	 */
	constructor(private readonly _dir: string, masterKey?: Buffer) {
		fs.mkdirSync(_dir, { recursive: true, mode: 0o700 });
		const master = masterKey ?? readOrCreateMasterKey(_dir);
		this._key = Buffer.from(hkdfSync('sha256', master, HKDF_SALT, HKDF_INFO, KEY_LENGTH));
		this._entries = this._read();
	}

	/** The names of the stored secrets, optionally only those starting with `prefix`. */
	keys(prefix = ''): string[] {
		return [...this._entries.keys()].filter(name => name.startsWith(prefix));
	}

	has(name: string): boolean {
		return this._entries.has(name);
	}

	/** The secret named `name`; throws {@link SecretDecryptionError} when it cannot be decrypted. */
	get(name: string): string | undefined {
		const entry = this._entries.get(name);
		if (!entry) {
			return undefined;
		}
		try {
			const decipher = createDecipheriv('aes-256-gcm', this._key, Buffer.from(entry.iv, 'base64'));
			decipher.setAAD(Buffer.from(name, 'utf8'));
			decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
			return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
		} catch {
			throw new SecretDecryptionError(name);
		}
	}

	set(name: string, value: string): Promise<void> {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv('aes-256-gcm', this._key, iv);
		cipher.setAAD(Buffer.from(name, 'utf8'));
		const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
		this._entries.set(name, { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
		return this._persist();
	}

	delete(name: string): Promise<void> {
		if (!this._entries.delete(name)) {
			return this._write;
		}
		return this._persist();
	}

	/** Resolves once every write so far is on disk. */
	flush(): Promise<void> {
		return this._write;
	}

	private _read(): Map<string, IEncryptedEntry> {
		let content: string;
		try {
			content = fs.readFileSync(join(this._dir, SECRETS_FILE), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return new Map();
			}
			throw error;
		}
		const parsed = JSON.parse(content) as Partial<ISecretsFile>;
		const entries = new Map<string, IEncryptedEntry>();
		for (const [name, entry] of Object.entries(parsed.entries ?? {})) {
			if (entry && typeof entry.iv === 'string' && typeof entry.tag === 'string' && typeof entry.data === 'string') {
				entries.set(name, entry);
			}
		}
		return entries;
	}

	private _persist(): Promise<void> {
		const file: ISecretsFile = { version: 1, entries: Object.fromEntries(this._entries) };
		const content = `${JSON.stringify(file, undefined, '\t')}\n`;
		const target = join(this._dir, SECRETS_FILE);
		const temp = `${target}.${process.pid}.tmp`;
		this._write = this._write.catch(() => undefined).then(async () => {
			await fs.promises.writeFile(temp, content, { mode: 0o600 });
			await fs.promises.rename(temp, target);
		});
		return this._write;
	}
}

let agentHostSecretStore: FileSecretStore | null | undefined;

/**
 * The agent host's file secret store when {@link AGENT_HOST_SECRETS_DIR_ENV_VAR} names one (the
 * CreaEditor Server), else undefined.
 */
export function getAgentHostSecretStore(): FileSecretStore | undefined {
	if (agentHostSecretStore === undefined) {
		const dir = process.env[AGENT_HOST_SECRETS_DIR_ENV_VAR];
		agentHostSecretStore = dir ? new FileSecretStore(dir) : null;
	}
	return agentHostSecretStore ?? undefined;
}

/** The store name of the setup-token of the Claude `token` account `accountId`. */
export function claudeTokenSecretName(accountId: string): string {
	return `claude-token:${accountId}`;
}
