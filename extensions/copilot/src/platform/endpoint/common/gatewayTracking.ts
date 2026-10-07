/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: tracking metadata that is always sent to LLM gateways (OpenRouter, LiteLLM) so the
// cost of every chat and issue can be attributed, plus the parsing of the cost they report back.

/** The kind of LLM gateway a BYOK endpoint talks to. */
export type GatewayKind = 'openrouter' | 'litellm';

/** A GitHub (or other forge) issue a chat is working on. */
export interface IChatIssue {
	readonly number: number;
	/** `owner/repo`, when known. */
	readonly repo?: string;
}

/** Where the issue of a chat came from. */
export type ChatIssueSource = 'agent' | 'prompt' | 'branch';

/** Everything known about the work a request belongs to. */
export interface IChatWorkContext {
	/** The VS Code chat session the request was made in (a subagent has its own id). */
	readonly chatId: string;
	/** The top-level chat session; equals {@link chatId} unless the request comes from a subagent. */
	readonly rootChatId: string;
	readonly chatTitle?: string;
	readonly issue?: IChatIssue;
	readonly issueSource?: ChatIssueSource;
	/** `owner/repo` of the workspace repository. */
	readonly repo?: string;
	readonly branch?: string;
	readonly user?: string;
}

const OPENROUTER_HOST = /(^|\.)openrouter\.ai$/i;

/**
 * Returns the gateway kind for a well-known gateway URL. LiteLLM proxies run on arbitrary hosts and are
 * detected by probing them, see {@link LITELLM_PROBE_PATHS}.
 */
export function gatewayKindFromUrl(url: string | undefined): GatewayKind | undefined {
	if (!url) {
		return undefined;
	}
	try {
		return OPENROUTER_HOST.test(new URL(url).hostname) ? 'openrouter' : undefined;
	} catch {
		return undefined;
	}
}

/** Paths, relative to the proxy root, that only a LiteLLM proxy answers. */
export const LITELLM_PROBE_PATHS = ['/health/liveliness', '/health/readiness'] as const;

/**
 * Normalizes a gateway base URL entered by a user (`https://host`, `https://host/v1/`, ...) to the proxy
 * root without a trailing slash or `/v1` suffix.
 */
export function normalizeGatewayRoot(url: string): string {
	let root = url.trim().replace(/\/+$/, '');
	root = root.replace(/\/(chat\/completions|responses|messages)$/, '');
	root = root.replace(/\/v1$/, '');
	return root;
}

/**
 * Detects an issue number in a git branch name, e.g. `123-fix-login`, `issue/123`, `feature/GH-45-x`,
 * `jibbe/issue-45-foo` or `fix/#12`. Version-like segments (`release/1.2`) are ignored.
 */
export function detectIssueFromBranch(branch: string | undefined): number | undefined {
	if (!branch) {
		return undefined;
	}
	const match = /(?:^|[\/_-])(?:issues?[-_\/]?|gh[-_]?|#)?(?<number>\d{1,7})(?=$|[\/_-])/i.exec(branch);
	if (!match?.groups) {
		return undefined;
	}
	const value = Number(match.groups.number);
	return value > 0 ? value : undefined;
}

/**
 * Detects an issue referenced in a prompt: a GitHub issue or pull request URL, `owner/repo#123`, or `#123`.
 */
export function detectIssueFromText(text: string | undefined): IChatIssue | undefined {
	if (!text) {
		return undefined;
	}
	const url = /github\.com\/(?<repo>[\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(?<number>\d+)/i.exec(text);
	if (url?.groups) {
		return { number: Number(url.groups.number), repo: url.groups.repo };
	}
	const qualified = /(?:^|[\s(])(?<repo>[\w.-]+\/[\w.-]+)#(?<number>\d+)\b/.exec(text);
	if (qualified?.groups) {
		return { number: Number(qualified.groups.number), repo: qualified.groups.repo };
	}
	const plain = /(?:^|[\s(])#(?<number>\d+)\b/.exec(text);
	if (plain?.groups) {
		return { number: Number(plain.groups.number) };
	}
	return undefined;
}

/** Chat id used for requests that do not belong to a chat (titles, summaries, commit messages, ...). */
export const BACKGROUND_CHAT_ID = 'background';

/**
 * Returns what the user typed from the text of a prompt's user messages: the content of the
 * `<userRequest>` / `<user_query>` tag the agent prompt wraps it in, or the text without injected
 * context blocks (`<environment_info>`, `<context>`, ...).
 */
export function extractUserRequestText(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const tagged = /<(?<tag>userRequest|user_query)>(?<request>[\s\S]*?)<\/\k<tag>>/.exec(text);
	if (tagged?.groups) {
		return tagged.groups.request.trim() || undefined;
	}
	const stripped = text.replace(/<(?<tag>[A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\k<tag>>/g, '').trim();
	return stripped || undefined;
}

/** Parses user or agent input such as `123`, `#123`, `owner/repo#123` or an issue URL. */
export function parseIssueReference(value: string | number | undefined): IChatIssue | undefined {
	if (typeof value === 'number') {
		return Number.isInteger(value) && value > 0 ? { number: value } : undefined;
	}
	if (!value) {
		return undefined;
	}
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) {
		return { number: Number(trimmed) };
	}
	return detectIssueFromText(` ${trimmed}`);
}

/** Extracts `owner/repo` from a git remote URL (https or ssh). */
export function repoFromRemoteUrl(remoteUrl: string | undefined): string | undefined {
	if (!remoteUrl) {
		return undefined;
	}
	const match = /[/:](?<repo>[\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
	return match?.groups?.repo;
}

/** Human readable issue label, e.g. `creacoon/bliep#123` or `#123`. */
export function formatIssue(issue: IChatIssue | undefined, fallbackRepo?: string): string | undefined {
	if (!issue) {
		return undefined;
	}
	const repo = issue.repo ?? fallbackRepo;
	return repo ? `${repo}#${issue.number}` : `#${issue.number}`;
}

const MAX_METADATA_VALUE_LENGTH = 512;

function truncate(value: string | undefined, max = MAX_METADATA_VALUE_LENGTH): string | undefined {
	return value === undefined ? undefined : value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function compact<T extends Record<string, unknown>>(record: T): T {
	for (const key of Object.keys(record)) {
		if (record[key] === undefined || record[key] === '') {
			delete record[key];
		}
	}
	return record;
}

/** The string key-value metadata CreaEditor attaches to every gateway request. */
export function getTrackingMetadata(context: IChatWorkContext, requestId: string | undefined): Record<string, string> {
	const issue = formatIssue(context.issue, context.repo);
	return compact({
		creaeditor_chat: context.rootChatId,
		creaeditor_subchat: context.chatId !== context.rootChatId ? context.chatId : undefined,
		creaeditor_request: requestId,
		creaeditor_issue: issue,
		creaeditor_issue_source: context.issueSource,
		creaeditor_repo: context.repo,
		creaeditor_branch: truncate(context.branch),
		creaeditor_title: truncate(context.chatTitle),
		creaeditor_user: context.user,
	}) as Record<string, string>;
}

/** Tags used for LiteLLM spend tracking (`request_tags`). */
export function getTrackingTags(context: IChatWorkContext): string[] {
	const issue = formatIssue(context.issue, context.repo);
	return [
		'creaeditor',
		`chat:${context.rootChatId}`,
		...(issue ? [`issue:${issue}`] : []),
		...(context.repo ? [`repo:${context.repo}`] : []),
	];
}

/**
 * Body fields CreaEditor always sends. User configured request metadata is merged on top of these.
 * `api` is the wire API of the request; the Anthropic Messages API on OpenRouter only gets headers.
 */
export function getGatewayTrackingBody(kind: GatewayKind, api: 'chatCompletions' | 'responses' | 'messages', context: IChatWorkContext, requestId: string | undefined): Record<string, unknown> {
	const metadata = getTrackingMetadata(context, requestId);
	const issue = formatIssue(context.issue, context.repo);
	if (kind === 'openrouter') {
		if (api === 'messages') {
			return {};
		}
		return compact({
			session_id: context.rootChatId,
			user: context.user,
			metadata,
			trace: compact({
				trace_id: context.rootChatId,
				trace_name: truncate(issue ?? context.chatTitle, 256),
				span_name: context.chatId !== context.rootChatId ? 'subagent' : 'chat',
				generation_name: requestId,
			}),
		});
	}
	return compact({
		litellm_session_id: context.rootChatId,
		user: context.user,
		metadata: {
			...metadata,
			session_id: context.rootChatId,
			trace_id: context.rootChatId,
			generation_name: requestId,
			tags: getTrackingTags(context),
		},
	});
}

/** Headers CreaEditor always sends to a gateway. */
export function getGatewayTrackingHeaders(kind: GatewayKind, context: IChatWorkContext | undefined): Record<string, string> {
	if (kind === 'openrouter') {
		const headers: Record<string, string> = {
			'HTTP-Referer': 'https://creacoon.nl',
			'X-Title': 'CreaEditor',
		};
		if (context) {
			headers['x-session-id'] = context.rootChatId;
		}
		return headers;
	}
	return context ? { 'x-litellm-tags': getTrackingTags(context).join(',') } : {};
}

/** A cost reported by a gateway for one request. */
export interface IReportedCost {
	/** Cost in USD (or gateway credits, which are USD on both OpenRouter and LiteLLM). */
	readonly cost?: number;
	/** Gateway id of the request, used to look the cost up later (OpenRouter generation id, LiteLLM call id). */
	readonly gatewayRequestId?: string;
}

function toNumber(value: unknown): number | undefined {
	const number = typeof value === 'string' ? Number(value) : value;
	return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

/** Reads the cost a gateway reported in the response headers (LiteLLM). */
export function getCostFromHeaders(kind: GatewayKind, getHeader: (name: string) => string | null | undefined): IReportedCost {
	if (kind === 'litellm') {
		return {
			cost: toNumber(getHeader('x-litellm-response-cost') ?? undefined),
			gatewayRequestId: getHeader('x-litellm-call-id') ?? undefined,
		};
	}
	return {};
}

/** Reads the cost a gateway reported in the `usage` object of the response (OpenRouter `usage.cost`). */
export function getCostFromUsage(usage: unknown): number | undefined {
	if (!usage || typeof usage !== 'object') {
		return undefined;
	}
	return toNumber((usage as { cost?: unknown }).cost);
}
