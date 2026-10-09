/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX, CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME } from '../../../common/creaeditorDelegation.js';
import { getDelegationSecretsDir, openDelegationAccounts, parseDelegationAccountsResource, readServerDelegationKeyPair } from '../../../node/creaeditorDelegation/delegationAccounts.js';
import { AGENT_HOST_SECRETS_DIR_ENV_VAR, FileSecretStore } from '../../../node/shared/fileSecretStore.js';
import { generateDelegationKeyPair, openDelegationPayload, sealDelegationPayload } from '../../../node/creaeditorDelegation/delegationCrypto.js';
import { exportClaudeSession, getClaudeProjectDirName, installSessionFiles, rewriteSessionPaths } from '../../../node/creaeditorDelegation/delegationSessionFiles.js';

suite('CreaEditor Delegation - accounts encryption', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('round-trips for the server key and the same delegation only', () => {
		const server = generateDelegationKeyPair();
		const other = generateDelegationKeyPair();
		const payload = JSON.stringify({ claudeTokens: [{ accountId: 'a1', label: 'Work', token: 'sk-ant-oat01-FAKE' }] });
		const envelope = sealDelegationPayload(payload, server.publicKey, 'delegation-1');

		const attempt = (fn: () => string) => {
			try {
				return fn();
			} catch {
				return 'failed';
			}
		};
		assert.deepStrictEqual({
			opened: openDelegationPayload(envelope, server, 'delegation-1'),
			plaintextVisible: JSON.stringify(envelope).includes('FAKE'),
			wrongContext: attempt(() => openDelegationPayload(envelope, server, 'delegation-2')),
			wrongKey: attempt(() => openDelegationPayload(envelope, other, 'delegation-1')),
			tampered: attempt(() => openDelegationPayload({ ...envelope, data: Buffer.from('x' + envelope.data).toString('base64') }, server, 'delegation-1')),
			freshKeyEachTime: sealDelegationPayload(payload, server.publicKey, 'delegation-1').ephemeralPublicKey !== envelope.ephemeralPublicKey,
		}, {
			opened: payload,
			plaintextVisible: false,
			wrongContext: 'failed',
			wrongKey: 'failed',
			tampered: 'failed',
			freshKeyEachTime: true,
		});
	});

	test('the server\'s agent host opens the accounts of a delegated chat with the key pair of the code receiver', async () => {
		const secretsDir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorDelegationAccounts');
		try {
			const keyPair = generateDelegationKeyPair();
			const store = new FileSecretStore(getDelegationSecretsDir(secretsDir));
			await store.set(CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME, JSON.stringify(keyPair));
			const payload = { claudeTokens: [{ accountId: 'acc1', label: 'Work', token: 'sk-ant-oat01-FAKE' }, { accountId: '../bad', label: 'x', token: 'y' }] };
			const token = JSON.stringify(sealDelegationPayload(JSON.stringify(payload), keyPair.publicKey, 'd1'));
			const serverKey = readServerDelegationKeyPair({ [AGENT_HOST_SECRETS_DIR_ENV_VAR]: secretsDir })!;
			assert.deepStrictEqual({
				resource: [parseDelegationAccountsResource(`${CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX}d1`), parseDelegationAccountsResource('creaeditor-subscription-account:x')],
				noServer: readServerDelegationKeyPair({}),
				opened: openDelegationAccounts('d1', token, serverKey),
			}, {
				resource: ['d1', undefined],
				noServer: undefined,
				opened: { claudeTokens: [payload.claudeTokens[0]] },
			});
		} finally {
			fs.rmSync(secretsDir, { recursive: true, force: true });
		}
	});
});

suite('CreaEditor Delegation - Claude session files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	setup(() => dir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorDelegationSession'));
	teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

	test('names project folders like the Claude Agent SDK', () => {
		const long = `/home/${'a'.repeat(250)}`;
		assert.deepStrictEqual(
			[getClaudeProjectDirName('/Users/me/my repo.x'), getClaudeProjectDirName(long).length > 200, getClaudeProjectDirName(long).slice(0, 6)],
			['-Users-me-my-repo-x', true, '-home-'],
		);
	});

	test('rewrites the laptop folder only where a path starts with it', () => {
		const line = JSON.stringify({ cwd: '/Users/me/repo', input: { file_path: '/Users/me/repo/src/a.ts' }, other: '/Users/me/repository/x', text: 'see /Users/me/repo' });
		assert.deepStrictEqual(JSON.parse(rewriteSessionPaths(line, '/Users/me/repo', '/srv/worktrees/d1')), {
			cwd: '/srv/worktrees/d1',
			input: { file_path: '/srv/worktrees/d1/src/a.ts' },
			other: '/Users/me/repository/x',
			text: 'see /Users/me/repo',
		});
	});

	test('exports a session with its subagents and installs it where the SDK looks for the worktree', () => {
		const laptopConfig = join(dir, 'laptop-claude');
		const serverConfig = join(dir, 'server-claude');
		const project = join(laptopConfig, 'projects', getClaudeProjectDirName('/Users/me/repo'));
		const sessionId = '11111111-2222-3333-4444-555555555555';
		fs.mkdirSync(join(project, sessionId, 'subagents'), { recursive: true });
		fs.writeFileSync(join(project, `${sessionId}.jsonl`), [JSON.stringify({ type: 'user', cwd: '/Users/me/repo', sessionId }), JSON.stringify({ type: 'assistant', cwd: '/Users/me/repo' })].join('\n') + '\n');
		fs.writeFileSync(join(project, sessionId, 'subagents', 'agent-1.jsonl'), JSON.stringify({ cwd: '/Users/me/repo' }) + '\n');
		fs.writeFileSync(join(project, 'other-session.jsonl'), 'not sent\n');

		const exported = exportClaudeSession({ configDir: laptopConfig, sessionId, fromCwd: '/Users/me/repo', toCwd: '/srv/worktrees/d1' })!;
		installSessionFiles(serverConfig, exported.files);
		const serverProject = join(serverConfig, 'projects', '-srv-worktrees-d1');

		assert.deepStrictEqual({
			paths: exported.files.map(file => file.relativePath).sort(),
			cwds: fs.readFileSync(join(serverProject, `${sessionId}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line).cwd),
			subagent: JSON.parse(fs.readFileSync(join(serverProject, sessionId, 'subagents', 'agent-1.jsonl'), 'utf8')).cwd,
			missing: exportClaudeSession({ configDir: laptopConfig, sessionId: 'nope', fromCwd: '/a', toCwd: '/b' }),
		}, {
			paths: [`projects/-srv-worktrees-d1/${sessionId}.jsonl`, `projects/-srv-worktrees-d1/${sessionId}/subagents/agent-1.jsonl`],
			cwds: ['/srv/worktrees/d1', '/srv/worktrees/d1'],
			subagent: '/srv/worktrees/d1',
			missing: undefined,
		});
		// Installing twice (or over another chat's session) is refused.
		assert.throws(() => installSessionFiles(serverConfig, exported.files));
	});

	test('refuses session file paths outside the agent folder', () => {
		for (const relativePath of ['../x.jsonl', '/etc/passwd', 'projects/../../x', 'projects//x', 'projects\\x']) {
			assert.throws(() => installSessionFiles(dir, [{ relativePath, content: '' }]), relativePath);
		}
	});
});
