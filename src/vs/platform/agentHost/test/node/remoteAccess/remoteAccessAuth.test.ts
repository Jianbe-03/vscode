/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { IRemoteAccessAuthOptions, RemoteAccessAuth, RemoteAccessAuthFailure } from '../../../node/remoteAccess/remoteAccessAuth.js';

suite('RemoteAccessAuth', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let now: number;

	setup(() => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'remoteAccessAuth');
		now = 1_000_000;
	});

	teardown(() => fs.rm(dir, { recursive: true, force: true }));

	async function createAuth(options: IRemoteAccessAuthOptions = {}): Promise<RemoteAccessAuth> {
		return store.add(await RemoteAccessAuth.create(dir, new NullLogService(), { now: () => now, scryptCost: 1024, ...options }));
	}

	test('a pairing code works once and only before it expires', async () => {
		const auth = await createAuth({ pairingCodeLifetimeMs: 1000 });
		const { code } = auth.createPairingCode();
		const first = await auth.pair({ code: code.toLowerCase().replace('-', ' '), deviceName: 'Phone', requirePassword: false, client: 'a' });
		const second = await auth.pair({ code, deviceName: 'Phone', requirePassword: false, client: 'a' });

		const expiring = auth.createPairingCode();
		now += 1001;
		const expired = await auth.pair({ code: expiring.code, deviceName: 'Tablet', requirePassword: false, client: 'a' });

		assert.deepStrictEqual(
			[first.ok, second.ok ? undefined : second.reason, expired.ok ? undefined : expired.reason, auth.listDevices().map(device => device.name)],
			[true, RemoteAccessAuthFailure.InvalidCode, RemoteAccessAuthFailure.ExpiredCode, ['Phone']],
		);
	});

	test('device keys are verified against stored hashes only', async () => {
		const auth = await createAuth();
		const result = await auth.pair({ code: auth.createPairingCode().code, deviceName: 'Phone', requirePassword: false, client: 'a' });
		assert.ok(result.ok);

		const stored = await fs.readFile(join(dir, 'remote-access-auth.json'), 'utf8');
		const secret = result.deviceKey.split('.')[1];
		const reloaded = await createAuth();

		assert.deepStrictEqual([
			stored.includes(secret),
			reloaded.verifyDeviceKey(result.deviceKey, 'a')?.name,
			reloaded.verifyDeviceKey(`${result.device.id}.wrong`, 'a'),
			reloaded.verifyDeviceKey(undefined, 'a'),
		], [false, 'Phone', undefined, undefined]);
	});

	test('public pairing needs the password', async () => {
		const auth = await createAuth();
		const noPassword = await auth.pair({ code: auth.createPairingCode().code, deviceName: 'Phone', requirePassword: true, client: 'a' });
		await auth.setPassword('correct horse');
		const { code } = auth.createPairingCode();
		const missing = await auth.pair({ code, deviceName: 'Phone', requirePassword: true, client: 'a' });
		const wrong = await auth.pair({ code, deviceName: 'Phone', password: 'wrong horse', requirePassword: true, client: 'a' });
		const right = await auth.pair({ code, deviceName: 'Phone', password: 'correct horse', requirePassword: true, client: 'a' });

		assert.deepStrictEqual(
			[noPassword.ok || noPassword.reason, missing.ok || missing.reason, wrong.ok || wrong.reason, right.ok && right.device.pairedPublicly, auth.hasPassword()],
			[RemoteAccessAuthFailure.NoPasswordSet, RemoteAccessAuthFailure.PasswordRequired, RemoteAccessAuthFailure.WrongPassword, true, true],
		);
		await assert.rejects(auth.setPassword('short'));
	});

	test('failed attempts lock a client out, then all clients', async () => {
		const auth = await createAuth({ maxFailuresPerClient: 3, maxFailuresTotal: 5, lockoutMs: 60_000 });
		const { code } = auth.createPairingCode();
		for (let i = 0; i < 3; i++) {
			await auth.pair({ code: 'WRONG', deviceName: 'x', requirePassword: false, client: 'attacker' });
		}
		const lockedWithRightCode = await auth.pair({ code, deviceName: 'x', requirePassword: false, client: 'attacker' });
		const otherClientBefore = auth.getLockout('other');
		await auth.pair({ code: 'WRONG', deviceName: 'x', requirePassword: false, client: 'b' });
		await auth.pair({ code: 'WRONG', deviceName: 'x', requirePassword: false, client: 'c' });
		const otherClientAfter = auth.getLockout('other');
		now += 60_001;
		const afterLockout = await auth.pair({ code, deviceName: 'x', requirePassword: false, client: 'attacker' });

		assert.deepStrictEqual(
			[lockedWithRightCode.ok || lockedWithRightCode.reason, otherClientBefore, otherClientAfter, afterLockout.ok],
			[RemoteAccessAuthFailure.LockedOut, 0, 60_000, true],
		);
	});

	test('signing a device out revokes its key and fires the event', async () => {
		const auth = await createAuth({ maxFailuresPerClient: 1 });
		const result = await auth.pair({ code: auth.createPairingCode().code, deviceName: 'Phone', requirePassword: false, client: 'a' });
		assert.ok(result.ok);
		const revoked: string[] = [];
		store.add(auth.onDidRevokeDevice(id => revoked.push(id)));

		const signedOut = await auth.revokeDevice(result.device.id);
		const afterRevoke = auth.verifyDeviceKey(result.deviceKey, 'a');
		// A signed-out device that keeps retrying does not lock its client out.
		const lockout = auth.getLockout('a');

		assert.deepStrictEqual([signedOut, revoked, afterRevoke, lockout, auth.listDevices()], [true, [result.device.id], undefined, 0, []]);
	});
});
