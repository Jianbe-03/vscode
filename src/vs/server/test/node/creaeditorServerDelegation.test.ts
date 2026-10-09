/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { getRandomTestPath } from '../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { DelegationAgentKind, DelegationErrorCode, DelegationResultsMode, IDelegationAccountsPayload } from '../../../platform/agentHost/common/creaeditorDelegation.js';
import { bringBackChanges, delegateChat, DelegationHttpClient, getBroughtBackBranchName } from '../../../platform/agentHost/node/creaeditorDelegation/delegationClient.js';
import { openDelegationPayload } from '../../../platform/agentHost/node/creaeditorDelegation/delegationCrypto.js';
import { DelegationError } from '../../../platform/agentHost/node/creaeditorDelegation/delegationPack.js';
import { getClaudeProjectDirName } from '../../../platform/agentHost/node/creaeditorDelegation/delegationSessionFiles.js';
import { CreaEditorDelegationApi, getCreaEditorDelegationLayout } from '../../node/creaeditorServer/creaeditorServerDelegation.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trimEnd();
}

suite('CreaEditor Server - Delegate to Server', function () {
	this.timeout(30_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let laptop: string;
	let server: http.Server;
	let api: CreaEditorDelegationApi;
	let serverUrl: string;
	const deviceKey = 'device.FAKE_DEVICE_KEY';

	setup(async () => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorServerDelegation');
		laptop = join(dir, 'laptop');
		fs.mkdirSync(laptop, { recursive: true });
		git(laptop, 'init', '-q', '-b', 'main');
		fs.writeFileSync(join(laptop, 'a.ts'), 'a1\n');
		git(laptop, 'add', '-A');
		git(laptop, 'commit', '-q', '-m', 'first');
		fs.writeFileSync(join(laptop, 'a.ts'), 'a2\n');

		api = new CreaEditorDelegationApi({
			layout: getCreaEditorDelegationLayout(join(dir, 'server'), join(dir, 'server', 'secrets')),
			serverName: 'Test Server',
			logService: new NullLogService(),
			claudeConfigDir: join(dir, 'server-claude'),
		});
		// Stands in for the Remote Access front, which checks the device key before the handler runs.
		server = http.createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://localhost');
			if (request.headers.authorization !== `Bearer ${deviceKey}` || !url.pathname.startsWith(api.prefix)) {
				response.writeHead(401).end();
				return;
			}
			void api.handle(request, response, url.pathname.slice(api.prefix.length), url, { id: 'device', name: 'Laptop' });
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	teardown(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('delegates code, Claude session and accounts, then brings the work back into a local branch', async () => {
		const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
		const laptopClaude = join(dir, 'laptop-claude');
		const realLaptop = fs.realpathSync(laptop);
		fs.mkdirSync(join(laptopClaude, 'projects', getClaudeProjectDirName(realLaptop)), { recursive: true });
		fs.writeFileSync(join(laptopClaude, 'projects', getClaudeProjectDirName(realLaptop), `${sessionId}.jsonl`), JSON.stringify({ cwd: realLaptop, sessionId }) + '\n');
		const accounts: IDelegationAccountsPayload = { claudeTokens: [{ accountId: 'acc1', label: 'Work', token: 'sk-ant-oat01-FAKE' }] };
		const stages: string[] = [];

		const target = { serverId: 's1', name: 'Test Server', serverUrl, deviceKey };
		const result = await delegateChat({
			server: target,
			folder: laptop,
			title: 'Fix the bug',
			resultsMode: DelegationResultsMode.BringBack,
			includeSecretFiles: false,
			maxUploadBytes: 1e9,
			agent: DelegationAgentKind.Claude,
			agentSessionId: sessionId,
			accounts,
			sourceName: 'Laptop',
		}, { claudeConfigDir: laptopClaude, onProgress: progress => stages.push(progress.stage) });

		const { record } = result;
		const serverTranscript = join(dir, 'server-claude', 'projects', getClaudeProjectDirName(record.workingDirectory), `${sessionId}.jsonl`);
		const keyPair = await api.getKeyPair();
		assert.deepStrictEqual({
			branch: record.branch.startsWith('creaeditor/delegated/'),
			worktreeFile: fs.readFileSync(join(record.worktree, 'a.ts'), 'utf8'),
			resumeSessionId: record.resumeSessionId,
			sessionFilesSent: result.sessionFilesSent,
			transcriptCwd: JSON.parse(fs.readFileSync(serverTranscript, 'utf8')).cwd === record.workingDirectory,
			accounts: JSON.parse(openDelegationPayload(result.accountsEnvelope!, keyPair, record.delegationId)),
			stages: [...new Set(stages)],
			fetched: (await new DelegationHttpClient(target).getDelegation(record.delegationId)).branch === record.branch,
		}, {
			branch: true,
			worktreeFile: 'a2\n',
			resumeSessionId: sessionId,
			sessionFilesSent: true,
			transcriptCwd: true,
			accounts,
			stages: ['packing', 'uploading', 'preparing', 'done'],
			fetched: true,
		});

		// The chat works on the server...
		fs.writeFileSync(join(record.worktree, 'b.ts'), 'from the server\n');
		git(record.worktree, 'add', 'b.ts');
		git(record.worktree, 'commit', '-q', '-m', 'server commit');

		// ...and its work comes back as a branch, leaving the laptop's files as they are.
		const branch = getBroughtBackBranchName('Test Server', record.shortId);
		const back = await bringBackChanges({ server: target, delegationId: record.delegationId, folder: laptop, baseCommit: record.baseCommit, branch });
		assert.deepStrictEqual({
			branch: back.branch,
			unchanged: back.unchanged,
			includesUncommitted: back.includesUncommitted,
			log: git(laptop, 'log', '--format=%s', branch).split('\n'),
			laptopA: fs.readFileSync(join(laptop, 'a.ts'), 'utf8'),
			laptopHasB: fs.existsSync(join(laptop, 'b.ts')),
		}, {
			branch: `creaeditor/from-test-server/${record.shortId}`,
			unchanged: false,
			// The laptop's uncommitted a2 is still uncommitted on the server: it comes back as a last commit.
			includesUncommitted: true,
			log: ['Uncommitted changes from Test Server', 'server commit', 'first'],
			laptopA: 'a2\n',
			laptopHasB: false,
		});
	});

	test('the second delegation of the same repository sends only new commits', async () => {
		const target = { serverId: 's1', name: 'Test Server', serverUrl, deviceKey };
		const request = { server: target, folder: laptop, title: 'T', resultsMode: DelegationResultsMode.BringBack, includeSecretFiles: false, maxUploadBytes: 1e9, agent: DelegationAgentKind.Transcript, sourceName: 'Laptop' };
		const first = await delegateChat(request);
		const second = await delegateChat(request);
		assert.deepStrictEqual([first.incremental, second.incremental, first.bytesSent > 0, second.bytesSent < first.bytesSent, second.record.worktree !== first.record.worktree], [false, true, true, true, true]);
	});

	test('explains a wrong key and an unreachable server', async () => {
		const request = { folder: laptop, title: 'T', resultsMode: DelegationResultsMode.BringBack, includeSecretFiles: false, maxUploadBytes: 1e9, agent: DelegationAgentKind.Transcript, sourceName: 'Laptop' };
		const codeOf = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: DelegationError) => error.code);
		assert.deepStrictEqual([
			await codeOf(delegateChat({ ...request, server: { serverId: 's1', name: 'S', serverUrl, deviceKey: 'wrong' } })),
			await codeOf(delegateChat({ ...request, server: { serverId: 's1', name: 'S', serverUrl: 'http://127.0.0.1:1', deviceKey } }, { retryDelayMs: 1 })),
		], [DelegationErrorCode.Unauthorized, DelegationErrorCode.Offline]);
	});
});
