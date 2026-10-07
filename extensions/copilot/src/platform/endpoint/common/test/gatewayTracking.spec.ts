/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { detectIssueFromBranch, detectIssueFromText, extractUserRequestText, gatewayKindFromUrl, getCostFromHeaders, getCostFromUsage, getGatewayTrackingBody, getGatewayTrackingHeaders, IChatWorkContext, normalizeGatewayRoot, parseIssueReference, repoFromRemoteUrl } from '../gatewayTracking';

describe('gatewayTracking (CreaEditor)', () => {
	test('detects issues from branches, prompts and references', () => {
		expect({
			branches: ['123-fix-login', 'issue/45', 'feature/GH-7-x', 'jibbe/issue-12-foo', 'fix/#9', 'release/1.2', 'main', 'feature/login'].map(detectIssueFromBranch),
			texts: ['Fix https://github.com/creacoon/bliep/issues/88 please', 'work on creacoon/bliep#5', 'start and complete issue #31', 'no issue here'].map(detectIssueFromText),
			references: [123, '#4', 'org/repo#6', 'https://github.com/a/b/pull/2', 'nope'].map(parseIssueReference),
			repos: ['git@github.com:creacoon/bliep.git', 'https://github.com/creacoon/bliep', undefined].map(repoFromRemoteUrl),
			gateways: ['https://openrouter.ai/api/v1/chat/completions', 'http://litellm:4000', 'not a url'].map(gatewayKindFromUrl),
			roots: ['http://litellm:4000/v1/', 'http://litellm:4000/v1/chat/completions', 'http://litellm:4000'].map(normalizeGatewayRoot),
		}).toMatchInlineSnapshot(`
			{
			  "branches": [
			    123,
			    45,
			    7,
			    12,
			    9,
			    undefined,
			    undefined,
			    undefined,
			  ],
			  "gateways": [
			    "openrouter",
			    undefined,
			    undefined,
			  ],
			  "references": [
			    {
			      "number": 123,
			    },
			    {
			      "number": 4,
			    },
			    {
			      "number": 6,
			      "repo": "org/repo",
			    },
			    {
			      "number": 2,
			      "repo": "a/b",
			    },
			    undefined,
			  ],
			  "repos": [
			    "creacoon/bliep",
			    "creacoon/bliep",
			    undefined,
			  ],
			  "roots": [
			    "http://litellm:4000",
			    "http://litellm:4000",
			    "http://litellm:4000",
			  ],
			  "texts": [
			    {
			      "number": 88,
			      "repo": "creacoon/bliep",
			    },
			    {
			      "number": 5,
			      "repo": "creacoon/bliep",
			    },
			    {
			      "number": 31,
			    },
			    undefined,
			  ],
			}
		`);
	});

	test('builds tracking bodies and headers per gateway', () => {
		const context: IChatWorkContext = { chatId: 'sub-1', rootChatId: 'chat-1', chatTitle: 'Fix login', issue: { number: 12 }, issueSource: 'branch', repo: 'creacoon/bliep', branch: '12-fix-login', user: 'jibbe' };
		expect({
			openrouter: getGatewayTrackingBody('openrouter', 'chatCompletions', context, 'req-1'),
			openrouterMessages: getGatewayTrackingBody('openrouter', 'messages', context, 'req-1'),
			litellm: getGatewayTrackingBody('litellm', 'chatCompletions', context, 'req-1'),
			openrouterHeaders: getGatewayTrackingHeaders('openrouter', context),
			litellmHeaders: getGatewayTrackingHeaders('litellm', context),
		}).toMatchSnapshot();
	});

	test('extracts what the user typed from prompt text', () => {
		expect([
			'<environment_info>macOS</environment_info>\n<context>today</context>\n<userRequest>\nFix #42 please\n</userRequest>',
			'<workspace_info>x</workspace_info><user_query>Plain query</user_query>',
			'<environment_info>macOS</environment_info>\nNo tags here',
			'<environment_info>only context</environment_info>',
		].map(extractUserRequestText)).toEqual(['Fix #42 please', 'Plain query', 'No tags here', undefined]);
	});

	test('reads reported costs', () => {
		const headers: Record<string, string> = { 'x-litellm-response-cost': '0.0123', 'x-litellm-call-id': 'call-1' };
		expect({
			litellm: getCostFromHeaders('litellm', name => headers[name]),
			openrouterHeaders: getCostFromHeaders('openrouter', name => headers[name]),
			usage: getCostFromUsage({ prompt_tokens: 1, cost: 0.5 }),
			noUsage: getCostFromUsage(undefined),
		}).toEqual({ litellm: { cost: 0.0123, gatewayRequestId: 'call-1' }, openrouterHeaders: {}, usage: 0.5, noUsage: undefined });
	});
});
