/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: BYOK models on a CreaEditor Server without a window. On the laptop, the agent host's BYOK
// proxy forwards a Copilot session's requests to a window's language model API (the copilot extension
// calls OpenRouter/LiteLLM there). A server has no window, so this connection calls the gateway itself
// with the key a delegated chat brought along (`serverGatewayKeys.ts`): OpenAI-compatible
// `/chat/completions` (OpenRouter `https://openrouter.ai/api/v1`, LiteLLM `<url>/v1`). Before each
// request it checks the hard-stop budgets the laptop pushed, and it records every request in the
// server's cost ledger like the copilot extension does on the laptop (LiteLLM `x-litellm-response-cost`,
// OpenRouter `usage.cost` with `usage: { include: true }`).

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IByokLmBridgeConnection, IByokLmChatContext, IByokLmChatRequest, IByokLmChatResult, IByokLmContentPart, IByokLmModelInfo, IByokLmOutputItem } from '../../common/agentHostByokLm.js';
import { CostBudgetPeriod, ICostBudget, IGatewayCostEntryLike, IServerHardStop } from '../../common/creaeditorCosts.js';
import { IDelegationGatewayKey, IDelegationWorkContext } from '../../common/creaeditorDelegation.js';
import type { IGatewayCostRecord } from './gatewayCostLedger.js';

export const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';

/** The `/chat/completions` URL of a gateway key. */
export function getGatewayChatCompletionsUrl(key: Pick<IDelegationGatewayKey, 'providerId' | 'baseUrl'>): string {
	if (key.providerId === 'openrouter') {
		return `${(key.baseUrl ?? OPENROUTER_API_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
	}
	// Like the copilot extension: the proxy root without `/v1` or an API path, then `/v1`.
	let root = (key.baseUrl ?? '').trim().replace(/\/+$/, '');
	root = root.replace(/\/(chat\/completions|responses|messages)$/, '').replace(/\/v1$/, '');
	return `${root}/v1/chat/completions`;
}

/** The BYOK models of the delegated keys, as the agent host advertises them (`<vendor>/<group>/<id>`). */
export function getGatewayKeyModels(keys: readonly IDelegationGatewayKey[]): IByokLmModelInfo[] {
	return keys.flatMap(key => (key.models ?? []).map((model): IByokLmModelInfo => ({
		vendor: key.providerId,
		id: model.id,
		name: model.name ?? model.id,
		modelIdentifier: `${key.providerId}/${key.label}/${model.id}`,
		...(model.maxInputTokens ? { maxPromptTokens: model.maxInputTokens } : {}),
		...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
		...(model.supportsVision ? { supportsVision: true } : {}),
	})));
}

// --- Issue detection (mirrors `detectIssueFromBranch` of the copilot extension's `gatewayTracking.ts`) ---

const NON_JIRA_PREFIXES = new Set([
	'UTF', 'UCS', 'ISO', 'IEC', 'IEEE', 'ECMA', 'ES', 'RFC', 'CVE', 'CWE', 'GHSA', 'PEP', 'JSR', 'KB', 'MS',
	'SHA', 'MD', 'AES', 'RSA', 'ECDSA', 'HMAC', 'CRC', 'BASE', 'HTTP', 'HTTPS', 'TLS', 'SSL', 'IPV', 'IP', 'TCP', 'UDP',
	'GPT', 'CLAUDE', 'GEMINI', 'LLAMA', 'PHI', 'QWEN', 'MISTRAL', 'WIN', 'WINDOWS', 'MACOS', 'IOS', 'ANDROID', 'ARM', 'ARM64', 'X86', 'X64',
	'COVID', 'MP', 'PCI', 'SOC', 'GDPR', 'GPL', 'LGPL', 'AGPL', 'CC', 'BSD', 'APACHE', 'MIT',
	'ISSUE', 'ISSUES', 'GH', 'PR', 'FIX', 'FIXES', 'BUG', 'BUGFIX', 'HOTFIX', 'FEAT', 'FEATURE', 'RELEASE', 'CHORE', 'REFACTOR', 'DOCS', 'TEST', 'TESTS', 'WIP',
	'UPDATE', 'ADD', 'REMOVE', 'BUMP', 'VERSION', 'STEP', 'PHASE', 'PART', 'TOP', 'LEVEL', 'DAY', 'WEEK', 'SPRINT', 'NODE', 'PYTHON', 'JAVA', 'VUE', 'PHP', 'LARAVEL',
]);
const JIRA_KEY = '[A-Za-z][A-Za-z0-9_]{1,9}-[1-9]\\d{0,6}';

/** The issue of a branch, as the laptop's cost ledger records it. */
export function detectCostIssueFromBranch(branch: string | undefined): IGatewayCostEntryLike['issue'] | undefined {
	if (!branch) {
		return undefined;
	}
	const jiraPatterns = [
		new RegExp(`(?:^|\\/)(?<key>${JIRA_KEY})(?=$|[\\/_.-])`, 'gi'),
		new RegExp(`(?:^|[\\/_-])(?<key>[A-Z][A-Z0-9_]{1,9}-[1-9]\\d{0,6})(?=$|[\\/_.-])`, 'g'),
	];
	for (const pattern of jiraPatterns) {
		for (const match of branch.matchAll(pattern)) {
			const key = match.groups?.key.toUpperCase();
			if (key && !NON_JIRA_PREFIXES.has(key.slice(0, key.lastIndexOf('-')))) {
				return { kind: 'jira', key };
			}
		}
	}
	const match = /(?:^|[\/_-])(?:issues?[-_\/]?|gh[-_]?|#)?(?<number>\d{1,7})(?=$|[\/_-])/i.exec(branch);
	const value = match?.groups ? Number(match.groups.number) : 0;
	return value > 0 ? { number: value } : undefined;
}

/** `owner/repo` of a git remote URL. */
export function repoFromRemoteUrl(remoteUrl: string | undefined): string | undefined {
	return remoteUrl ? /[/:](?<repo>[\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())?.groups?.repo : undefined;
}

function formatIssueLabel(issue: IGatewayCostEntryLike['issue'], repo: string | undefined): string | undefined {
	if (!issue) {
		return undefined;
	}
	if (issue.kind === 'jira') {
		return issue.key;
	}
	return issue.number === undefined ? undefined : repo ? `${repo}#${issue.number}` : `#${issue.number}`;
}

// --- Budget message (the laptop's `formatBudgetRefusal`) ---

function formatUsd(value: number): string {
	return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

function formatPeriod(period: CostBudgetPeriod): string {
	switch (period) {
		case 'day': return localize('gatewayBudget.daily', "daily");
		case 'week': return localize('gatewayBudget.weekly', "weekly");
		case 'month': return localize('gatewayBudget.monthly', "monthly");
	}
}

function formatScope(budget: Pick<ICostBudget, 'scope' | 'value'>): string {
	switch (budget.scope) {
		case 'key': return /\bkey$/i.test(budget.value.trim()) ? localize('gatewayBudget.theNamedKey', "the {0}", budget.value) : localize('gatewayBudget.theKey', "the {0} key", budget.value);
		case 'issue': return localize('gatewayBudget.issue', "issue {0}", budget.value);
		case 'repo': return localize('gatewayBudget.repo', "repository {0}", budget.value);
	}
}

/** The chat error of a request refused by a hard stop (same text as on the laptop). */
export function formatServerBudgetRefusal(stop: IServerHardStop): string {
	return localize('gatewayBudget.refusal', "The {0} budget of {1} for {2} is used up. Raise it on the AI Costs page.", formatPeriod(stop.budget.period), formatUsd(stop.budget.amount), formatScope(stop.budget));
}

// --- Chat Completions translation ---

interface IChatCompletionsToolCall {
	readonly id: string;
	readonly type: 'function';
	readonly function: { readonly name: string; readonly arguments: string };
}

type ChatCompletionsContent = string | ({ readonly type: 'text'; readonly text: string } | { readonly type: 'image_url'; readonly image_url: { readonly url: string } })[];

interface IChatCompletionsMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	content: ChatCompletionsContent | null;
	tool_calls?: IChatCompletionsToolCall[];
	readonly tool_call_id?: string;
}

/** The body of a `/chat/completions` request for a bridge request (without the tracking fields). */
export function bridgeRequestToChatCompletions(request: IByokLmChatRequest, gatewayModel: string, vendor: string): Record<string, unknown> {
	const messages: IChatCompletionsMessage[] = [];
	if (request.instructions) {
		messages.push({ role: 'system', content: request.instructions });
	}
	const lastAssistant = (): IChatCompletionsMessage => {
		const last = messages.at(-1);
		if (last?.role === 'assistant') {
			return last;
		}
		const created: IChatCompletionsMessage = { role: 'assistant', content: null };
		messages.push(created);
		return created;
	};
	const toContent = (parts: readonly IByokLmContentPart[], allowImages: boolean): ChatCompletionsContent => {
		if (!allowImages || parts.every(part => part.type === 'text')) {
			return parts.filter(part => part.type === 'text').map(part => part.text).join('');
		}
		return parts.map(part => part.type === 'text' ? { type: 'text' as const, text: part.text } : { type: 'image_url' as const, image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
	};
	for (const item of request.input) {
		switch (item.type) {
			case 'message':
				if (item.role === 'assistant') {
					const text = toContent(item.content, false) as string;
					const last = messages.at(-1);
					if (last?.role === 'assistant' && !last.tool_calls && typeof last.content === 'string') {
						last.content += text;
					} else {
						messages.push({ role: 'assistant', content: text });
					}
				} else {
					messages.push({ role: item.role === 'user' ? 'user' : 'system', content: toContent(item.content, item.role === 'user') });
				}
				break;
			case 'reasoning':
				break; // Gateways do not take reasoning back over Chat Completions.
			case 'function_call':
			case 'custom_tool_call': {
				const assistant = lastAssistant();
				assistant.tool_calls ??= [];
				assistant.tool_calls.push({
					id: item.callId,
					type: 'function',
					function: { name: item.name, arguments: item.type === 'function_call' ? item.argumentsJson : JSON.stringify({ input: item.input }) },
				});
				break;
			}
			case 'function_call_output':
			case 'custom_tool_call_output':
				messages.push({ role: 'tool', tool_call_id: item.callId, content: item.output });
				break;
		}
	}
	const tools = (request.tools ?? []).map(tool => ({
		type: 'function',
		function: {
			name: tool.name,
			...(tool.description ? { description: tool.description } : {}),
			parameters: tool.type === 'function'
				? tool.parametersSchema ?? { type: 'object', properties: {} }
				: { type: 'object', properties: { input: { type: 'string', description: 'The raw input of the tool.' } }, required: ['input'] },
		},
	}));
	const options = request.modelOptions ?? {};
	return {
		model: gatewayModel,
		messages,
		stream: false,
		...(tools.length ? { tools } : {}),
		...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
		...(typeof options.top_p === 'number' ? { top_p: options.top_p } : {}),
		...(typeof options.max_tokens === 'number' ? { max_tokens: options.max_tokens } : {}),
		...(request.reasoningEffort ? (vendor === 'openrouter' ? { reasoning: { effort: request.reasoningEffort } } : { reasoning_effort: request.reasoningEffort }) : {}),
	};
}

interface IChatCompletionsResponse {
	readonly id?: string;
	readonly choices?: readonly {
		readonly message?: {
			readonly content?: string | null;
			readonly reasoning?: string | null;
			readonly reasoning_content?: string | null;
			readonly tool_calls?: readonly { readonly id?: string; readonly function?: { readonly name?: string; readonly arguments?: string } }[];
		};
	}[];
	readonly usage?: {
		readonly prompt_tokens?: number;
		readonly completion_tokens?: number;
		readonly cost?: number | string;
		readonly prompt_tokens_details?: { readonly cached_tokens?: number };
		readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
	};
}

/** The bridge result of a `/chat/completions` answer; tools of `customTools` come back as custom tool calls. */
export function chatCompletionsToBridgeResult(response: IChatCompletionsResponse, customTools: ReadonlySet<string>): IByokLmChatResult {
	const message = response.choices?.[0]?.message;
	const output: IByokLmOutputItem[] = [];
	const reasoning = message?.reasoning ?? message?.reasoning_content;
	if (reasoning) {
		output.push({ type: 'reasoning', summary: [reasoning] });
	}
	if (message?.content) {
		output.push({ type: 'message', content: [{ type: 'text', text: message.content }] });
	}
	let index = 0;
	for (const call of message?.tool_calls ?? []) {
		const name = call.function?.name ?? '';
		const callId = call.id || `call_${Date.now().toString(36)}_${index++}`;
		const args = call.function?.arguments || '{}';
		if (customTools.has(name)) {
			let input = args;
			try {
				const parsed = JSON.parse(args) as { input?: unknown };
				input = typeof parsed.input === 'string' ? parsed.input : args;
			} catch {
				// Not JSON: pass it on as it is.
			}
			output.push({ type: 'custom_tool_call', callId, name, input });
		} else {
			output.push({ type: 'function_call', callId, name, argumentsJson: args });
		}
	}
	const usage = response.usage;
	return {
		output,
		...(response.id ? { responseId: response.id } : {}),
		...(usage ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, reasoningTokens: usage.completion_tokens_details?.reasoning_tokens } } : {}),
	};
}

function toNumber(value: unknown): number | undefined {
	const number = typeof value === 'string' ? Number(value) : value;
	return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
}

// --- The connection ---

/** What the connection needs from the server; replaced in tests. */
export interface IGatewayDirectConnectionHost {
	/** The delegated keys (read on every call: a new delegation may add one). */
	readonly getKeys: () => readonly IDelegationGatewayKey[];
	readonly onDidChangeKeys: Event<void>;
	/** The delegated chat whose worktree holds a working directory. */
	readonly findWorkContext: (workingDirectory: string | undefined) => IDelegationWorkContext | undefined;
	/** The used up hard-stop budget for a request, if any. */
	readonly findHardStop: (request: { readonly providerGroup?: string; readonly issue?: string; readonly repo?: string }) => IServerHardStop | undefined;
	/** Records a request in the cost ledger. */
	readonly recordCost: ((entry: IGatewayCostRecord) => void) | undefined;
	readonly fetch: typeof fetch;
	readonly log: (message: string) => void;
}

/**
 * The BYOK bridge connection of a CreaEditor Server: serves the models of the delegated gateway keys
 * and runs requests against the gateways directly.
 */
export class GatewayDirectConnection implements IByokLmBridgeConnection, IDisposable {

	private readonly _onDidChangeModels = new Emitter<IByokLmModelInfo[]>();
	private readonly _keysListener: IDisposable;

	constructor(private readonly _host: IGatewayDirectConnectionHost) {
		this._keysListener = _host.onDidChangeKeys(() => this._onDidChangeModels.fire(this.models));
	}

	get models(): IByokLmModelInfo[] {
		return getGatewayKeyModels(this._host.getKeys());
	}

	/** Emits the current models on subscribe, then on every change (like a window's bridge). */
	readonly onDidChangeModels: Event<IByokLmModelInfo[]> = (listener, thisArgs, disposables) => {
		const subscription = this._onDidChangeModels.event(listener, thisArgs, disposables);
		listener.call(thisArgs, this.models);
		return subscription;
	};

	async chat(request: IByokLmChatRequest, context?: IByokLmChatContext): Promise<IByokLmChatResult> {
		const resolved = this._resolveModel(request.vendor, request.modelId);
		if (!resolved) {
			return { output: [], error: localize('gatewayDirect.noKey', "This server has no {0} key for model \"{1}\". Delegate a chat that uses this key to the server first.", request.vendor, request.modelId) };
		}
		const { key, gatewayModel } = resolved;
		const work = this._host.findWorkContext(context?.workingDirectory);
		const issue = detectCostIssueFromBranch(work?.branch);
		const issueLabel = formatIssueLabel(issue, work?.repo);

		const stop = this._host.findHardStop({ providerGroup: key.label, ...(issueLabel ? { issue: issueLabel } : {}), ...(work?.repo ? { repo: work.repo } : {}) });
		if (stop) {
			this._host.log(`[GatewayDirect] Refused a request: budget ${stop.budget.id} is used up.`);
			return { output: [], error: formatServerBudgetRefusal(stop) };
		}

		const chatId = context?.sessionId ?? 'background';
		const url = getGatewayChatCompletionsUrl(key);
		const body = {
			...bridgeRequestToChatCompletions(request, gatewayModel, key.providerId),
			...trackingBody(key.providerId, chatId, work, issueLabel),
		};
		const response = await this._host.fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${key.key}`,
				...trackingHeaders(key.providerId, chatId, work, issueLabel),
			},
			body: JSON.stringify(body),
			...(context?.signal ? { signal: context.signal } : {}),
		});
		const text = await response.text();
		if (!response.ok) {
			let message = text.slice(0, 500);
			try {
				const parsed = JSON.parse(text) as { error?: { message?: string } | string };
				message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? message;
			} catch {
				// Not JSON.
			}
			return { output: [], error: localize('gatewayDirect.failed', "{0} answered {1}: {2}", key.providerId === 'openrouter' ? 'OpenRouter' : 'LiteLLM', response.status, message) };
		}
		let parsed: IChatCompletionsResponse;
		try {
			parsed = JSON.parse(text) as IChatCompletionsResponse;
		} catch {
			return { output: [], error: localize('gatewayDirect.invalid', "The gateway's answer could not be read.") };
		}
		const customTools = new Set((request.tools ?? []).filter(tool => tool.type === 'custom').map(tool => tool.name));
		const result = chatCompletionsToBridgeResult(parsed, customTools);

		const headerCost = key.providerId === 'litellm' ? toNumber(response.headers.get('x-litellm-response-cost') ?? undefined) : undefined;
		const usageCost = headerCost === undefined ? toNumber(parsed.usage?.cost) : undefined;
		const cost = headerCost ?? usageCost;
		try {
			this._host.recordCost?.({
				chatId,
				rootChatId: chatId,
				...(work?.title ? { chatTitle: work.title } : {}),
				...(issue ? { issue, issueSource: 'branch' } : {}),
				...(work?.repo ? { repo: work.repo } : {}),
				...(work?.branch ? { branch: work.branch } : {}),
				gateway: key.providerId === 'openrouter' ? 'openrouter' : 'litellm',
				gatewayHost: new URL(url).host,
				providerGroup: key.label,
				model: gatewayModel,
				gatewayRequestId: (key.providerId === 'litellm' ? response.headers.get('x-litellm-call-id') : undefined) ?? parsed.id,
				promptTokens: parsed.usage?.prompt_tokens,
				completionTokens: parsed.usage?.completion_tokens,
				cachedTokens: parsed.usage?.prompt_tokens_details?.cached_tokens,
				cost,
				...(cost !== undefined ? { costSource: headerCost !== undefined ? 'header' : 'response' } : {}),
			});
		} catch (error) {
			this._host.log(`[GatewayDirect] Recording the cost failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		return result;
	}

	/** The key and the gateway's model id of a selection id (`<group>/<model>`). */
	private _resolveModel(vendor: string, selectionId: string): { readonly key: IDelegationGatewayKey; readonly gatewayModel: string } | undefined {
		let best: IDelegationGatewayKey | undefined;
		for (const key of this._host.getKeys()) {
			if (key.providerId === vendor && selectionId.startsWith(`${key.label}/`) && (!best || key.label.length > best.label.length)) {
				best = key;
			}
		}
		return best ? { key: best, gatewayModel: selectionId.slice(best.label.length + 1) } : undefined;
	}

	dispose(): void {
		this._keysListener.dispose();
		this._onDidChangeModels.dispose();
	}
}

function trackingBody(vendor: string, chatId: string, work: IDelegationWorkContext | undefined, issue: string | undefined): Record<string, unknown> {
	const metadata = Object.fromEntries(Object.entries({
		creaeditor_chat: chatId,
		creaeditor_issue: issue,
		creaeditor_repo: work?.repo,
		creaeditor_branch: work?.branch?.slice(0, 512),
		creaeditor_title: work?.title?.slice(0, 512),
	}).filter(([, value]) => !!value));
	if (vendor === 'openrouter') {
		return { usage: { include: true }, session_id: chatId, metadata, trace: { trace_id: chatId, span_name: 'chat', ...(issue ?? work?.title ? { trace_name: (issue ?? work?.title)!.slice(0, 256) } : {}) } };
	}
	return { litellm_session_id: chatId, metadata: { ...metadata, session_id: chatId, trace_id: chatId, tags: trackingTags(chatId, work, issue) } };
}

function trackingTags(chatId: string, work: IDelegationWorkContext | undefined, issue: string | undefined): string[] {
	return ['creaeditor', `chat:${chatId}`, ...(issue ? [`issue:${issue}`] : []), ...(work?.repo ? [`repo:${work.repo}`] : [])];
}

function trackingHeaders(vendor: string, chatId: string, work: IDelegationWorkContext | undefined, issue: string | undefined): Record<string, string> {
	return vendor === 'openrouter'
		? { 'HTTP-Referer': 'https://creacoon.nl', 'X-Title': 'CreaEditor', 'x-session-id': chatId }
		: { 'x-litellm-tags': trackingTags(chatId, work, issue).join(',') };
}
