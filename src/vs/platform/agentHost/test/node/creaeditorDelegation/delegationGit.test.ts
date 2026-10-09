/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DelegationErrorCode } from '../../../common/creaeditorDelegation.js';
import { DelegationError, packWorkspace, readDelegationRepository } from '../../../node/creaeditorDelegation/delegationPack.js';
import { IDelegationProcessOptions, IDelegationProcessResult, IDelegationProcessRunner, nodeDelegationProcessRunner } from '../../../node/creaeditorDelegation/delegationProcess.js';
import { createResultBundle, importResultBundle, IDelegationStoreLayout, listKnownCommits, openPullRequestFromServer, parseGitHubRemote, prepareDelegationWorktree } from '../../../node/creaeditorDelegation/delegationWorktrees.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

function run(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trimEnd();
}

function write(root: string, path: string, content: string): void {
	fs.mkdirSync(join(root, path, '..'), { recursive: true });
	fs.writeFileSync(join(root, path), content);
}

function read(root: string, path: string): string | undefined {
	try {
		return fs.readFileSync(join(root, path), 'utf8');
	} catch {
		return undefined;
	}
}

suite('CreaEditor Delegation - git', function () {
	this.timeout(30_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let laptop: string;
	let layout: IDelegationStoreLayout;

	setup(() => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorDelegation');
		laptop = join(dir, 'laptop');
		layout = { repos: join(dir, 'server', 'repos'), worktrees: join(dir, 'server', 'worktrees') };
		fs.mkdirSync(laptop, { recursive: true });
		run(laptop, 'init', '-q', '-b', 'main');
		write(laptop, '.gitignore', 'node_modules/\n*.log\n');
		write(laptop, 'src/a.ts', 'a1\n');
		write(laptop, 'src/gone.ts', 'gone\n');
		write(laptop, 'config/.env.example', 'TRACKED=1\n');
		run(laptop, 'add', '-A');
		run(laptop, 'commit', '-q', '-m', 'first');
		run(laptop, 'remote', 'add', 'origin', 'https://github.com/creacoon/example.git');
	});

	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	function makeLocalChanges(): void {
		write(laptop, 'src/a.ts', 'a2 uncommitted\n');
		fs.rmSync(join(laptop, 'src/gone.ts'));
		write(laptop, 'src/new.ts', 'untracked\n');
		write(laptop, 'node_modules/x/index.js', 'ignored\n');
		write(laptop, 'debug.log', 'ignored\n');
		write(laptop, '.env.local', 'SECRET=1\n');
		write(laptop, 'config/.env.example', 'TRACKED=2\n');
	}

	async function delegate(delegationId: string, includeSecretFiles = false) {
		const knownCommits = await listKnownCommits(layout, (await readDelegationRepository(laptop)).repoId);
		const packed = await packWorkspace({ folder: join(laptop, 'src'), outFile: join(dir, `${delegationId}.bundle`), knownCommits, includeSecretFiles, maxBytes: 1e9 });
		const prepared = await prepareDelegationWorktree(layout, {
			repoId: packed.repoId,
			delegationId,
			shortId: delegationId,
			head: packed.head,
			snapshot: packed.snapshot,
			subPath: packed.subPath,
			remoteUrl: packed.remoteUrl,
			...(packed.bytes ? { bundleFile: join(dir, `${delegationId}.bundle`) } : {}),
		});
		return { packed, prepared };
	}

	test('sends committed history, uncommitted changes and untracked files, but not ignored files or secrets', async () => {
		makeLocalChanges();
		const statusBefore = run(laptop, 'status', '--porcelain');
		const { packed, prepared } = await delegate('d1');
		const worktree = prepared.worktree;

		assert.deepStrictEqual({
			subPath: packed.subPath,
			branch: packed.branch,
			hasLocalChanges: packed.hasLocalChanges,
			incremental: packed.incremental,
			skippedSecretFiles: packed.skippedSecretFiles,
			serverHead: run(worktree, 'rev-parse', 'HEAD'),
			serverBranch: run(worktree, 'symbolic-ref', '--short', 'HEAD'),
			workingDirectory: prepared.workingDirectory === join(worktree, 'src'),
			files: {
				a: read(worktree, 'src/a.ts'),
				gone: read(worktree, 'src/gone.ts'),
				new: read(worktree, 'src/new.ts'),
				ignored: read(worktree, 'node_modules/x/index.js'),
				log: read(worktree, 'debug.log'),
				secret: read(worktree, '.env.local'),
				tracked: read(worktree, 'config/.env.example'),
			},
			serverStatus: run(worktree, 'status', '--porcelain').split('\n').sort(),
			laptopStatusUnchanged: run(laptop, 'status', '--porcelain') === statusBefore,
			laptopTempRefs: run(laptop, 'for-each-ref', 'refs/creaeditor'),
			origin: run(worktree, 'remote', 'get-url', 'origin'),
		}, {
			subPath: 'src',
			branch: 'main',
			hasLocalChanges: true,
			incremental: false,
			skippedSecretFiles: ['.env.local'],
			serverHead: packed.head,
			serverBranch: 'creaeditor/delegated/d1',
			workingDirectory: true,
			files: { a: 'a2 uncommitted\n', gone: undefined, new: 'untracked\n', ignored: undefined, log: undefined, secret: undefined, tracked: 'TRACKED=2\n' },
			serverStatus: [' D src/gone.ts', ' M config/.env.example', ' M src/a.ts', '?? src/new.ts'],
			laptopStatusUnchanged: true,
			laptopTempRefs: '',
			origin: 'https://github.com/creacoon/example.git',
		});
	});

	test('includes secret-looking files only when asked', async () => {
		makeLocalChanges();
		const { prepared } = await delegate('d1', true);
		assert.strictEqual(read(prepared.worktree, '.env.local'), 'SECRET=1\n');
	});

	test('sends only what the server lacks the second time', async () => {
		write(laptop, 'big.txt', randomBytes(150_000).toString('base64'));
		run(laptop, 'add', '-A');
		run(laptop, 'commit', '-q', '-m', 'big');
		const first = await delegate('d1');
		write(laptop, 'src/a.ts', 'a3\n');
		run(laptop, 'commit', '-q', '-am', 'second');
		const second = await delegate('d2');
		const nothingNew = await delegate('d3');

		assert.deepStrictEqual({
			firstIncremental: first.packed.incremental,
			secondIncremental: second.packed.incremental,
			secondSmaller: second.packed.bytes > 0 && second.packed.bytes < first.packed.bytes / 4,
			secondContent: read(second.prepared.worktree, 'src/a.ts'),
			nothingNewBytes: nothingNew.packed.bytes,
			nothingNewHead: run(nothingNew.prepared.worktree, 'rev-parse', 'HEAD') === second.packed.head,
		}, {
			firstIncremental: false,
			secondIncremental: true,
			secondSmaller: true,
			secondContent: 'a3\n',
			nothingNewBytes: 0,
			nothingNewHead: true,
		});
	});

	test('refuses code larger than the limit with a clear error', async () => {
		write(laptop, 'random.bin', Array.from({ length: 50_000 }, () => Math.random().toString(36)).join(''));
		await assert.rejects(
			packWorkspace({ folder: laptop, outFile: join(dir, 'x.bundle'), knownCommits: [], includeSecretFiles: false, maxBytes: 10_000 }),
			(error: Error) => error instanceof DelegationError && error.code === DelegationErrorCode.TooLarge && /MB, more than the limit/.test(error.message),
		);
		assert.strictEqual(fs.existsSync(join(dir, 'x.bundle')), false);
	});

	test('brings the server\'s commits and uncommitted work back into a local branch without touching the working tree', async () => {
		const { packed, prepared } = await delegate('d1');
		write(prepared.worktree, 'src/server.ts', 'committed on server\n');
		run(prepared.worktree, 'add', '-A');
		run(prepared.worktree, 'commit', '-q', '-m', 'server work');
		write(prepared.worktree, 'src/a.ts', 'uncommitted on server\n');
		write(laptop, 'src/a.ts', 'local edit\n');

		const result = await createResultBundle(prepared.worktree, { knownCommits: [packed.head], outFile: join(dir, 'result.bundle'), serverName: 'Server' });
		await importResultBundle(laptop, { bundleFile: result.bundleFile, commit: result.commit, branch: 'creaeditor/from-server/d1' });

		assert.deepStrictEqual({
			includesUncommitted: result.includesUncommitted,
			branchLog: run(laptop, 'log', '--format=%s', 'creaeditor/from-server/d1').split('\n'),
			branchFile: run(laptop, 'show', 'creaeditor/from-server/d1:src/a.ts'),
			laptopFile: read(laptop, 'src/a.ts'),
			laptopBranch: run(laptop, 'symbolic-ref', '--short', 'HEAD'),
			serverStatusUnchanged: run(prepared.worktree, 'status', '--porcelain'),
		}, {
			includesUncommitted: true,
			branchLog: ['Uncommitted changes from Server', 'server work', 'first'],
			branchFile: 'uncommitted on server',
			laptopFile: 'local edit\n',
			laptopBranch: 'main',
			serverStatusUnchanged: ' M src/a.ts',
		});
	});

	test('opens a pull request with the token only in the environment (mocked git push and gh)', async () => {
		const { prepared } = await delegate('d1');
		write(prepared.worktree, 'src/pr.ts', 'change\n');
		const calls: { command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
		const runner: IDelegationProcessRunner = {
			async run(command: string, args: readonly string[], options: IDelegationProcessOptions): Promise<IDelegationProcessResult> {
				if (command === 'gh' || args[0] === 'push') {
					calls.push({ command, args, ...(options.env ? { env: options.env } : {}) });
					return command === 'gh' ? { code: 0, stdout: 'https://github.com/creacoon/example/pull/7\n', stderr: '' } : { code: 0, stdout: '', stderr: '' };
				}
				return nodeDelegationProcessRunner.run(command, args, options);
			}
		};
		const url = await openPullRequestFromServer({ worktree: prepared.worktree, branch: prepared.branch, remoteUrl: 'git@github.com:creacoon/example.git', base: 'main', title: 'Fix it', body: 'Body', token: 'ghp_FAKE_TOKEN', serverName: 'Server' }, runner);

		assert.deepStrictEqual({
			url,
			committed: run(prepared.worktree, 'log', '-1', '--format=%s'),
			clean: run(prepared.worktree, 'status', '--porcelain'),
			commands: calls.map(call => [call.command, ...call.args].join(' ')),
			tokenInArgs: calls.some(call => call.args.some(arg => arg.includes('ghp_FAKE_TOKEN'))),
			pushHeader: calls[0].env?.['GIT_CONFIG_VALUE_0'] === `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghp_FAKE_TOKEN').toString('base64')}`,
			ghToken: calls[1].env?.['GH_TOKEN'],
		}, {
			url: 'https://github.com/creacoon/example/pull/7',
			committed: 'Changes from Server',
			clean: '',
			commands: [
				'git push -q https://github.com/creacoon/example.git HEAD:refs/heads/creaeditor/delegated/d1',
				'gh pr create --repo creacoon/example --head creaeditor/delegated/d1 --title Fix it --body Body --base main',
			],
			tokenInArgs: false,
			pushHeader: true,
			ghToken: 'ghp_FAKE_TOKEN',
		});
	});

	test('reads GitHub remotes', () => {
		assert.deepStrictEqual(
			['https://github.com/a/b.git', 'git@github.com:a/b-c.git', 'ssh://git@github.com/a/b', 'https://gitlab.com/a/b.git'].map(parseGitHubRemote),
			[{ owner: 'a', repo: 'b' }, { owner: 'a', repo: 'b-c' }, { owner: 'a', repo: 'b' }, undefined],
		);
	});
});
