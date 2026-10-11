/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { Event } from '../../../../../base/common/event.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getRandomTestPath } from '../../../../../base/test/node/testUtils.js';
import { IByokLmChatRequest } from '../../../common/agentHostByokLm.js';
import { IServerHardStop } from '../../../common/creaeditorCosts.js';
import { IDelegationGatewayKey } from '../../../common/creaeditorDelegation.js';
import { GatewayCostLedgerWriter, IGatewayCostRecord } from '../../../node/shared/gatewayCostLedger.js';
import { detectCostIssueFromBranch, GatewayDirectConnection, getGatewayChatCompletionsUrl, getGatewayKeyModels, IGatewayDirectConnectionHost, parseChatCompletionsAnswer } from '../../../node/shared/gatewayDirectConnection.js';
import { FileSecretStore } from '../../../node/shared/fileSecretStore.js';
import { readServerCostLedger } from '../../../node/shared/serverCostLedger.js';
import { ServerGatewayKeys } from '../../../node/shared/serverGatewayKeys.js';

interface IReceived {
	readonly url: string;
	readonly authorization: string | undefined;
	readonly tags: string | undefined;
	readonly body: Record<string, unknown>;
}

/** A fake LiteLLM/OpenRouter on 127.0.0.1: accepts `key-WORK` and `key-HOME`, answers a tool call and reports a cost. */
async function startMockGateway(received: IReceived[]): Promise<{ readonly server: http.Server; readonly url: string }> {
	const { createServer } = await import('http');
	const server = createServer((request, response) => {
		let data = '';
		request.on('data', chunk => data += chunk);
		request.on('end', () => {
			const authorization = request.headers.authorization;
			received.push({ url: request.url ?? '', authorization, tags: request.headers['x-litellm-tags'] as string | undefined, body: JSON.parse(data) });
			if (authorization !== 'Bearer key-WORK' && authorization !== 'Bearer key-HOME') {
				response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Invalid key' } }));
				return;
			}
			response.writeHead(200, { 'Content-Type': 'application/json', 'x-litellm-response-cost': '0.0123', 'x-litellm-call-id': 'call-1' });
			response.end(JSON.stringify({
				id: 'gen-1',
				choices: [{ message: { content: 'Reading it.', reasoning: 'Look first.', tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }, { id: 'tc2', function: { name: 'apply_patch', arguments: '{"input":"*** patch"}' } }] } }],
				usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.5, prompt_tokens_details: { cached_tokens: 10 } },
			}));
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const request: IByokLmChatRequest = {
	vendor: 'litellm',
	modelId: 'Work/claude-sonnet',
	instructions: 'Be brief.',
	input: [
		{ type: 'message', role: 'user', content: [{ type: 'text', text: 'Fix a.ts' }] },
		{ type: 'function_call', callId: 'old1', name: 'read_file', argumentsJson: '{"path":"b.ts"}' },
		{ type: 'function_call_output', callId: 'old1', output: 'b' },
	],
	tools: [
		{ type: 'function', name: 'read_file', parametersSchema: { type: 'object', properties: { path: { type: 'string' } } } },
		{ type: 'custom', name: 'apply_patch', description: 'Patch' },
	],
	reasoningEffort: 'high',
};

suite('CreaEditor - server gateway connection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let dir: string;
	let received: IReceived[];
	let gateway: { readonly server: http.Server; readonly url: string };

	setup(async () => {
		dir = getRandomTestPath(tmpdir(), 'vsctests', 'creaeditorGatewayDirect');
		received = [];
		gateway = await startMockGateway(received);
	});

	teardown(async () => {
		await new Promise<void>(resolve => gateway.server.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function createConnection(keys: IDelegationGatewayKey[], hardStop?: IServerHardStop): { connection: GatewayDirectConnection; recorded: IGatewayCostRecord[] } {
		const recorded: IGatewayCostRecord[] = [];
		const ledger = new GatewayCostLedgerWriter(join(dir, 'costs'), () => 1000);
		const host: IGatewayDirectConnectionHost = {
			getKeys: () => keys,
			onDidChangeKeys: Event.None,
			findWorkContext: workingDirectory => workingDirectory?.startsWith('/srv/worktrees/d1') ? { worktree: '/srv/worktrees/d1', title: 'Fix the bug', repo: 'acme/web', branch: 'feature/PROJ-7-login' } : undefined,
			findHardStop: () => hardStop,
			recordCost: entry => { recorded.push(entry); ledger.record(entry); },
			fetch: (input, init) => fetch(input, init),
			log: () => { },
		};
		return { connection: new GatewayDirectConnection(host), recorded };
	}

	test('calls LiteLLM with the delegated key, translates the request and the answer, and records the cost', async () => {
		const { connection, recorded } = createConnection([{ providerId: 'litellm', label: 'Work', baseUrl: `${gateway.url}/v1/`, key: 'key-WORK', models: [{ id: 'claude-sonnet', name: 'Sonnet' }] }]);
		const models: string[] = [];
		const listener = connection.onDidChangeModels(list => models.push(...list.map(model => model.modelIdentifier!)));
		const result = await connection.chat(request, { sessionId: 'session-1', workingDirectory: '/srv/worktrees/d1/packages/web' });
		listener.dispose();
		connection.dispose();
		const sent = received[0];
		assert.deepStrictEqual({
			models,
			url: sent.url,
			authorization: sent.authorization,
			tags: sent.tags,
			model: sent.body.model,
			messages: sent.body.messages,
			tools: (sent.body.tools as { function: { name: string } }[]).map(tool => tool.function.name),
			reasoning: sent.body.reasoning_effort,
			sessionId: sent.body.litellm_session_id,
			result,
			recorded,
			ledger: readServerCostLedger(join(dir, 'costs')).map(entry => [entry.cost, entry.providerGroup, entry.time]),
		}, {
			models: ['litellm/Work/claude-sonnet'],
			url: '/v1/chat/completions',
			authorization: 'Bearer key-WORK',
			tags: 'creaeditor,chat:session-1,issue:PROJ-7,repo:acme/web',
			model: 'claude-sonnet',
			messages: [
				{ role: 'system', content: 'Be brief.' },
				{ role: 'user', content: 'Fix a.ts' },
				{ role: 'assistant', content: null, tool_calls: [{ id: 'old1', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } }] },
				{ role: 'tool', tool_call_id: 'old1', content: 'b' },
			],
			tools: ['read_file', 'apply_patch'],
			reasoning: 'high',
			sessionId: 'session-1',
			result: {
				output: [
					{ type: 'reasoning', summary: ['Look first.'] },
					{ type: 'message', content: [{ type: 'text', text: 'Reading it.' }] },
					{ type: 'function_call', callId: 'tc1', name: 'read_file', argumentsJson: '{"path":"a.ts"}' },
					{ type: 'custom_tool_call', callId: 'tc2', name: 'apply_patch', input: '*** patch' },
				],
				responseId: 'gen-1',
				usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: undefined },
			},
			recorded: [{
				chatId: 'session-1',
				rootChatId: 'session-1',
				chatTitle: 'Fix the bug',
				issue: { kind: 'jira', key: 'PROJ-7' },
				issueSource: 'branch',
				repo: 'acme/web',
				branch: 'feature/PROJ-7-login',
				gateway: 'litellm',
				gatewayHost: new URL(gateway.url).host,
				providerGroup: 'Work',
				model: 'claude-sonnet',
				gatewayRequestId: 'call-1',
				promptTokens: 100,
				completionTokens: 20,
				cachedTokens: 10,
				cost: 0.0123,
				costSource: 'header',
			}],
			ledger: [[0.0123, 'Work', 1000]],
		});
	});

	test('reads the OpenRouter cost from usage and asks for it', async () => {
		const { connection, recorded } = createConnection([{ providerId: 'openrouter', label: 'Home', baseUrl: gateway.url, key: 'key-HOME', models: [] }]);
		const result = await connection.chat({ ...request, vendor: 'openrouter', modelId: 'Home/anthropic/claude-sonnet-4' }, { sessionId: 's2' });
		connection.dispose();
		assert.deepStrictEqual({
			error: result.error,
			usage: received[0].body.usage,
			reasoning: received[0].body.reasoning,
			model: received[0].body.model,
			cost: [recorded[0].cost, recorded[0].costSource, recorded[0].gatewayRequestId],
		}, {
			error: undefined,
			usage: { include: true },
			reasoning: { effort: 'high' },
			model: 'anthropic/claude-sonnet-4',
			cost: [0.5, 'response', 'gen-1'],
		});
	});

	test('refuses a request over a hard-stop budget, one without a key, and reports a refused key', async () => {
		const stop: IServerHardStop = { spent: 12, budget: { id: 'b1', scope: 'key', value: 'Work', amount: 10, period: 'month', hardStop: true, from: 0, to: 1, spentElsewhere: 0 } };
		const stopped = createConnection([{ providerId: 'litellm', label: 'Work', baseUrl: gateway.url, key: 'key-WORK' }], stop).connection;
		const wrongKey = createConnection([{ providerId: 'litellm', label: 'Work', baseUrl: gateway.url, key: 'key-OTHER' }]).connection;
		const results = [
			await stopped.chat(request),
			await stopped.chat({ ...request, modelId: 'Home/claude-sonnet' }),
			await wrongKey.chat(request),
		];
		stopped.dispose();
		wrongKey.dispose();
		assert.deepStrictEqual({ errors: results.map(result => result.error), userFacing: results.map(result => !!result.userFacingError), requests: received.length }, {
			userFacing: [true, false, false],
			errors: [
				'Your CreaEditor budget for the Work key ($10 per month) is used up. Raise it with Edit under Budgets on the AI Costs page.',
				'This server has no litellm key for model "Home/claude-sonnet". Delegate a chat that uses this key to the server first.',
				'LiteLLM answered 401: Invalid key',
			],
			requests: 1,
		});
	});

	test('keeps delegated keys and work contexts encrypted in the agent host\'s store', async () => {
		const store = new FileSecretStore(join(dir, 'secrets'), Buffer.alloc(32, 1));
		const keys = new ServerGatewayKeys(store);
		let changes = 0;
		const listener = keys.onDidChange(() => changes++);
		await keys.addFromDelegation({ gatewayKey: { providerId: 'litellm', label: 'Work', baseUrl: 'http://127.0.0.1:4111', key: 'key-OLD' }, workContext: { worktree: '/srv/worktrees/d1', repo: 'acme/web' } });
		await keys.addFromDelegation({ gatewayKey: { providerId: 'litellm', label: 'Work', baseUrl: 'http://127.0.0.1:4111', key: 'key-WORK' }, workContext: { worktree: '/srv/worktrees/d10' } });
		await store.flush();
		listener.dispose();
		assert.deepStrictEqual({
			keys: keys.keys.map(key => `${key.label}:${key.key}`),
			inside: keys.findWorkContext('/srv/worktrees/d1/src')?.repo,
			sibling: keys.findWorkContext('/srv/worktrees/d10')?.worktree,
			outside: keys.findWorkContext('/srv/other'),
			plaintextOnDisk: fs.readdirSync(join(dir, 'secrets')).some(file => fs.readFileSync(join(dir, 'secrets', file), 'utf8').includes('key-WORK')),
			changes,
		}, {
			keys: ['Work:key-WORK'],
			inside: 'acme/web',
			sibling: '/srv/worktrees/d10',
			outside: undefined,
			plaintextOnDisk: false,
			changes: 2,
		});
	});

	test('joins a streamed answer (data: events) into one, and names models with their key', () => {
		const chunk = (delta: object, extra: object = {}) => `data: ${JSON.stringify({ id: 'gen-2', choices: [{ index: 0, delta }], ...extra })}\n\n`;
		const streamed = [
			chunk({ role: 'assistant', content: 'Hel' }),
			chunk({ content: 'lo.' }),
			chunk({ tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name: 'read_', arguments: '{"pa' } }] }),
			chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] }),
			`data: ${JSON.stringify({ id: 'gen-2', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
			'data: [DONE]\n\n',
		].join('');
		assert.deepStrictEqual({
			streamed: parseChatCompletionsAnswer(streamed),
			json: parseChatCompletionsAnswer('{"id":"gen-3","choices":[{"message":{"content":"Hi"}}]}'),
			invalid: parseChatCompletionsAnswer('<html>Bad gateway</html>'),
			names: getGatewayKeyModels([{ providerId: 'litellm', label: 'Home key', key: 'k', models: [{ id: 'mock-mini' }, { id: 'mock-opus', name: 'mock-opus (Home key)' }] }]).map(model => model.name),
		}, {
			streamed: { id: 'gen-2', choices: [{ message: { content: 'Hello.', tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
			json: { id: 'gen-3', choices: [{ message: { content: 'Hi' } }] },
			invalid: undefined,
			names: ['mock-mini (Home key)', 'mock-opus (Home key)'],
		});
	});

	test('builds gateway URLs and reads issues from branches like the laptop', () => {
		assert.deepStrictEqual({
			urls: [
				getGatewayChatCompletionsUrl({ providerId: 'openrouter' }),
				getGatewayChatCompletionsUrl({ providerId: 'litellm', baseUrl: 'https://llm.acme.dev/v1/' }),
				getGatewayChatCompletionsUrl({ providerId: 'litellm', baseUrl: 'https://llm.acme.dev/chat/completions' }),
			],
			issues: ['feature/PROJ-12-x', 'jibbe/issue-45-foo', 'release/1.2', 'main'].map(detectCostIssueFromBranch),
		}, {
			urls: ['https://openrouter.ai/api/v1/chat/completions', 'https://llm.acme.dev/v1/chat/completions', 'https://llm.acme.dev/v1/chat/completions'],
			issues: [{ kind: 'jira', key: 'PROJ-12' }, { number: 45 }, undefined, undefined],
		});
	});
});
