/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, test } from 'vitest';
import { detectIssueFromBranch, detectIssueFromText, extractUserRequestText, formatIssue, gatewayKindFromUrl, getCostFromHeaders, getCostFromUsage, getGatewayTrackingBody, getGatewayTrackingHeaders, getIssueUrl, getTrackingMetadata, IChatIssue, IChatWorkContext, isJiraIssue, normalizeGatewayRoot, parseIssueReference, repoFromRemoteUrl } from '../gatewayTracking';

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
			    {
			      "number": 123,
			    },
			    {
			      "number": 45,
			    },
			    {
			      "number": 7,
			    },
			    {
			      "number": 12,
			    },
			    {
			      "number": 9,
			    },
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

	test('detects Jira issues and ignores non-ticket tokens', () => {
		expect({
			branches: ['PROJ-123-fix-login', 'feature/PROJ-123', 'jibbe/abc-42-foo', 'fix-PROJ-7-login', 'feature/utf-8-names', 'chore/gpt-5-models', 'issue-12-PROJ-3', 'fix/update-2-files'].map(detectIssueFromBranch),
			texts: [
				'Fix PROJ-123 please',
				'See https://acme.atlassian.net/browse/proj-77 for details, also #5',
				'https://acme.atlassian.net/jira/software/c/projects/PROJ/boards/1?selectedIssue=PROJ-8',
				'https://github.com/creacoon/bliep/issues/88 and https://acme.atlassian.net/browse/PROJ-9',
				'creacoon/bliep#5 relates to PROJ-1',
				'PROJ-2 and #31',
				'Use UTF-8, ISO-8601, SHA-256, GPT-5.1, ES-2022 and RFC-9110 for #4',
				'Bump to GPT-5 and X-1, see src/PROJ-1/file.ts',
			].map(detectIssueFromText),
			references: ['PROJ-42', 'abc-7', 'https://acme.atlassian.net/browse/ABC-1', 'utf-8', 'PROJ-0'].map(parseIssueReference),
		}).toMatchInlineSnapshot(`
			{
			  "branches": [
			    {
			      "key": "PROJ-123",
			      "kind": "jira",
			    },
			    {
			      "key": "PROJ-123",
			      "kind": "jira",
			    },
			    {
			      "key": "ABC-42",
			      "kind": "jira",
			    },
			    {
			      "key": "PROJ-7",
			      "kind": "jira",
			    },
			    {
			      "number": 8,
			    },
			    {
			      "number": 5,
			    },
			    {
			      "key": "PROJ-3",
			      "kind": "jira",
			    },
			    {
			      "number": 2,
			    },
			  ],
			  "references": [
			    {
			      "key": "PROJ-42",
			      "kind": "jira",
			    },
			    {
			      "key": "ABC-7",
			      "kind": "jira",
			    },
			    {
			      "key": "ABC-1",
			      "kind": "jira",
			      "site": "acme.atlassian.net",
			    },
			    undefined,
			    undefined,
			  ],
			  "texts": [
			    {
			      "key": "PROJ-123",
			      "kind": "jira",
			    },
			    {
			      "key": "PROJ-77",
			      "kind": "jira",
			      "site": "acme.atlassian.net",
			    },
			    {
			      "key": "PROJ-8",
			      "kind": "jira",
			      "site": "acme.atlassian.net",
			    },
			    {
			      "number": 88,
			      "repo": "creacoon/bliep",
			    },
			    {
			      "number": 5,
			      "repo": "creacoon/bliep",
			    },
			    {
			      "key": "PROJ-2",
			      "kind": "jira",
			    },
			    {
			      "number": 4,
			    },
			    undefined,
			  ],
			}
		`);
	});

	test('formats, links and loads issues', () => {
		// Ledger entries persisted before Jira support have no `kind` and stay GitHub issues.
		const persisted: IChatIssue[] = [JSON.parse('{"number":12,"repo":"creacoon/bliep"}'), JSON.parse('{"number":7}')];
		const issues: IChatIssue[] = [...persisted, { kind: 'jira', key: 'PROJ-123', site: 'acme.atlassian.net' }, { kind: 'jira', key: 'PROJ-9' }];
		const jiraContext: IChatWorkContext = { chatId: 'chat-1', rootChatId: 'chat-1', issue: issues[2], issueSource: 'prompt', repo: 'creacoon/bliep' };
		expect({
			issues: issues.map(issue => ({ jira: isJiraIssue(issue), label: formatIssue(issue, 'fallback/repo'), url: getIssueUrl(issue) })),
			metadata: getTrackingMetadata(jiraContext, 'req-1'),
			headers: getGatewayTrackingHeaders('litellm', jiraContext),
		}).toMatchInlineSnapshot(`
			{
			  "headers": {
			    "x-litellm-tags": "creaeditor,chat:chat-1,issue:PROJ-123,repo:creacoon/bliep",
			  },
			  "issues": [
			    {
			      "jira": false,
			      "label": "creacoon/bliep#12",
			      "url": undefined,
			    },
			    {
			      "jira": false,
			      "label": "fallback/repo#7",
			      "url": undefined,
			    },
			    {
			      "jira": true,
			      "label": "PROJ-123",
			      "url": "https://acme.atlassian.net/browse/PROJ-123",
			    },
			    {
			      "jira": true,
			      "label": "PROJ-9",
			      "url": undefined,
			    },
			  ],
			  "metadata": {
			    "creaeditor_chat": "chat-1",
			    "creaeditor_issue": "PROJ-123",
			    "creaeditor_issue_source": "prompt",
			    "creaeditor_repo": "creacoon/bliep",
			    "creaeditor_request": "req-1",
			  },
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
