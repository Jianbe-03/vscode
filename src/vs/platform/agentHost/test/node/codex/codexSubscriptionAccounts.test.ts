/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ISubscriptionAccount } from '../../../common/meta/subscriptionAccounts.js';
import { getCodexAccountHome, prepareCodexAccountHome, removeCodexAccountSignIn, resolveDefaultCodexHome } from '../../../node/codex/codexAccountHomes.js';
import { CODEX_DEFAULT_ACCOUNT_ID, CodexAccountPool } from '../../../node/codex/codexAccountPool.js';
import { codexContinuationPrompt, codexLimitedUntil, codexLimitErrorMeta, codexUsageWindows, isCodexUsageLimitError, selectCodexAccount } from '../../../node/codex/codexSubscriptionAccounts.js';

function account(id: string, overrides: Partial<ISubscriptionAccount> = {}): ISubscriptionAccount {
	return { id, provider: 'codex', label: id.toUpperCase(), kind: id === 'default' ? 'default' : 'login', status: 'signedIn', ...overrides };
}

suite('CodexSubscriptionAccounts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('account homes', () => {
		let root: string;

		setup(async () => {
			root = await fs.promises.mkdtemp(join(os.tmpdir(), 'codex-account-homes-'));
		});

		teardown(async () => {
			await fs.promises.rm(root, { recursive: true, force: true });
		});

		test('links everything but the sign-in to the default home', async () => {
			const defaultHome = join(root, 'default');
			const accountHome = getCodexAccountHome(root, 'work');
			await fs.promises.mkdir(join(defaultHome, 'prompts'), { recursive: true });
			await fs.promises.writeFile(join(defaultHome, 'auth.json'), '{}');
			await fs.promises.writeFile(join(defaultHome, 'config.toml'), 'model = "x"');
			await fs.promises.writeFile(join(defaultHome, 'AGENTS.md'), '# agents');

			await prepareCodexAccountHome(defaultHome, accountHome);
			// Entries that appear later are linked on the next start; existing ones are kept.
			await fs.promises.writeFile(join(defaultHome, 'state_5.sqlite'), '');
			await fs.promises.writeFile(join(accountHome, 'auth.json'), '{"own":true}');
			await prepareCodexAccountHome(defaultHome, accountHome);

			const entries = await fs.promises.readdir(accountHome);
			const layout = await Promise.all(entries.sort().map(async entry => {
				const stat = await fs.promises.lstat(join(accountHome, entry));
				return [entry, stat.isSymbolicLink() ? await fs.promises.realpath(join(accountHome, entry)) : 'own'];
			}));
			const realDefaultHome = await fs.promises.realpath(defaultHome);
			assert.deepStrictEqual(layout, [
				['AGENTS.md', join(realDefaultHome, 'AGENTS.md')],
				['archived_sessions', join(realDefaultHome, 'archived_sessions')],
				['auth.json', 'own'],
				['config.toml', join(realDefaultHome, 'config.toml')],
				['prompts', join(realDefaultHome, 'prompts')],
				['sessions', join(realDefaultHome, 'sessions')],
				['state_5.sqlite', join(realDefaultHome, 'state_5.sqlite')],
			]);

			await removeCodexAccountSignIn(accountHome);
			assert.deepStrictEqual({
				signIn: fs.existsSync(join(accountHome, 'auth.json')),
				defaultSignIn: fs.existsSync(join(defaultHome, 'auth.json')),
				sessions: fs.existsSync(join(accountHome, 'sessions')),
			}, { signIn: false, defaultSignIn: true, sessions: true });
		});

		test('resolves homes', () => {
			assert.deepStrictEqual([
				resolveDefaultCodexHome(undefined, '/home/me'),
				resolveDefaultCodexHome('/custom', '/home/me'),
				getCodexAccountHome('/home/me', 'a-1'),
			], [join('/home/me', '.codex'), '/custom', join('/home/me', '.creaeditor', 'codex-accounts', 'a-1')]);
			assert.throws(() => getCodexAccountHome('/home/me', '../escape'));
		});
	});

	test('maps rate limit windows to usage windows', () => {
		assert.deepStrictEqual(codexUsageWindows([
			{ usedPercent: 12, windowDurationMins: 10080, resetsAt: 2000 },
			{ usedPercent: 80, windowDurationMins: 300, resetsAt: 1000 },
		]), [
			{ kind: '300m', label: '5-hour', usedPercent: 80, resetsAt: 1_000_000 },
			{ kind: '10080m', label: 'Weekly', usedPercent: 12, resetsAt: 2_000_000 },
		]);
	});

	test('selects the first available account in order', () => {
		const now = 1000;
		const accounts = [
			account('default', { status: 'limited', limitedUntil: 5000 }),
			account('signed-out', { status: 'signedOut' }),
			account('claude', { provider: 'claude' }),
			account('expired', { status: 'limited', limitedUntil: 500 }),
			account('work'),
		];
		assert.deepStrictEqual([
			selectCodexAccount(accounts, now)?.id,
			selectCodexAccount(accounts, now, 'expired')?.id,
			selectCodexAccount(accounts.slice(0, 3), now)?.id,
		], ['expired', 'work', undefined]);
	});

	test('recognizes subscription limit errors and when they reset', () => {
		const now = 1_000;
		assert.deepStrictEqual({
			usage: isCodexUsageLimitError({ message: 'limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null }),
			throttle: isCodexUsageLimitError({ message: 'slow down', codexErrorInfo: 'rateLimitExceeded', additionalDetails: null, misalignment: null }),
			none: isCodexUsageLimitError(undefined),
			fullWindow: codexLimitedUntil([{ kind: '300m', label: '5-hour', usedPercent: 100, resetsAt: 9_000 }, { kind: '10080m', label: 'Weekly', usedPercent: 40, resetsAt: 99_000 }], now),
			noFullWindow: codexLimitedUntil([{ kind: '300m', label: '5-hour', usedPercent: 99, resetsAt: 9_000 }], now),
			noReading: codexLimitedUntil(undefined, now),
		}, { usage: true, throttle: false, none: false, fullWindow: 9_000, noFullWindow: 9_000, noReading: now + 60 * 60 * 1000 });
	});

	test('describes the limit for the client', () => {
		assert.deepStrictEqual([
			codexLimitErrorMeta(account('default', { status: 'limited', limitedUntil: 7 }), account('work')),
			codexLimitErrorMeta(account('work'), undefined),
		], [
			{ provider: 'codex', accountId: 'default', accountLabel: 'DEFAULT', resetsAt: 7, nextAccountId: 'work', nextAccountLabel: 'WORK' },
			{ provider: 'codex', accountId: 'work', accountLabel: 'WORK' },
		]);
	});

	suite('account pool', () => {
		function createPool(): CodexAccountPool {
			const pool = new CodexAccountPool();
			pool.setStoredAccounts([{ id: 'work', label: 'Work', kind: 'login' }, { id: 'token', label: 'Token', kind: 'token' }]);
			return pool;
		}

		test('lists the default account first and starts work on the first available account', () => {
			const pool = createPool();
			const before = pool.pickAccountForNewWork(0);
			pool.update(CODEX_DEFAULT_ACCOUNT_ID, { status: 'signedIn' });
			pool.update('work', { status: 'signedIn' });
			const listed = pool.getAccounts(0).map(account => [account.id, account.kind, account.status]);
			const withDefault = pool.pickAccountForNewWork(0);
			pool.applyUsage(CODEX_DEFAULT_ACCOUNT_ID, [{ kind: '300m', label: '5-hour', usedPercent: 100, resetsAt: 5_000 }], 0);
			const whileLimited = pool.pickAccountForNewWork(0);
			const afterReset = pool.pickAccountForNewWork(6_000);
			assert.deepStrictEqual({ before, listed, withDefault, whileLimited, afterReset }, {
				// Without a ChatGPT login in the default home only signed-in added accounts take over.
				before: CODEX_DEFAULT_ACCOUNT_ID,
				listed: [[CODEX_DEFAULT_ACCOUNT_ID, 'default', 'signedIn'], ['work', 'login', 'signedIn']],
				withDefault: CODEX_DEFAULT_ACCOUNT_ID,
				whileLimited: 'work',
				afterReset: CODEX_DEFAULT_ACCOUNT_ID,
			});
			pool.dispose();
		});

		test('moves on without asking only when auto-switch is on and another account is available', () => {
			const pool = createPool();
			pool.update(CODEX_DEFAULT_ACCOUNT_ID, { status: 'signedIn' });
			pool.update('work', { status: 'signedIn' });
			pool.markLimited(CODEX_DEFAULT_ACCOUNT_ID, 0);
			const auto = pool.decideOnLimit(CODEX_DEFAULT_ACCOUNT_ID, true, 0);
			const ask = pool.decideOnLimit(CODEX_DEFAULT_ACCOUNT_ID, false, 0);
			pool.markLimited('work', 0);
			const none = pool.decideOnLimit(CODEX_DEFAULT_ACCOUNT_ID, true, 0);
			assert.deepStrictEqual({
				auto: auto?.kind === 'switch' ? auto.next.id : auto?.kind,
				ask: ask?.kind === 'ask' ? ask.meta.nextAccountId : ask?.kind,
				none: none?.kind === 'ask' ? none.meta : none?.kind,
				unknown: pool.decideOnLimit('missing', true, 0),
			}, {
				auto: 'work',
				ask: 'work',
				none: { provider: 'codex', accountId: CODEX_DEFAULT_ACCOUNT_ID, accountLabel: 'Codex Default', resetsAt: 60 * 60 * 1000 },
				unknown: undefined,
			});
			pool.dispose();
		});
	});

	test('continues a refused turn without nesting the continuation', () => {
		const once = codexContinuationPrompt('Fix the bug');
		assert.deepStrictEqual([once.endsWith('Fix the bug'), codexContinuationPrompt(once) === once], [true, true]);
	});
});
