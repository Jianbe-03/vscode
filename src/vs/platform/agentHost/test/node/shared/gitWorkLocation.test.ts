/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { GitWorkLocationCache, parseGitHeadBranch, parseGitRemoteUrl, readGitWorkLocation, repoFromGitRemoteUrl } from '../../../node/shared/gitWorkLocation.js';

suite('CreaEditor - git work location', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;

	setup(() => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorGitWorkLocation');
	});

	teardown(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('parses HEAD, remotes and repository names', () => {
		assert.deepStrictEqual({
			heads: ['ref: refs/heads/feature/PROJ-7-login\n', '0123456789abcdef\n'].map(parseGitHeadBranch),
			remotes: [
				'[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/microsoft/vscode.git\n[remote "origin"]\n\turl = git@github.com:creacoon/bliep.git\n',
				'[remote "fork"]\n\turl = https://github.com/jibbe/bliep\n[branch "main"]\n\tremote = fork\n',
				'[core]\n\tbare = false\n',
			].map(parseGitRemoteUrl),
			repos: ['git@github.com:creacoon/bliep.git', 'https://github.com/creacoon/bliep/', undefined].map(repoFromGitRemoteUrl),
		}, {
			heads: ['feature/PROJ-7-login', undefined],
			remotes: ['git@github.com:creacoon/bliep.git', 'https://github.com/jibbe/bliep', undefined],
			repos: ['creacoon/bliep', 'creacoon/bliep', undefined],
		});
	});

	test('reads a repository, a linked worktree from a subfolder, and a folder outside git', async () => {
		const gitDir = join(dir, 'repo', '.git');
		fs.mkdirSync(join(gitDir, 'worktrees', 'w1'), { recursive: true });
		fs.writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/develop\n');
		fs.writeFileSync(join(gitDir, 'config'), '[remote "origin"]\n\turl = https://github.com/creacoon/bliep.git\n');
		fs.writeFileSync(join(gitDir, 'worktrees', 'w1', 'HEAD'), 'ref: refs/heads/102-fix-signup\n');
		fs.writeFileSync(join(gitDir, 'worktrees', 'w1', 'commondir'), '../..\n');
		fs.mkdirSync(join(dir, 'worktree', 'packages', 'web'), { recursive: true });
		fs.writeFileSync(join(dir, 'worktree', '.git'), 'gitdir: ../repo/.git/worktrees/w1\n');
		fs.mkdirSync(join(dir, 'plain'));

		assert.deepStrictEqual(await Promise.all([
			readGitWorkLocation(join(dir, 'repo')),
			readGitWorkLocation(join(dir, 'worktree', 'packages', 'web')),
			readGitWorkLocation(join(dir, 'plain')).then(location => location.branch ?? location.repo ?? 'none'),
		]), [
			{ branch: 'develop', repo: 'creacoon/bliep' },
			{ branch: '102-fix-signup', repo: 'creacoon/bliep' },
			'none',
		]);
	});

	test('reuses a folder\'s location for a few seconds', async () => {
		let now = 0;
		let reads = 0;
		const cache = new GitWorkLocationCache(async () => ({ branch: `b${++reads}` }), () => now);
		const first = await cache.get('/w');
		now = 4_000;
		const cached = await cache.get('/w');
		now = 9_500;
		const fresh = await cache.get('/w');
		assert.deepStrictEqual([first, cached, fresh], [{ branch: 'b1' }, { branch: 'b1' }, { branch: 'b2' }]);
	});
});
