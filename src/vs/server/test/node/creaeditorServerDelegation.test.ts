/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import type * as http from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from '../../../base/common/path.js';
import { getRandomTestPath } from '../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { DelegationAgentKind, DelegationErrorCode, getBroughtBackBranchName, DelegationResultsMode, IDelegationAccountsPayload } from '../../../platform/agentHost/common/creaeditorDelegation.js';
import { bringBackChanges, delegateChat, DelegationHttpClient } from '../../../platform/agentHost/node/creaeditorDelegation/delegationClient.js';
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
			codexHome: join(dir, 'server-codex'),
			copilotHome: join(dir, 'server-copilot'),
		});
		// Stands in for the Remote Access front, which checks the device key before the handler runs.
		const { createServer } = await import('http');
		server = createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://localhost');
			if (request.headers.authorization !== `Bearer ${deviceKey}` || !url.pathname.startsWith(api.prefix)) {
				response.writeHead(401).end();
				return;
			}
			void api.handle(request, response, url.pathname.slice(api.prefix.length), url, { id: 'device', name: 'Laptop', createdAt: 0, lastSeenAt: 0, pairedPublicly: false });
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
			accounts: { ...accounts, workContext: { worktree: record.worktree, title: 'Fix the bug', branch: 'main' } },
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

	test('moves Codex threads and Copilot CLI sessions so they resume on the server', async () => {
		const realLaptop = fs.realpathSync(laptop);
		const threadId = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
		const codexDay = join(dir, 'laptop-codex', 'sessions', '2026', '10', '09');
		fs.mkdirSync(codexDay, { recursive: true });
		fs.writeFileSync(join(codexDay, `rollout-2026-10-09T10-00-00-${threadId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: realLaptop } }) + '\n');
		const copilotId = '11111111-2222-3333-4444-555555555555';
		const copilotSession = join(dir, 'laptop-copilot', 'session-state', copilotId);
		fs.mkdirSync(copilotSession, { recursive: true });
		fs.writeFileSync(join(copilotSession, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { context: { cwd: realLaptop } } }) + '\n');
		fs.writeFileSync(join(copilotSession, 'workspace.yaml'), `id: ${copilotId}\ncwd: ${realLaptop}\n`);
		fs.writeFileSync(join(copilotSession, '.workspace-fork.lock'), '');

		const target = { serverId: 's1', name: 'Test Server', serverUrl, deviceKey };
		const base = { server: target, folder: laptop, title: 'T', resultsMode: DelegationResultsMode.BringBack, includeSecretFiles: false, maxUploadBytes: 1e9, sourceName: 'Laptop' };
		const options = { codexHome: join(dir, 'laptop-codex'), copilotHome: join(dir, 'laptop-copilot') };
		const codex = await delegateChat({ ...base, agent: DelegationAgentKind.Codex, agentSessionId: threadId }, options);
		const copilot = await delegateChat({ ...base, agent: DelegationAgentKind.CopilotCli, agentSessionId: copilotId }, options);
		const serverCopilot = join(dir, 'server-copilot', 'session-state', copilotId);
		assert.deepStrictEqual({
			codex: [codex.sessionFilesSent, codex.record.resumeSessionId],
			codexCwd: JSON.parse(fs.readFileSync(join(dir, 'server-codex', 'sessions', '2026', '10', '09', `rollout-2026-10-09T10-00-00-${threadId}.jsonl`), 'utf8')).payload.cwd === codex.record.workingDirectory,
			copilot: [copilot.sessionFilesSent, copilot.record.resumeSessionId],
			copilotFiles: fs.readdirSync(serverCopilot).sort(),
			copilotCwd: JSON.parse(fs.readFileSync(join(serverCopilot, 'events.jsonl'), 'utf8')).data.context.cwd === copilot.record.workingDirectory,
			copilotYaml: fs.readFileSync(join(serverCopilot, 'workspace.yaml'), 'utf8') === `id: ${copilotId}\ncwd: ${copilot.record.workingDirectory}\n`,
		}, {
			codex: [true, threadId],
			codexCwd: true,
			copilot: [true, copilotId],
			copilotFiles: ['events.jsonl', 'workspace.yaml'],
			copilotCwd: true,
			copilotYaml: true,
		});
	});

	test('delegates a chat again after Take Back Here: the new copy has the full history and resumes as its own session', async () => {
		const realLaptop = fs.realpathSync(laptop);
		const copilotId = '11111111-2222-3333-4444-555555555555';
		const copilotSession = join(dir, 'laptop-copilot', 'session-state', copilotId);
		fs.mkdirSync(copilotSession, { recursive: true });
		fs.writeFileSync(join(copilotSession, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { sessionId: copilotId, context: { cwd: realLaptop } } }) + '\n');
		fs.writeFileSync(join(copilotSession, 'workspace.yaml'), `id: ${copilotId}\ncwd: ${realLaptop}\n`);
		const threadId = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
		const codexDay = join(dir, 'laptop-codex', 'sessions', '2026', '10', '09');
		const rollout = `rollout-2026-10-09T10-00-00-${threadId}.jsonl`;
		fs.mkdirSync(codexDay, { recursive: true });
		fs.writeFileSync(join(codexDay, rollout), JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: realLaptop } }) + '\n');
		const claudeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
		const claudeTranscript = join(dir, 'laptop-claude', 'projects', getClaudeProjectDirName(realLaptop), `${claudeId}.jsonl`);
		fs.mkdirSync(join(claudeTranscript, '..'), { recursive: true });
		fs.writeFileSync(claudeTranscript, JSON.stringify({ sessionId: claudeId, cwd: realLaptop }) + '\n');

		const target = { serverId: 's1', name: 'Test Server', serverUrl, deviceKey };
		const base = { server: target, folder: laptop, title: 'T', resultsMode: DelegationResultsMode.BringBack, includeSecretFiles: false, maxUploadBytes: 1e9, sourceName: 'Laptop' };
		const options = { codexHome: join(dir, 'laptop-codex'), copilotHome: join(dir, 'laptop-copilot'), claudeConfigDir: join(dir, 'laptop-claude') };
		const chats = [[DelegationAgentKind.CopilotCli, copilotId], [DelegationAgentKind.Codex, threadId], [DelegationAgentKind.Claude, claudeId]] as const;
		for (const [agent, agentSessionId] of chats) {
			await delegateChat({ ...base, agent, agentSessionId }, options);
		}
		// Taken back: the chats go on here.
		fs.appendFileSync(join(copilotSession, 'events.jsonl'), JSON.stringify({ type: 'user.message', data: { content: 'later' } }) + '\n');
		fs.appendFileSync(join(codexDay, rollout), JSON.stringify({ type: 'event_msg', payload: { message: 'later' } }) + '\n');
		fs.appendFileSync(claudeTranscript, JSON.stringify({ sessionId: claudeId, message: 'later' }) + '\n');
		const again = [];
		for (const [agent, agentSessionId] of chats) {
			again.push(await delegateChat({ ...base, agent, agentSessionId }, options));
		}
		const [copilot, codex, claude] = again.map(result => ({ id: result.record.resumeSessionId!, source: result.record.sourceSessionId, sent: result.sessionFilesSent }));
		const lines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
		const serverCopilot = join(dir, 'server-copilot', 'session-state', copilot.id);
		const serverClaude = join(dir, 'server-claude', 'projects', getClaudeProjectDirName(again[2].record.workingDirectory), `${claude.id}.jsonl`);
		assert.deepStrictEqual({
			sources: [copilot.source, codex.source, claude.source],
			sent: [copilot.sent, codex.sent, claude.sent],
			newIds: [copilot.id, codex.id, claude.id].every(id => /^[0-9a-f-]{36}$/.test(id) && ![copilotId, threadId, claudeId].includes(id)),
			copilotEvents: lines(join(serverCopilot, 'events.jsonl')).map(event => event.data.sessionId ?? event.data.content),
			copilotYaml: fs.readFileSync(join(serverCopilot, 'workspace.yaml'), 'utf8') === `id: ${copilot.id}\ncwd: ${again[0].record.workingDirectory}\n`,
			codexRollout: lines(join(dir, 'server-codex', 'sessions', '2026', '10', '09', `rollout-2026-10-09T10-00-00-${codex.id}.jsonl`)).map(line => line.payload.id ?? line.payload.message),
			claudeTranscript: lines(serverClaude).map(line => [line.sessionId, line.message]),
			// The first copies stay as they were.
			firstCopilot: lines(join(dir, 'server-copilot', 'session-state', copilotId, 'events.jsonl')).length,
			firstCodex: lines(join(dir, 'server-codex', 'sessions', '2026', '10', '09', rollout)).length,
		}, {
			sources: [copilotId, threadId, claudeId],
			sent: [true, true, true],
			newIds: true,
			copilotEvents: [copilot.id, 'later'],
			copilotYaml: true,
			codexRollout: [codex.id, 'later'],
			claudeTranscript: [[claude.id, undefined], [claude.id, 'later']],
			firstCopilot: 1,
			firstCodex: 1,
		});
	});

	test('a delegation that fails after the worktree was created leaves no worktree, branch or record behind', async () => {
		const copilotId = '11111111-2222-3333-4444-555555555555';
		const copilotSession = join(dir, 'laptop-copilot', 'session-state', copilotId);
		fs.mkdirSync(copilotSession, { recursive: true });
		fs.writeFileSync(join(copilotSession, 'events.jsonl'), '{}\n');
		// The server cannot write session files: its Copilot home is a file.
		fs.writeFileSync(join(dir, 'server-copilot'), '');
		const target = { serverId: 's1', name: 'Test Server', serverUrl, deviceKey };
		const failed = await delegateChat({ server: target, folder: laptop, title: 'T', resultsMode: DelegationResultsMode.BringBack, includeSecretFiles: false, maxUploadBytes: 1e9, sourceName: 'Laptop', agent: DelegationAgentKind.CopilotCli, agentSessionId: copilotId }, { copilotHome: join(dir, 'laptop-copilot') }).then(() => 'ok', (error: DelegationError) => error.code);
		const repos = join(dir, 'server', 'repos');
		assert.deepStrictEqual({
			failed,
			worktrees: fs.readdirSync(join(dir, 'server', 'worktrees')),
			records: fs.readdirSync(join(dir, 'server', 'delegations')).filter(name => name.endsWith('.json')),
			branches: fs.readdirSync(repos).filter(name => name.endsWith('.git')).map(bare => git(join(repos, bare), 'branch', '--list', 'creaeditor/delegated/*')),
		}, {
			failed: DelegationErrorCode.Unexpected,
			worktrees: [],
			records: [],
			branches: [''],
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
