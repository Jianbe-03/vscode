/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: who may use Remote Access. Paired devices hold a random device key of which only a
// SHA-256 hash is stored; devices pair with a short-lived single-use pairing code (plus a password
// when the server is reachable from the internet). Failed attempts are rate limited per client and
// in total, with a lockout.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../log/common/log.js';

/** A device that paired with Remote Access. */
export interface IRemoteAccessDevice {
	readonly id: string;
	readonly name: string;
	/** Epoch milliseconds. */
	readonly createdAt: number;
	/** Epoch milliseconds of the last authenticated request or connection. */
	readonly lastSeenAt: number;
	/** Whether the device paired while public access was on (and so gave the password). */
	readonly pairedPublicly: boolean;
}

/** A one-time pairing code. */
export interface IRemoteAccessPairingCode {
	/** Display form, e.g. `K7QDM-2XP9H`. Matching ignores case, spaces and dashes. */
	readonly code: string;
	/** Epoch milliseconds. */
	readonly expiresAt: number;
}

/** Why pairing or a password check failed. */
export const enum RemoteAccessAuthFailure {
	InvalidCode = 'invalidCode',
	ExpiredCode = 'expiredCode',
	PasswordRequired = 'passwordRequired',
	WrongPassword = 'wrongPassword',
	/** Public access needs a password, but none is set. */
	NoPasswordSet = 'noPasswordSet',
	LockedOut = 'lockedOut',
}

/** A pairing request from a device. */
export interface IRemoteAccessPairRequest {
	readonly code: string;
	readonly deviceName: string;
	readonly password?: string;
	/** True when the server is publicly reachable: the password is then required. */
	readonly requirePassword: boolean;
	/** Identifies the client for rate limiting, e.g. its IP address. */
	readonly client: string;
}

export type RemoteAccessPairResult =
	| { readonly ok: true; readonly device: IRemoteAccessDevice; readonly deviceKey: string }
	| { readonly ok: false; readonly reason: RemoteAccessAuthFailure; readonly retryAfterMs?: number };

/**
 * Device keys, pairing codes, the optional password and rate limiting for Remote Access.
 * Used by {@link startRemoteAccessServer}; create one with {@link RemoteAccessAuth.create}.
 */
export interface IRemoteAccessAuth {
	/** Fires with the id of a device that was signed out. Live connections of that device must close. */
	readonly onDidRevokeDevice: Event<string>;
	/** Fires when devices were added, removed or renamed (not for last-seen updates). */
	readonly onDidChangeDevices: Event<void>;

	/** Creates a new pairing code; it replaces the previous one. */
	createPairingCode(): IRemoteAccessPairingCode;
	/** The current pairing code, if one is still valid. */
	getPairingCode(): IRemoteAccessPairingCode | undefined;
	/** Exchanges a pairing code (and password if required) for a new device key. */
	pair(request: IRemoteAccessPairRequest): Promise<RemoteAccessPairResult>;
	/** The device of a device key, or `undefined`. A wrong key counts as a failed attempt of `client`. */
	verifyDeviceKey(deviceKey: string | undefined, client: string): IRemoteAccessDevice | undefined;
	/** Milliseconds `client` must wait before trying again, or 0. */
	getLockout(client: string): number;
	listDevices(): readonly IRemoteAccessDevice[];
	/** Signs a device out: its key stops working and its connections are closed. */
	revokeDevice(id: string): Promise<boolean>;
	hasPassword(): boolean;
	/** Sets (at least {@link REMOTE_ACCESS_MIN_PASSWORD_LENGTH} characters) or removes the password. */
	setPassword(password: string | undefined): Promise<void>;
}

/** Options of {@link RemoteAccessAuth.create}; the defaults suit production. */
export interface IRemoteAccessAuthOptions {
	readonly now?: () => number;
	/** Defaults to 10 minutes. */
	readonly pairingCodeLifetimeMs?: number;
	/** Failed attempts of one client within {@link failureWindowMs} before it is locked out. Defaults to 5. */
	readonly maxFailuresPerClient?: number;
	/** Failed attempts of all clients together within {@link failureWindowMs} before everyone is locked out. Defaults to 30. */
	readonly maxFailuresTotal?: number;
	/** Defaults to 15 minutes. */
	readonly failureWindowMs?: number;
	/** Defaults to 15 minutes. */
	readonly lockoutMs?: number;
	/** scrypt cost parameter N. Defaults to 16384. */
	readonly scryptCost?: number;
}

export const REMOTE_ACCESS_MIN_PASSWORD_LENGTH = 8;
const STORE_FILE_NAME = 'remote-access-auth.json';
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 10;
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;
const ALL_CLIENTS = '*';

interface IStoredDevice extends IRemoteAccessDevice {
	/** Hex SHA-256 of the secret part of the device key. */
	readonly keyHash: string;
}

interface IStoredPassword {
	readonly salt: string;
	readonly hash: string;
	readonly cost: number;
	readonly blockSize: number;
	readonly parallelization: number;
}

interface IStoreContents {
	readonly version: 1;
	readonly devices: readonly IStoredDevice[];
	readonly password?: IStoredPassword;
}

interface IFailureRecord {
	failures: number[];
	lockedUntil: number;
}

export class RemoteAccessAuth extends Disposable implements IRemoteAccessAuth {

	/** Loads (or starts) the store `remote-access-auth.json` in `storageDir`. */
	static async create(storageDir: string, logService: ILogService, options: IRemoteAccessAuthOptions = {}): Promise<RemoteAccessAuth> {
		await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });
		const file = join(storageDir, STORE_FILE_NAME);
		let contents: IStoreContents = { version: 1, devices: [] };
		try {
			const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
			contents = sanitizeStore(parsed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logService.error('[RemoteAccess] Could not read the device store; starting without devices', error);
			}
		}
		return new RemoteAccessAuth(file, contents, logService, options);
	}

	private readonly _onDidRevokeDevice = this._register(new Emitter<string>());
	readonly onDidRevokeDevice = this._onDidRevokeDevice.event;
	private readonly _onDidChangeDevices = this._register(new Emitter<void>());
	readonly onDidChangeDevices = this._onDidChangeDevices.event;

	private readonly _devices = new Map<string, IStoredDevice>();
	private _password: IStoredPassword | undefined;
	private _pairingCode: { readonly display: string; readonly normalized: string; readonly expiresAt: number } | undefined;
	private readonly _failures = new Map<string, IFailureRecord>();
	private readonly _persistedLastSeen = new Map<string, number>();
	private readonly _revokedIds = new Set<string>();
	private _writeQueue: Promise<void> = Promise.resolve();

	private readonly _now: () => number;
	private readonly _pairingCodeLifetimeMs: number;
	private readonly _maxFailuresPerClient: number;
	private readonly _maxFailuresTotal: number;
	private readonly _failureWindowMs: number;
	private readonly _lockoutMs: number;
	private readonly _scryptCost: number;

	private constructor(
		private readonly _file: string,
		contents: IStoreContents,
		private readonly _logService: ILogService,
		options: IRemoteAccessAuthOptions,
	) {
		super();
		this._now = options.now ?? Date.now;
		this._pairingCodeLifetimeMs = options.pairingCodeLifetimeMs ?? 10 * 60_000;
		this._maxFailuresPerClient = options.maxFailuresPerClient ?? 5;
		this._maxFailuresTotal = options.maxFailuresTotal ?? 30;
		this._failureWindowMs = options.failureWindowMs ?? 15 * 60_000;
		this._lockoutMs = options.lockoutMs ?? 15 * 60_000;
		this._scryptCost = options.scryptCost ?? 16384;
		for (const device of contents.devices) {
			this._devices.set(device.id, device);
			this._persistedLastSeen.set(device.id, device.lastSeenAt);
		}
		this._password = contents.password;
	}

	createPairingCode(): IRemoteAccessPairingCode {
		const bytes = randomBytes(PAIRING_CODE_LENGTH);
		let normalized = '';
		for (const byte of bytes) {
			// 31 characters: the slight modulo bias does not matter for a short-lived, rate-limited code.
			normalized += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
		}
		const half = PAIRING_CODE_LENGTH / 2;
		const display = `${normalized.slice(0, half)}-${normalized.slice(half)}`;
		this._pairingCode = { display, normalized, expiresAt: this._now() + this._pairingCodeLifetimeMs };
		return { code: display, expiresAt: this._pairingCode.expiresAt };
	}

	getPairingCode(): IRemoteAccessPairingCode | undefined {
		const current = this._pairingCode;
		return current && current.expiresAt > this._now() ? { code: current.display, expiresAt: current.expiresAt } : undefined;
	}

	async pair(request: IRemoteAccessPairRequest): Promise<RemoteAccessPairResult> {
		const lockout = this.getLockout(request.client);
		if (lockout > 0) {
			return { ok: false, reason: RemoteAccessAuthFailure.LockedOut, retryAfterMs: lockout };
		}

		const current = this._pairingCode;
		if (!current || !safeEqual(normalizePairingCode(request.code), current.normalized)) {
			return this._fail(request.client, RemoteAccessAuthFailure.InvalidCode);
		}
		if (current.expiresAt <= this._now()) {
			this._pairingCode = undefined;
			return this._fail(request.client, RemoteAccessAuthFailure.ExpiredCode);
		}

		if (request.requirePassword) {
			if (!this._password) {
				return { ok: false, reason: RemoteAccessAuthFailure.NoPasswordSet };
			}
			if (!request.password) {
				return { ok: false, reason: RemoteAccessAuthFailure.PasswordRequired };
			}
			if (!await this._checkPassword(request.password)) {
				return this._fail(request.client, RemoteAccessAuthFailure.WrongPassword);
			}
		}

		// The code may have been used or replaced while the password was checked.
		if (this._pairingCode !== current) {
			return this._fail(request.client, RemoteAccessAuthFailure.InvalidCode);
		}
		this._pairingCode = undefined;
		this._failures.delete(request.client);

		const id = randomBytes(9).toString('base64url');
		const secret = randomBytes(32).toString('base64url');
		const now = this._now();
		const device: IStoredDevice = {
			id,
			name: sanitizeDeviceName(request.deviceName),
			createdAt: now,
			lastSeenAt: now,
			pairedPublicly: request.requirePassword,
			keyHash: hashSecret(secret),
		};
		this._devices.set(id, device);
		this._persistedLastSeen.set(id, now);
		await this._save();
		this._onDidChangeDevices.fire();
		this._logService.info(`[RemoteAccess] Paired device "${device.name}" (${id})`);
		return { ok: true, device: toPublicDevice(device), deviceKey: `${id}.${secret}` };
	}

	verifyDeviceKey(deviceKey: string | undefined, client: string): IRemoteAccessDevice | undefined {
		// Device keys are 256-bit random, so only the client's own failures count here: a guessing
		// client cannot lock every paired device out.
		if (this._getLockout(client, false) > 0) {
			return undefined;
		}
		const separator = deviceKey?.indexOf('.') ?? -1;
		const id = deviceKey && separator > 0 ? deviceKey.slice(0, separator) : undefined;
		const device = id ? this._devices.get(id) : undefined;
		if (!deviceKey || !device || !safeEqual(hashSecret(deviceKey.slice(separator + 1)), device.keyHash)) {
			// A signed-out device that keeps reconnecting is not an attack.
			if (!id || !this._revokedIds.has(id)) {
				this._fail(client, RemoteAccessAuthFailure.InvalidCode, false);
			}
			return undefined;
		}

		const now = this._now();
		const updated: IStoredDevice = { ...device, lastSeenAt: now };
		this._devices.set(device.id, updated);
		if (now - (this._persistedLastSeen.get(device.id) ?? 0) >= LAST_SEEN_PERSIST_INTERVAL_MS) {
			this._persistedLastSeen.set(device.id, now);
			void this._save();
		}
		return toPublicDevice(updated);
	}

	getLockout(client: string): number {
		return this._getLockout(client, true);
	}

	private _getLockout(client: string, includeAllClients: boolean): number {
		const now = this._now();
		let lockout = 0;
		for (const key of includeAllClients ? [client, ALL_CLIENTS] : [client]) {
			const record = this._failures.get(key);
			if (record && record.lockedUntil > now) {
				lockout = Math.max(lockout, record.lockedUntil - now);
			}
		}
		return lockout;
	}

	listDevices(): readonly IRemoteAccessDevice[] {
		return [...this._devices.values()].map(toPublicDevice).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
	}

	async revokeDevice(id: string): Promise<boolean> {
		const device = this._devices.get(id);
		if (!device) {
			return false;
		}
		this._devices.delete(id);
		this._persistedLastSeen.delete(id);
		this._revokedIds.add(id);
		await this._save();
		this._logService.info(`[RemoteAccess] Signed out device "${device.name}" (${id})`);
		this._onDidRevokeDevice.fire(id);
		this._onDidChangeDevices.fire();
		return true;
	}

	hasPassword(): boolean {
		return !!this._password;
	}

	async setPassword(password: string | undefined): Promise<void> {
		if (password === undefined) {
			this._password = undefined;
		} else {
			if (password.length < REMOTE_ACCESS_MIN_PASSWORD_LENGTH) {
				throw new Error(`The password must be at least ${REMOTE_ACCESS_MIN_PASSWORD_LENGTH} characters.`);
			}
			const salt = randomBytes(16);
			const hash = await scryptAsync(password, salt, this._scryptCost, 8, 1);
			this._password = { salt: salt.toString('base64'), hash: hash.toString('base64'), cost: this._scryptCost, blockSize: 8, parallelization: 1 };
		}
		await this._save();
	}

	private async _checkPassword(password: string): Promise<boolean> {
		const stored = this._password;
		if (!stored) {
			return false;
		}
		const expected = Buffer.from(stored.hash, 'base64');
		const actual = await scryptAsync(password, Buffer.from(stored.salt, 'base64'), stored.cost, stored.blockSize, stored.parallelization, expected.length);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	private _fail(client: string, reason: RemoteAccessAuthFailure, countForAllClients = true): RemoteAccessPairResult {
		const now = this._now();
		const limits: [string, number][] = [[client, this._maxFailuresPerClient]];
		if (countForAllClients) {
			limits.push([ALL_CLIENTS, this._maxFailuresTotal]);
		}
		for (const [key, max] of limits) {
			const record = this._failures.get(key) ?? { failures: [], lockedUntil: 0 };
			record.failures = record.failures.filter(time => now - time < this._failureWindowMs);
			record.failures.push(now);
			if (record.failures.length >= max) {
				record.lockedUntil = now + this._lockoutMs;
				record.failures = [];
				this._logService.warn(`[RemoteAccess] Too many failed attempts${key === ALL_CLIENTS ? '' : ` from ${key}`}; locked for ${Math.round(this._lockoutMs / 60_000)} minutes`);
			}
			this._failures.set(key, record);
		}
		return { ok: false, reason };
	}

	private _save(): Promise<void> {
		const contents: IStoreContents = { version: 1, devices: [...this._devices.values()], password: this._password };
		const data = JSON.stringify(contents, undefined, '\t');
		this._writeQueue = this._writeQueue.then(async () => {
			const temporary = `${this._file}.${randomBytes(4).toString('hex')}.tmp`;
			try {
				await fs.writeFile(temporary, data, { mode: 0o600 });
				await fs.rename(temporary, this._file);
			} catch (error) {
				this._logService.error('[RemoteAccess] Could not save the device store', error);
				await fs.rm(temporary, { force: true }).catch(() => { });
			}
		});
		return this._writeQueue;
	}
}

/** Uppercase, without spaces and dashes. */
export function normalizePairingCode(code: string): string {
	return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function sanitizeDeviceName(name: string): string {
	const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
	return trimmed || 'Device';
}

function hashSecret(secret: string): string {
	return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

function scryptAsync(password: string, salt: Buffer, cost: number, blockSize: number, parallelization: number, keyLength = 64): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password.normalize('NFC'), salt, keyLength, { N: cost, r: blockSize, p: parallelization, maxmem: 256 * cost * blockSize }, (error, key) => error ? reject(error) : resolve(key));
	});
}

function toPublicDevice(device: IStoredDevice): IRemoteAccessDevice {
	return { id: device.id, name: device.name, createdAt: device.createdAt, lastSeenAt: device.lastSeenAt, pairedPublicly: device.pairedPublicly };
}

function sanitizeStore(value: unknown): IStoreContents {
	const store = value as Partial<IStoreContents> | undefined;
	const devices = Array.isArray(store?.devices) ? store.devices.filter((device): device is IStoredDevice =>
		!!device && typeof device.id === 'string' && typeof device.keyHash === 'string' && typeof device.name === 'string'
		&& typeof device.createdAt === 'number' && typeof device.lastSeenAt === 'number') : [];
	const password = store?.password;
	const validPassword = password && typeof password.salt === 'string' && typeof password.hash === 'string'
		&& typeof password.cost === 'number' && typeof password.blockSize === 'number' && typeof password.parallelization === 'number' ? password : undefined;
	return { version: 1, devices: devices.map(device => ({ ...device, pairedPublicly: !!device.pairedPublicly })), password: validPassword };
}
