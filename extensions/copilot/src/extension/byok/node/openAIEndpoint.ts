/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Raw } from '@vscode/prompt-tsx';
import type { CancellationToken } from 'vscode';
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { ChatFetchResponseType, ChatResponse } from '../../../platform/chat/common/commonTypes';
import { ConfigKey, IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { isKimiFamily } from '../../../platform/endpoint/common/chatModelCapabilities';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IChatModelInformation } from '../../../platform/endpoint/common/endpointProvider';
import { BACKGROUND_CHAT_ID, extractUserRequestText, formatIssue, GatewayKind, gatewayKindFromUrl, getCostFromHeaders, getCostFromUsage, getGatewayTrackingBody, getGatewayTrackingHeaders, IChatWorkContext, normalizeGatewayRoot } from '../../../platform/endpoint/common/gatewayTracking';
import { IGatewayTrackingService } from '../../../platform/endpoint/common/gatewayTrackingService';
import { applyRequestMetadataToBody, expandRequestMetadata } from '../../../platform/endpoint/common/requestMetadata';
import { ChatEndpoint, normalizeKimiToolCallIds } from '../../../platform/endpoint/node/chatEndpoint';
import { ILogService } from '../../../platform/log/common/logService';
import { FinishedCallback, isOpenAiFunctionTool } from '../../../platform/networking/common/fetch';
import { IFetcherService, Response } from '../../../platform/networking/common/fetcherService';
import { createCapiRequestBody, IChatEndpoint, ICreateEndpointBodyOptions, IEndpointBody, IMakeChatRequestOptions } from '../../../platform/networking/common/networking';
import { ChatCompletion, RawMessageConversionCallback } from '../../../platform/networking/common/openai';
import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';
import { getCurrentCapturingToken } from '../../../platform/requestLogger/node/requestLogger';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry';
import { TelemetryData } from '../../../platform/telemetry/common/telemetryData';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { AsyncIterableObject, timeout } from '../../../util/vs/base/common/async';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BUDGETS_SETTING, formatBudgetRefusal } from '../common/gatewayBudgetMessages';
import { findHardStopBudget, parseCostBudgets } from '../common/gatewayCostsAnalysis';

function hydrateBYOKErrorMessages(response: ChatResponse): ChatResponse {
	if (response.type === ChatFetchResponseType.Failed && response.streamError) {
		return {
			type: response.type,
			requestId: response.requestId,
			serverRequestId: response.serverRequestId,
			// A stream error carrying no message has no diagnostic value, so keep the
			// original reason rather than replacing it with a hollow serialized struct.
			reason: response.streamError.message ? JSON.stringify(response.streamError) : response.reason,
		};
	} else if (response.type === ChatFetchResponseType.RateLimited) {
		return {
			type: response.type,
			requestId: response.requestId,
			serverRequestId: response.serverRequestId,
			reason: response.capiError ? 'Rate limit exceeded\n\n' + JSON.stringify(response.capiError) : 'Rate limit exceeded',
			rateLimitKey: '',
			retryAfter: undefined,
			isAuto: false,
			capiError: response.capiError
		};
	}
	return response;
}

/**
 * Checks to see if a given endpoint is a BYOK model.
 * @param endpoint The endpoint to check if it's a BYOK model
 * @returns 1 if client side byok, 2 if server side byok, -1 if not a byok model
 */
export function isBYOKModel(endpoint: IChatEndpoint | undefined): number {
	if (!endpoint) {
		return -1;
	}
	return (endpoint instanceof OpenAIEndpoint || endpoint.isExtensionContributed) ? 1 : (endpoint.customModel ? 2 : -1);
}

export class OpenAIEndpoint extends ChatEndpoint {
	// Reserved headers that cannot be overridden for security and functionality reasons
	// Including forbidden request headers: https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_request_header
	private static readonly _reservedHeaders: ReadonlySet<string> = new Set([
		// Forbidden Request Headers
		'accept-charset',
		'accept-encoding',
		'access-control-request-headers',
		'access-control-request-method',
		'connection',
		'content-length',
		'cookie',
		'date',
		'dnt',
		'expect',
		'host',
		'keep-alive',
		'origin',
		'permissions-policy',
		'referer',
		'te',
		'trailer',
		'transfer-encoding',
		'upgrade',
		'user-agent',
		'via',
		// Forwarding & Routing
		'forwarded',
		'x-forwarded-for',
		'x-forwarded-host',
		'x-forwarded-proto',
		// Others
		'api-key',
		'authorization',
		'content-type',
		'openai-intent',
		'x-github-api-version',
		'x-initiator',
		'x-interaction-id',
		'x-interaction-type',
		'x-onbehalf-extension-id',
		'x-request-id',
		'x-vscode-user-agent-library-version',
		// Pattern-based forbidden headers are checked separately:
		// - 'proxy-*' headers (handled in sanitization logic)
		// - 'sec-*' headers (handled in sanitization logic)
		// - 'x-http-method*' with forbidden methods CONNECT, TRACE, TRACK (handled in sanitization logic)
	]);

	// RFC 7230 compliant header name pattern: token characters only
	private static readonly _validHeaderNamePattern = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

	// Maximum limits to prevent abuse
	private static readonly _maxHeaderNameLength = 256;
	private static readonly _maxHeaderValueLength = 8192;
	private static readonly _maxCustomHeaderCount = 20;

	protected readonly _customHeaders: Record<string, string>;
	constructor(
		_modelMetadata: IChatModelInformation,
		protected readonly _apiKey: string,
		protected readonly _modelUrl: string,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService protected instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,
		@ILogService protected logService: ILogService,
		@IGatewayTrackingService private readonly _gatewayTrackingService: IGatewayTrackingService,
		@IFetcherService private readonly _gatewayFetcherService: IFetcherService,
	) {
		super(
			_modelMetadata,
			domainService,
			chatMLFetcher,
			tokenizerProvider,
			instantiationService,
			configurationService,
			expService,
			chatWebSocketService,
			logService
		);
		this._customHeaders = this._sanitizeCustomHeaders(_modelMetadata.requestHeaders);
	}

	/**
	 * BYOK endpoints supply their own credential (`api-key` / `Authorization`)
	 * via {@link getExtraHeaders}, so the chat fetcher must not fall back to the
	 * CAPI Copilot bearer token nor raise a missing-key error for these requests.
	 */
	public readonly ownsAuthorization = true;

	/**
	 * BYOK gateways (e.g. LiteLLM) may not forward `prompt_cache_breakpoint` markers, so explicit
	 * Responses API prompt caching stays off unless the user opts in.
	 */
	public readonly promptCacheBreakpointsRequireOptIn = true;

	protected override getCompletionsCallback(): RawMessageConversionCallback {
		const supportsThinking = !!this.modelMetadata.capabilities.supports.thinking;
		return (out, data) => {
			if (data?.id) {
				out.cot_id = data.id;
				const text = Array.isArray(data.text) ? data.text.join('') : data.text;
				out.cot_summary = text;
				if (supportsThinking) {
					out.reasoning_content = text;
					out.reasoning = text;
				}
			}
		};
	}

	protected _isReservedHeader(lowerKey: string): boolean {
		return OpenAIEndpoint._reservedHeaders.has(lowerKey);
	}

	private _sanitizeCustomHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
		if (!headers) {
			return {};
		}

		const entries = Object.entries(headers);

		if (entries.length > OpenAIEndpoint._maxCustomHeaderCount) {
			this.logService.warn(`[OpenAIEndpoint] Model '${this.modelMetadata.id}' has ${entries.length} custom headers, exceeding limit of ${OpenAIEndpoint._maxCustomHeaderCount}. Only first ${OpenAIEndpoint._maxCustomHeaderCount} will be processed.`);
		}

		const sanitized: Record<string, string> = {};
		let processedCount = 0;

		for (const [rawKey, rawValue] of entries) {
			if (processedCount >= OpenAIEndpoint._maxCustomHeaderCount) {
				break;
			}

			const key = rawKey.trim();
			if (!key) {
				this.logService.warn(`[OpenAIEndpoint] Model '${this.modelMetadata.id}' has empty header name, skipping.`);
				continue;
			}

			if (key.length > OpenAIEndpoint._maxHeaderNameLength) {
				this.logService.warn(`[OpenAIEndpoint] Model '${this.modelMetadata.id}' has header name exceeding ${OpenAIEndpoint._maxHeaderNameLength} characters, skipping.`);
				continue;
			}

			if (!OpenAIEndpoint._validHeaderNamePattern.test(key)) {
				this.logService.warn(`[OpenAIEndpoint] Model '${this.modelMetadata.id}' has invalid header name format: '${key}', Skipping.`);
				continue;
			}

			const lowerKey = key.toLowerCase();
			if (this._isReservedHeader(lowerKey)) {
				this.logService.warn(`[OpenAIEndpoint] Model '${this.modelMetadata.id}' attempted to override reserved header '${key}', skipping.`);
				continue;
			}

			// Check for pattern-based forbidden headers
			if (lowerKey.startsWith('proxy-') || lowerKey.startsWith('sec-')) {
				this.logService.warn(`[OpenAIEndpoint] Model '${this.modelMetadata.id}' attempted to set forbidden header pattern '${key}', skipping.`);
				continue;
			}

			// Check for X-HTTP-Method* headers with forbidden methods
			if ((lowerKey === 'x-http-method' || lowerKey === 'x-http-method-override' || lowerKey === 'x-method-override')) {
				const forbiddenMethods = ['connect', 'trace', 'track'];
				const methodValue = String(rawValue).toLowerCase().trim();
				if (forbiddenMethods.includes(methodValue)) {
					this.logService.warn(`[OpenAIEndpoint] Model '${this.modelMetadata.id}' attempted to set forbidden method '${methodValue}' in header '${key}', skipping.`);
					continue;
				}
			}

			const sanitizedValue = this._sanitizeHeaderValue(rawValue);
			if (sanitizedValue === undefined) {
				this.logService.warn(`[OpenAIEndpoint] Model '${this.modelMetadata.id}' has invalid value for header '${key}': '${rawValue}', skipping.`);
				continue;
			}

			sanitized[key] = sanitizedValue;
			processedCount++;
		}

		return sanitized;
	}

	private _sanitizeHeaderValue(value: unknown): string | undefined {
		if (typeof value !== 'string') {
			return undefined;
		}

		const trimmed = value.trim();

		if (trimmed.length > OpenAIEndpoint._maxHeaderValueLength) {
			return undefined;
		}

		// Disallow control characters including CR, LF, and others (0x00-0x1F, 0x7F)
		// This prevents HTTP header injection and response splitting attacks
		if (/[\x00-\x1F\x7F]/.test(trimmed)) {
			return undefined;
		}

		// Additional check for potential Unicode issues
		// Reject headers with bidirectional override characters or zero-width characters
		if (/[\u200B-\u200D\u202A-\u202E\uFEFF]/.test(trimmed)) {
			return undefined;
		}

		return trimmed;
	}

	/**
	 * Per-request values for `${sessionId}` / `${requestId}` placeholders in the configured
	 * request metadata. Captured when the body is built and reused for the headers of that request.
	 */
	private _requestMetadataVariables: Record<string, string | undefined> = {};

	/** CreaEditor: the LLM gateway this endpoint talks to, if any (set by the provider or derived from the URL). */
	private _gatewayKind: GatewayKind | undefined;
	/** CreaEditor: the BYOK provider group (API key) the model belongs to, for the cost ledger. */
	private _providerGroup: string | undefined;
	/** CreaEditor: the work context of the request this endpoint instance last built a body for. */
	private _workContext: IChatWorkContext | undefined;

	/** CreaEditor: marks this endpoint as talking to an LLM gateway, which enables chat/issue tracking and cost capture. */
	setGateway(kind: GatewayKind | undefined, providerGroup?: string): void {
		this._gatewayKind = kind;
		this._providerGroup = providerGroup;
	}

	get gatewayKind(): GatewayKind | undefined {
		return this._gatewayKind ?? gatewayKindFromUrl(this._modelUrl);
	}

	override createRequestBody(options: ICreateEndpointBodyOptions): IEndpointBody {
		let body = this._createRequestBodyCore(options);
		const token = getCurrentCapturingToken();
		// Requests outside a chat (titles, summaries, ...) are tracked as background requests.
		const chatId = token?.chatSessionId ?? options.conversationId ?? BACKGROUND_CHAT_ID;
		this._requestMetadataVariables = { sessionId: options.conversationId ?? chatId, requestId: options.requestId };

		// CreaEditor: always tell the gateway which chat and issue the request belongs to.
		const gateway = this.gatewayKind;
		if (gateway && chatId) {
			const rootChatId = token?.parentChatSessionId ?? chatId;
			this._workContext = this._gatewayTrackingService.getWorkContext(chatId, rootChatId, extractUserRequestText(getUserMessagesText(options.messages)));
			const api = this.useResponsesApi ? 'responses' : this.useMessagesApi ? 'messages' : 'chatCompletions';
			body = applyRequestMetadataToBody(body, getGatewayTrackingBody(gateway, api, this._workContext, options.requestId));
		}

		const metadata = this.modelMetadata.requestMetadata;
		if (!metadata?.body) {
			return body;
		}
		return applyRequestMetadataToBody(body, expandRequestMetadata(metadata, this._requestMetadataVariables).body);
	}

	private _createRequestBodyCore(options: ICreateEndpointBodyOptions): IEndpointBody {
		if (this.useResponsesApi) {
			// Handle Responses API: customize the body directly
			const zdr = !!this.modelMetadata.zeroDataRetentionEnabled;
			// When ZDR is on the server refuses to retain responses, so we must
			// not chain via `previous_response_id` and must not ask it to `store`.
			options.ignoreStatefulMarker = options.ignoreStatefulMarker || zdr;
			const body = super.createRequestBody(options);
			body.store = !zdr;
			body.n = undefined;
			body.stream_options = undefined;
			if (!this.modelMetadata.capabilities.supports.thinking) {
				body.reasoning = undefined;
				body.include = undefined;
			}
			if (body.previous_response_id && (!body.previous_response_id.startsWith('resp_') || zdr)) {
				// Don't use a response ID from CAPI or when zero data retention is enabled
				body.previous_response_id = undefined;
			}
			this._applyReasoningEffort(body, options);
			return this._applyConfiguredModelOptions(body, options);
		} else if (this.useMessagesApi) {
			// Delegate to base ChatEndpoint for Messages API dispatch
			const body = super.createRequestBody(options);
			this._applyReasoningEffort(body, options);
			return this._applyConfiguredModelOptions(body, options);
		} else {
			const body = createCapiRequestBody(options, this.model, this.getCompletionsCallback());
			if (body.messages && isKimiFamily(this)) {
				body.messages = normalizeKimiToolCallIds(body.messages);
			}
			this._applyReasoningEffort(body, options);
			return this._applyConfiguredModelOptions(body, options);
		}
	}

	private _applyConfiguredModelOptions(body: IEndpointBody, options: ICreateEndpointBodyOptions): IEndpointBody {
		const modelOptions = this.modelMetadata.modelOptions;
		if (!modelOptions) {
			return body;
		}

		for (const key of ['temperature', 'top_p'] as const) {
			const requestValue = options.requestOptions?.[key];
			if (requestValue !== undefined) {
				body[key] = requestValue;
				continue;
			}

			const configuredValue = modelOptions[key];
			if (configuredValue === null) {
				delete body[key];
			} else if (configuredValue !== undefined) {
				body[key] = configuredValue;
			}
		}

		return body;
	}

	/**
	 * Forwards the per-request reasoning effort to the model body in the shape the endpoint expects.
	 * Default shape mirrors the API path (`Responses` \u2192 nested `reasoning.effort`, `Messages` \u2192 `output_config.effort`,
	 * `Chat Completions` \u2192 top-level `reasoning_effort`).
	 * `IChatModelInformation.reasoningEffortFormat` overrides the default so users hosting OpenAI-compatible servers
	 * with diverging conventions (e.g. nested `reasoning.effort` on `/chat/completions`) can opt in deterministically.
	 */
	private _applyReasoningEffort(body: IEndpointBody, options: ICreateEndpointBodyOptions): void {
		const supports = this.supportsReasoningEffort;
		if (!supports?.length) {
			return;
		}
		const format = this.modelMetadata.reasoningEffortFormat
			?? (this.useResponsesApi ? 'responses' : this.useMessagesApi ? 'messages' : 'chat-completions');
		const override = this._configurationService.getConfig(ConfigKey.Advanced.ReasoningEffortOverride);
		const requested = override || options.modelCapabilities?.reasoningEffort || body.reasoning?.effort || body.reasoning_effort || body.output_config?.effort;
		const effort = requested && supports.includes(requested) ? requested : undefined;
		// Scrub any pre-populated effort first so unsupported values (e.g. the hard-coded `medium` default
		// from `createResponsesRequestBody`) cannot leak through, then write the resolved value into the
		// expected shape.
		if (body.reasoning) {
			const { effort: _drop, ...rest } = body.reasoning;
			body.reasoning = Object.keys(rest).length > 0 ? rest : undefined;
		}
		body.reasoning_effort = undefined;
		if (body.output_config) {
			// Drop only the effort so other output_config fields (e.g. structured output format) survive
			const { effort: _drop, ...rest } = body.output_config;
			body.output_config = Object.keys(rest).length > 0 ? rest : undefined;
		}
		if (effort) {
			if (format === 'responses') {
				body.reasoning = { ...body.reasoning, effort };
			} else if (format === 'messages') {
				body.output_config = { ...body.output_config, effort };
			} else {
				body.reasoning_effort = effort;
			}
		}
	}

	override interceptBody(body: IEndpointBody | undefined): void {
		super.interceptBody(body);
		// TODO @lramos15 - We should do this for all models and not just here
		if (body?.tools?.length === 0) {
			delete body.tools;
		}

		if (body?.tools) {
			body.tools = body.tools.map(tool => {
				if (isOpenAiFunctionTool(tool) && tool.function.parameters === undefined) {
					tool.function.parameters = { type: 'object', properties: {} };
				}
				return tool;
			});
		}

		if (body) {
			if (this.modelMetadata.capabilities.supports.thinking) {
				delete body.temperature;
				if (!this.useMessagesApi && !this.useResponsesApi) {
					// OpenAI Chat Completions thinking models (e.g. o1/o3) require `max_completion_tokens` instead of `max_tokens`.
					// Responses bodies use `max_output_tokens` natively, and Messages requires `max_tokens` — neither needs this rename.
					body['max_completion_tokens'] = body.max_tokens;
					delete body.max_tokens;
				}
			}
			// Chat Completions: drop `max_tokens` so the server defaults to its maximum (preferred for BYOK).
			// Responses uses `max_output_tokens`, so this delete is a no-op there. Messages requires `max_tokens`, so leave it alone.
			if (!this.useMessagesApi) {
				delete body.max_tokens;
			}
			if (!this.useResponsesApi && !this.useMessagesApi && body.stream) {
				body['stream_options'] = { 'include_usage': true };
			}
		}
	}

	override get urlOrRequestMetadata(): string {
		return this._modelUrl;
	}

	public override getExtraHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};
		if (this._modelUrl.includes('openai.azure')) {
			headers['api-key'] = this._apiKey;
		} else {
			headers['Authorization'] = `Bearer ${this._apiKey}`;
		}
		for (const [key, value] of Object.entries(this._customHeaders)) {
			headers[key] = value;
		}
		const gateway = this.gatewayKind;
		if (gateway) {
			Object.assign(headers, getGatewayTrackingHeaders(gateway, this._workContext));
		}
		const metadataHeaders = this.modelMetadata.requestMetadata?.headers;
		if (metadataHeaders) {
			const expanded = expandRequestMetadata({ headers: metadataHeaders }, this._requestMetadataVariables).headers;
			for (const [key, value] of Object.entries(this._sanitizeCustomHeaders(expanded))) {
				headers[key] = value;
			}
		}
		return headers;
	}

	override cloneWithTokenOverride(modelMaxPromptTokens: number): IChatEndpoint {
		const newModelInfo = { ...this.modelMetadata, maxInputTokens: modelMaxPromptTokens };
		const clone = this.instantiationService.createInstance(OpenAIEndpoint, newModelInfo, this._apiKey, this._modelUrl);
		clone.setGateway(this._gatewayKind, this._providerGroup);
		return clone;
	}

	override async processResponseFromChatEndpoint(
		telemetryService: ITelemetryService,
		logService: ILogService,
		response: Response,
		expectedNumChoices: number,
		finishCallback: FinishedCallback,
		telemetryData: TelemetryData,
		cancellationToken?: CancellationToken | undefined
	): Promise<AsyncIterableObject<ChatCompletion>> {
		const completions = await super.processResponseFromChatEndpoint(telemetryService, logService, response, expectedNumChoices, finishCallback, telemetryData, cancellationToken);
		const gateway = this.gatewayKind;
		const context = this._workContext;
		if (!gateway || !context || !response.ok) {
			return completions;
		}
		// CreaEditor: record the request in the cost ledger with the cost the gateway reports.
		const headerCost = getCostFromHeaders(gateway, name => response.headers.get(name));
		let host = '';
		try {
			host = new URL(this._modelUrl).host;
		} catch {
			// Keep the host empty for unparsable URLs.
		}
		const entryId = this._gatewayTrackingService.recordRequest({
			chatId: context.chatId,
			rootChatId: context.rootChatId,
			chatTitle: context.chatTitle,
			issue: context.issue,
			issueSource: context.issueSource,
			repo: context.repo,
			branch: context.branch,
			gateway,
			gatewayHost: host,
			providerGroup: this._providerGroup,
			model: this.model,
			gatewayRequestId: headerCost.gatewayRequestId,
			cost: headerCost.cost,
			costSource: headerCost.cost !== undefined ? 'header' : undefined,
		});
		let recorded = false;
		return completions.map(completion => {
			if (!recorded && (completion.usage || completion.requestId.completionId)) {
				recorded = true;
				const usageCost = headerCost.cost === undefined ? getCostFromUsage(completion.usage) : undefined;
				const generationId = completion.requestId.completionId || headerCost.gatewayRequestId;
				this._gatewayTrackingService.updateRequest(entryId, {
					gatewayRequestId: generationId,
					promptTokens: completion.usage?.prompt_tokens,
					completionTokens: completion.usage?.completion_tokens,
					cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens,
					cost: usageCost,
					costSource: usageCost !== undefined ? 'response' : undefined,
				});
				if (headerCost.cost === undefined && usageCost === undefined && generationId) {
					void this._lookUpCost(gateway, entryId, generationId);
				}
			}
			return completion;
		});
	}

	/**
	 * CreaEditor: the chat error when a used up budget with a hard stop covers this request: its key, or the
	 * issue or repository the ledger would record for it. `undefined` when the request may be sent.
	 */
	private _checkBudgetHardStop(options: IMakeChatRequestOptions): string | undefined {
		if (!this.gatewayKind) {
			return undefined;
		}
		const budgets = parseCostBudgets(this._configurationService.getNonExtensionConfig<unknown>(BUDGETS_SETTING)).filter(budget => budget.hardStop);
		if (!budgets.length) {
			return undefined;
		}
		const token = getCurrentCapturingToken();
		const chatId = token?.chatSessionId ?? options.conversationId ?? BACKGROUND_CHAT_ID;
		const needsContext = budgets.some(budget => budget.scope !== 'key');
		const context = needsContext ? this._gatewayTrackingService.getWorkContext(chatId, token?.parentChatSessionId ?? chatId, extractUserRequestText(getUserMessagesText(options.messages))) : undefined;
		const exhausted = findHardStopBudget(budgets, this._gatewayTrackingService.entries, {
			providerGroup: this._providerGroup,
			issue: formatIssue(context?.issue, context?.repo),
			repo: context?.repo,
		}, Date.now());
		if (exhausted) {
			this.logService.info(`[GatewayBudgets] Refused a request: budget ${exhausted.budget.id} is used up.`);
		}
		return exhausted ? formatBudgetRefusal(exhausted) : undefined;
	}

	/**
	 * CreaEditor: asks the gateway for the cost of a request that did not report it inline
	 * (OpenRouter `GET /generation`, LiteLLM `GET /spend/logs`). Gateways finalize costs
	 * asynchronously, so this retries a few times.
	 */
	private async _lookUpCost(gateway: GatewayKind, entryId: string, gatewayRequestId: string): Promise<void> {
		const url = gateway === 'openrouter'
			? `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(gatewayRequestId)}`
			: `${normalizeGatewayRoot(this._modelUrl)}/spend/logs?request_id=${encodeURIComponent(gatewayRequestId)}`;
		for (const delay of [2000, 5000, 15000]) {
			await timeout(delay);
			try {
				const response = await this._gatewayFetcherService.fetch(url, {
					method: 'GET',
					headers: { Authorization: `Bearer ${this._apiKey}` },
					callSite: 'creaeditor-gateway-cost',
				});
				if (!response.ok) {
					if (response.status === 401 || response.status === 403) {
						return; // The key may not read spend data; keep the request without a cost.
					}
					continue;
				}
				const cost = parseCostLookup(gateway, await response.json());
				if (cost !== undefined) {
					this._gatewayTrackingService.updateRequest(entryId, { cost, costSource: gateway === 'openrouter' ? 'openrouter-api' : 'litellm-api' });
					return;
				}
			} catch (error) {
				this.logService.trace(`[GatewayTracking] Cost lookup failed: ${error}`);
			}
		}
	}

	public override async makeChatRequest2(options: IMakeChatRequestOptions, token: CancellationToken): Promise<ChatResponse> {
		// CreaEditor: a used up budget with a hard stop refuses the request before it is sent (main chats and subagents).
		const refusal = this._checkBudgetHardStop(options);
		if (refusal) {
			return { type: ChatFetchResponseType.Failed, reason: refusal, requestId: options.telemetryProperties?.requestId ?? '', serverRequestId: undefined };
		}
		// Use ignoreStatefulMarker: false as the initial request default; the parent retry flow can override it on InvalidStatefulMarker retries.
		const modifiedOptions: IMakeChatRequestOptions = { ...options, ignoreStatefulMarker: options.ignoreStatefulMarker ?? false };
		const response = await super.makeChatRequest2(modifiedOptions, token);
		return hydrateBYOKErrorMessages(response);
	}
}

/** CreaEditor: text of the user messages, used for the chat title and issue detection. */
function getUserMessagesText(messages: readonly Raw.ChatMessage[]): string {
	return messages
		.filter(m => m.role === Raw.ChatRole.User)
		.map(m => m.content.map(part => part.type === Raw.ChatCompletionContentPartKind.Text ? part.text : '').join(''))
		.join('\n');
}

/** CreaEditor: reads the cost from an OpenRouter `GET /generation` or LiteLLM `GET /spend/logs` response. */
function parseCostLookup(gateway: GatewayKind, json: unknown): number | undefined {
	if (gateway === 'openrouter') {
		const data = (json as { data?: { total_cost?: unknown } } | undefined)?.data;
		return typeof data?.total_cost === 'number' ? data.total_cost : undefined;
	}
	const rows = Array.isArray(json) ? json : (json as { data?: unknown } | undefined)?.data;
	if (Array.isArray(rows) && rows.length) {
		const spend = (rows[0] as { spend?: unknown }).spend;
		return typeof spend === 'number' ? spend : undefined;
	}
	return undefined;
}
