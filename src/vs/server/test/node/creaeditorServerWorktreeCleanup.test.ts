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
import { Emitter } from '../../../base/common/event.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { URI } from '../../../base/common/uri.js';
import { getRandomTestPath } from '../../../base/test/node/testUtils.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { NullLogService } from '../../../platform/log/common/log.js';
import { DelegationAgentKind, DelegationChatState, DelegationResultsMode, getBroughtBackBranchName, IDelegationRecord } from '../../../platform/agentHost/common/creaeditorDelegation.js';
import { SessionStatus } from '../../../platform/agentHost/common/state/sessionState.js';
import { bringBackChanges, delegateChat, DelegationHttpClient } from '../../../platform/agentHost/node/creaeditorDelegation/delegationClient.js';
import { CreaEditorDelegationApi, getCreaEditorDelegationLayout } from '../../node/creaeditorServer/creaeditorServerDelegation.js';
import { AgentHostSessionsWatcher, ICreaEditorServerSessionsSource, IServerChatSession, toServerChatSession } from '../../node/creaeditorServer/creaeditorServerSessions.js';
import { ARCHIVED_DELEGATION_KEEP_MS, DelegationWorktreeCleanup, findDelegationChats, getDelegationChatState, isDelegationWorkSafe, ORPHANED_DELEGATION_KEEP_MS, planDelegationCleanup } from '../../node/creaeditorServer/creaeditorServerWorktreeCleanup.js';

const IDENTITY = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
const DAY = 24 * 60 * 60 * 1000;

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: 'utf8' }).trimEnd();
}

/** The agent host's chats, as the test sets them. */
class FakeSessions implements ICreaEditorServerSessionsSource {
	private readonly _onDidRemoveSession = new Emitter<IServerChatSession>();
	readonly onDidRemoveSession = this._onDidRemoveSession.event;
	private readonly _onDidChangeSession = new Emitter<IServerChatSession>();
	readonly onDidChangeSession = this._onDidChangeSession.event;
	sessions: IServerChatSession[] = [];

	async listSessions(): Promise<readonly IServerChatSession[] | undefined> {
		return this.sessions;
	}

	remove(resource: string): void {
		const session = this.sessions.find(candidate => candidate.resource === resource)!;
		this.sessions = this.sessions.filter(candidate => candidate !== session);
		this._onDidRemoveSession.fire(session);
	}

	dispose(): void {
		this._onDidRemoveSession.dispose();
		this._onDidChangeSession.dispose();
	}
}

suite('CreaEditor Server - cleanup of delegated worktrees', function () {
	this.timeout(60_000);
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('decides from the chats on the server and whether the work is safe', () => {
		const record = { agent: DelegationAgentKind.Claude, resumeSessionId: 'abc', createdAt: 0 };
		const sessions: IServerChatSession[] = [
			{ resource: 'claude:/abc', archived: true, workingDirectories: [] },
			{ resource: 'copilotcli:/other', archived: false, workingDirectories: ['/data/worktrees/app-1/src'] },
			{ resource: 'copilotcli:/next-to-it', archived: false, workingDirectories: ['/data/worktrees/app-1.worktrees/x'] },
		];
		const now = 100 * DAY;
		assert.deepStrictEqual({
			chats: findDelegationChats(record, ['/data/worktrees/app-1'], sessions).map(session => session.resource),
			states: [undefined, [], [sessions[0]], sessions.slice(0, 2)].map(chats => getDelegationChatState(chats)),
			safe: [undefined, 't1', 't2', 't3', 'other'].map(tree => isDelegationWorkSafe({ initialTree: 't1', broughtBackTree: 't2', pushedTree: 't3' }, tree)),
			running: planDelegationCleanup({ createdAt: 0, archivedSeenAt: 5 }, DelegationChatState.Running, true, now),
			archivedNow: planDelegationCleanup({ createdAt: 0 }, DelegationChatState.Archived, true, now),
			archivedUnsafe: planDelegationCleanup({ createdAt: 0, chatSeenAt: 1, archivedSeenAt: 2 }, DelegationChatState.Archived, false, now),
			orphaned: planDelegationCleanup({ createdAt: 0, chatSeenAt: 1 }, DelegationChatState.Deleted, true, now).removeAfter,
			unknown: planDelegationCleanup({ createdAt: 0 }, DelegationChatState.Unknown, true, now),
		}, {
			chats: ['claude:/abc', 'copilotcli:/other'],
			states: [DelegationChatState.Unknown, DelegationChatState.Deleted, DelegationChatState.Archived, DelegationChatState.Running],
			safe: [true, true, true, true, false],
			running: { notes: { chatSeenAt: now, archivedSeenAt: undefined } },
			archivedNow: { removeAfter: now + ARCHIVED_DELEGATION_KEEP_MS, reason: 'its chat is archived for 7 days and its work was brought back, pushed or never changed', notes: { chatSeenAt: now, archivedSeenAt: now } },
			archivedUnsafe: {},
			orphaned: ORPHANED_DELEGATION_KEEP_MS,
			unknown: {},
		});
	});

	test('reads chats from session summaries', () => {
		assert.deepStrictEqual([
			toServerChatSession({ resource: 'claude:/a', status: SessionStatus.Idle | SessionStatus.IsArchived, workingDirectories: [URI.file('/w/a').toString(), 'vscode-agent-host://x/file/y'] }),
			toServerChatSession({ status: SessionStatus.Idle }, { resource: 'claude:/a', archived: true, workingDirectories: ['/w/a'] }),
			toServerChatSession({ resource: 42 }),
		], [
			{ resource: 'claude:/a', archived: true, workingDirectories: [URI.file('/w/a').fsPath] },
			{ resource: 'claude:/a', archived: false, workingDirectories: ['/w/a'] },
			undefined,
		]);
	});

	test('follows the agent host over its socket: lists chats and sees deletions', async () => {
		const dir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorServerSessions');
		fs.mkdirSync(dir, { recursive: true });
		const socketPath = join(dir, 'ah.sock');
		const ws = await import('ws');
		const { createServer } = await import('http');
		const httpServer = createServer();
		const wsServer = new ws.WebSocketServer({ server: httpServer });
		const methods: string[] = [];
		let serverSocket: { send(data: string): void } | undefined;
		wsServer.on('connection', socket => socket.on('message', data => {
			serverSocket = socket;
			const message = JSON.parse(data.toString());
			methods.push(message.method);
			if (message.method === 'initialize') {
				socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '0.9.0' } }));
			} else if (message.method === 'listSessions') {
				const page = message.params.cursor ? [{ resource: 'codex:/b', status: SessionStatus.Idle }] : [{ resource: 'claude:/a', status: SessionStatus.Idle | SessionStatus.IsArchived, workingDirectories: [URI.file('/w/a').toString()] }];
				socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { items: page, ...(message.params.cursor ? {} : { nextCursor: 'next' }) } }));
			}
		}));
		await new Promise<void>(resolve => httpServer.listen(socketPath, resolve));
		const watcher = disposables.add(new AgentHostSessionsWatcher(async () => socketPath, new NullLogService()));
		const removed = new Promise<IServerChatSession>(resolve => disposables.add(watcher.onDidRemoveSession(resolve)));
		try {
			const listed = await watcher.listSessions();
			// The user deletes a chat.
			serverSocket?.send(JSON.stringify({ jsonrpc: '2.0', method: 'root/sessionRemoved', params: { channel: 'ahp-root://', session: 'claude:/a' } }));
			assert.deepStrictEqual({ listed, removed: await removed, after: await watcher.listSessions(), methods }, {
				listed: [{ resource: 'claude:/a', archived: true, workingDirectories: [URI.file('/w/a').fsPath] }, { resource: 'codex:/b', archived: false, workingDirectories: [] }],
				removed: { resource: 'claude:/a', archived: true, workingDirectories: [URI.file('/w/a').fsPath] },
				after: [{ resource: 'codex:/b', archived: false, workingDirectories: [] }],
				methods: ['initialize', 'listSessions', 'listSessions'],
			});
		} finally {
			watcher.dispose();
			for (const client of wsServer.clients) {
				client.terminate();
			}
			wsServer.close();
			await new Promise<void>(resolve => httpServer.close(() => resolve()));
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	suite('on a server', () => {
		let dir: string;
		let laptop: string;
		let server: http.Server;
		let api: CreaEditorDelegationApi;
		let serverUrl: string;
		let now: number;
		let sessions: FakeSessions;
		let store: DisposableStore;
		const deviceKey = 'device.FAKE_DEVICE_KEY';

		setup(async () => {
			store = new DisposableStore();
			now = 1_000 * DAY;
			dir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorServerCleanup');
			laptop = join(dir, 'laptop');
			fs.mkdirSync(laptop, { recursive: true });
			git(laptop, 'init', '-q', '-b', 'main');
			fs.writeFileSync(join(laptop, 'a.ts'), 'a1\n');
			git(laptop, 'add', '-A');
			git(laptop, 'commit', '-q', '-m', 'first');
			sessions = new FakeSessions();
			store.add(sessions);
			api = new CreaEditorDelegationApi({
				layout: getCreaEditorDelegationLayout(join(dir, 'server'), join(dir, 'server', 'secrets')),
				serverName: 'Test Server',
				logService: new NullLogService(),
				sessions,
				now: () => now,
			});
			const { createServer } = await import('http');
			server = createServer((request, response) => {
				const url = new URL(request.url ?? '/', 'http://localhost');
				if (request.headers.authorization !== `Bearer ${deviceKey}` || !url.pathname.startsWith(api.prefix)) {
					response.writeHead(401).end();
					return;
				}
				// Any paired device of the user, not only the one that delegated the chats.
				void api.handle(request, response, url.pathname.slice(api.prefix.length), url, { id: 'desktop', name: 'Desktop', createdAt: 0, lastSeenAt: 0, pairedPublicly: false });
			});
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
			serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		});

		teardown(async () => {
			store.dispose();
			await new Promise<void>(resolve => server.close(() => resolve()));
			fs.rmSync(dir, { recursive: true, force: true });
		});

		test('removes archived chats after 7 days only while their work is safe, deleted chats at once, and on request', async () => {
			const target = { serverId: 's1', name: 'Test Server', serverUrl, deviceKey };
			const delegate = async (title: string) => (await delegateChat({ server: target, folder: laptop, title, resultsMode: DelegationResultsMode.BringBack, includeSecretFiles: false, maxUploadBytes: 1e9, agent: DelegationAgentKind.Transcript, sourceName: 'Laptop' })).record;
			const unchanged = await delegate('Unchanged');
			const changed = await delegate('Changed');
			const running = await delegate('Running');
			const deleted = await delegate('Deleted');
			const manual = await delegate('Manual');
			fs.writeFileSync(join(changed.worktree, 'b.ts'), 'from the server\n');
			const chat = (record: IDelegationRecord, archived: boolean) => ({ resource: `copilotcli:/${record.shortId}`, archived, workingDirectories: [record.workingDirectory] });
			sessions.sessions = [chat(unchanged, true), chat(changed, true), chat(running, false), chat(deleted, false), chat(manual, false)];
			const cleanup = store.add(new DelegationWorktreeCleanup(api, sessions, new NullLogService(), () => now));
			const client = new DelegationHttpClient(target);
			const exists = () => [unchanged, changed, running, deleted, manual].map(record => fs.existsSync(record.worktree));

			await cleanup.sweep();
			const listed = (await client.listWorktrees()).map(info => [info.title, info.chatState, info.workSafe, info.removeAfter !== undefined, (info.bytes ?? 0) > 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
			// The user deletes a chat on the server.
			sessions.remove(`copilotcli:/${deleted.shortId}`);
			await cleanup.sweep();
			const afterDelete = exists();

			now += 8 * DAY;
			await cleanup.sweep();
			const afterAWeek = exists();

			// The laptop brings the changes back: now nothing is lost.
			await bringBackChanges({ server: target, delegationId: changed.delegationId, folder: laptop, baseCommit: changed.baseCommit, branch: getBroughtBackBranchName('Test Server', changed.shortId) });
			await cleanup.sweep();
			const afterBringBack = exists();

			await client.removeDelegation(manual.delegationId);
			const bare = join(dir, 'server', 'repos', fs.readdirSync(join(dir, 'server', 'repos')).find(name => name.endsWith('.git'))!);
			assert.deepStrictEqual({
				listed,
				afterDelete,
				afterAWeek,
				afterBringBack,
				afterManual: exists(),
				branches: git(bare, 'branch', '--list', '--format=%(refname:short)', 'creaeditor/delegated/*').split('\n'),
				records: (await client.listWorktrees()).map(info => info.title),
			}, {
				listed: [
					['Changed', DelegationChatState.Archived, false, false, true],
					['Deleted', DelegationChatState.Running, true, false, true],
					['Manual', DelegationChatState.Running, true, false, true],
					['Running', DelegationChatState.Running, true, false, true],
					['Unchanged', DelegationChatState.Archived, true, true, true],
				],
				afterDelete: [true, true, true, false, true],
				afterAWeek: [false, true, true, false, true],
				afterBringBack: [false, false, true, false, true],
				afterManual: [false, false, true, false, false],
				branches: [`creaeditor/delegated/${running.shortId}`],
				records: ['Running'],
			});
		});
	});
});
