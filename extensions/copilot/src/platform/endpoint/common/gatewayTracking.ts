/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: tracking metadata that is always sent to LLM gateways (OpenRouter, LiteLLM) so the
// cost of every chat and issue can be attributed, plus the parsing of the cost they report back.

/** The kind of LLM gateway a BYOK endpoint talks to. */
export type GatewayKind = 'openrouter' | 'litellm';

/**
 * A GitHub (or other forge) issue a chat is working on. `kind` is left out by detection, and cost
 * entries persisted before Jira support never have it, so a missing `kind` means a GitHub issue.
 */
export interface IGitHubIssue {
	readonly kind?: 'github';
	readonly number: number;
	/** `owner/repo`, when known. */
	readonly repo?: string;
}

/** A Jira (Atlassian Cloud) issue a chat is working on. */
export interface IJiraIssue {
	readonly kind: 'jira';
	/** Upper case issue key, e.g. `PROJ-123`. */
	readonly key: string;
	/** Host of the Jira site, e.g. `acme.atlassian.net`, when known. */
	readonly site?: string;
}

/** The issue a chat is working on. */
export type IChatIssue = IGitHubIssue | IJiraIssue;

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
 * Whether models of this language model vendor run on a named API key of an LLM gateway (one provider
 * group per key). A chat on such a model never runs a subagent on another key, so subagent model
 * overrides are ignored for it: the extension cannot tell which key a model of the same vendor uses.
 */
export function isKeyScopedGatewayVendor(vendor: string | undefined): boolean {
	return vendor === 'openrouter' || vendor === 'litellm';
}

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
 * Upper case prefixes of `WORD-123` tokens that are not Jira project keys: standards, encodings,
 * hashes, model and protocol names, and words used in branch names (`issue-12`, `gh-7`, `fix-2`).
 */
const NON_JIRA_PREFIXES = new Set([
	'UTF', 'UCS', 'ISO', 'IEC', 'IEEE', 'ECMA', 'ES', 'RFC', 'CVE', 'CWE', 'GHSA', 'PEP', 'JSR', 'KB', 'MS',
	'SHA', 'MD', 'AES', 'RSA', 'ECDSA', 'HMAC', 'CRC', 'BASE', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'IPV', 'IP', 'TCP', 'UDP',
	'GPT', 'CLAUDE', 'GEMINI', 'LLAMA', 'PHI', 'QWEN', 'MISTRAL', 'WIN', 'WINDOWS', 'MACOS', 'IOS', 'ANDROID', 'ARM', 'ARM64', 'X86', 'X64',
	'COVID', 'MP', 'PCI', 'SOC', 'GDPR', 'GPL', 'LGPL', 'AGPL', 'CC', 'BSD', 'APACHE', 'MIT',
	'ISSUE', 'ISSUES', 'GH', 'PR', 'FIX', 'FIXES', 'BUG', 'BUGFIX', 'HOTFIX', 'FEAT', 'FEATURE', 'RELEASE', 'CHORE', 'REFACTOR', 'DOCS', 'TEST', 'TESTS', 'WIP',
	'UPDATE', 'ADD', 'REMOVE', 'BUMP', 'VERSION', 'STEP', 'PHASE', 'PART', 'TOP', 'LEVEL', 'DAY', 'WEEK', 'SPRINT', 'NODE', 'PYTHON', 'JAVA', 'VUE', 'PHP', 'LARAVEL',
]);

/**
 * Jira project key and issue number: the key is 2-10 letters, digits or underscores starting with a
 * letter, the number has no leading zero.
 */
const JIRA_KEY = '[A-Za-z][A-Za-z0-9_]{1,9}-[1-9]\\d{0,6}';

/**
 * A Jira issue for a key, normalized to upper case. Returns `undefined` when the project key is a known
 * non-ticket prefix such as the `UTF` of `UTF-8`, unless the key comes from an explicit Jira URL.
 */
function jiraIssue(key: string, site?: string, fromUrl = false): IJiraIssue | undefined {
	const upper = key.toUpperCase();
	if (!fromUrl && NON_JIRA_PREFIXES.has(upper.slice(0, upper.lastIndexOf('-')))) {
		return undefined;
	}
	return site ? { kind: 'jira', key: upper, site: site.toLowerCase() } : { kind: 'jira', key: upper };
}

/** Returns `true` when the issue is a Jira issue (anything else, including persisted legacy entries, is GitHub). */
export function isJiraIssue(issue: IChatIssue | undefined): issue is IJiraIssue {
	return issue?.kind === 'jira';
}

/**
 * Detects an issue in a git branch name.
 *
 * A Jira key wins over a number, since `PROJ-123` contains one. Keys are matched case-insensitively
 * (branches are often lower case) and normalized to upper case, but only at the start of the branch or
 * of a path segment (`PROJ-123-fix-login`, `feature/PROJ-123`, `jibbe/abc-42-foo`); an upper case key is
 * also found after a `-` or `_` (`fix-PROJ-7`). Prefixes in {@link NON_JIRA_PREFIXES} never count.
 *
 * Otherwise a GitHub issue number is detected, e.g. `123-fix-login`, `issue/123`, `feature/GH-45-x`,
 * `jibbe/issue-45-foo` or `fix/#12`. Version-like segments (`release/1.2`) are ignored.
 */
export function detectIssueFromBranch(branch: string | undefined): IChatIssue | undefined {
	if (!branch) {
		return undefined;
	}
	const jiraPatterns = [
		new RegExp(`(?:^|\\/)(?<key>${JIRA_KEY})(?=$|[\\/_.-])`, 'gi'),
		new RegExp(`(?:^|[\\/_-])(?<key>[A-Z][A-Z0-9_]{1,9}-[1-9]\\d{0,6})(?=$|[\\/_.-])`, 'g'),
	];
	for (const pattern of jiraPatterns) {
		for (const match of branch.matchAll(pattern)) {
			const issue = match.groups && jiraIssue(match.groups.key);
			if (issue) {
				return issue;
			}
		}
	}
	const match = /(?:^|[\/_-])(?:issues?[-_\/]?|gh[-_]?|#)?(?<number>\d{1,7})(?=$|[\/_-])/i.exec(branch);
	if (!match?.groups) {
		return undefined;
	}
	const value = Number(match.groups.number);
	return value > 0 ? { number: value } : undefined;
}

/** A GitHub issue or pull request URL. */
const GITHUB_URL = /github\.com\/(?<repo>[\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(?<number>\d+)/i;

/**
 * A Jira issue URL: `https://<site>/browse/PROJ-1`, `.../issues/PROJ-1` or a board/search URL with
 * `selectedIssue=PROJ-1`.
 */
const JIRA_URL = new RegExp(`https?:\\/\\/(?<site>[\\w.-]+(?::\\d+)?)(?:\\/[^\\s?#]*)?(?:\\/browse\\/|\\/issues\\/|\\?(?:[^\\s#]*&)?selectedIssue=)(?<key>${JIRA_KEY})(?![\\w-])`, 'i');

/** An upper case Jira key in prose, not part of a path, URL, longer word or version (`GPT-5.1`). */
const JIRA_KEY_IN_TEXT = /(?<![\w\/.:#-])(?<key>[A-Z][A-Z0-9_]{1,9}-[1-9]\d{0,6})(?![\w-]|\.\d)/g;

/**
 * Detects an issue referenced in a prompt, in this order of precedence:
 * 1. the first GitHub issue/pull request URL or Jira issue URL (`/browse/PROJ-1`, `selectedIssue=PROJ-1`),
 * 2. `owner/repo#123`,
 * 3. an upper case Jira key such as `PROJ-123` (keys with a prefix in {@link NON_JIRA_PREFIXES}, like
 *    `UTF-8` or `SHA-256`, are ignored),
 * 4. `#123`.
 */
export function detectIssueFromText(text: string | undefined): IChatIssue | undefined {
	if (!text) {
		return undefined;
	}
	const githubUrl = GITHUB_URL.exec(text);
	const jiraUrl = JIRA_URL.exec(text);
	if (jiraUrl?.groups && (!githubUrl || jiraUrl.index < githubUrl.index)) {
		return jiraIssue(jiraUrl.groups.key, jiraUrl.groups.site, true);
	}
	if (githubUrl?.groups) {
		return { number: Number(githubUrl.groups.number), repo: githubUrl.groups.repo };
	}
	const qualified = /(?:^|[\s(])(?<repo>[\w.-]+\/[\w.-]+)#(?<number>\d+)\b/.exec(text);
	if (qualified?.groups) {
		return { number: Number(qualified.groups.number), repo: qualified.groups.repo };
	}
	for (const match of text.matchAll(JIRA_KEY_IN_TEXT)) {
		const issue = match.groups && jiraIssue(match.groups.key);
		if (issue) {
			return issue;
		}
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

/**
 * Parses user or agent input such as `123`, `#123`, `owner/repo#123`, a GitHub issue URL, a Jira key
 * (`PROJ-123`, any case, not a {@link NON_JIRA_PREFIXES} token) or a Jira issue URL.
 */
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
	if (new RegExp(`^${JIRA_KEY}$`).test(trimmed)) {
		return jiraIssue(trimmed);
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

/** Human readable issue label, e.g. `creacoon/bliep#123`, `#123` or `PROJ-123`. */
export function formatIssue(issue: IChatIssue | undefined, fallbackRepo?: string): string | undefined {
	if (!issue) {
		return undefined;
	}
	if (isJiraIssue(issue)) {
		return issue.key;
	}
	const repo = issue.repo ?? fallbackRepo;
	return repo ? `${repo}#${issue.number}` : `#${issue.number}`;
}

/** Web URL of an issue, when known: `https://<site>/browse/<KEY>` for a Jira issue whose site is known. */
export function getIssueUrl(issue: IChatIssue | undefined): string | undefined {
	return isJiraIssue(issue) && issue.site ? `https://${issue.site}/browse/${encodeURIComponent(issue.key)}` : undefined;
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
