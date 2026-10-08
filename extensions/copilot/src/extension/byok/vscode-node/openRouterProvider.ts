/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IChatMLFetcher } from '../../../platform/chat/common/chatMLFetcher';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IDomainService } from '../../../platform/endpoint/common/domainService';
import { IGatewayTrackingService } from '../../../platform/endpoint/common/gatewayTrackingService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';

import { IChatWebSocketManager } from '../../../platform/networking/node/chatWebSocketManager';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { ITokenizerProvider } from '../../../platform/tokenizer/node/tokenizer';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKKnownModels, BYOKModelCapabilities } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { byokKnownModelsToAPIInfoWithEffort } from './byokModelInfo';
import { AbstractOpenAICompatibleLMProvider, IProviderGroupStatusPresentation, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { IBYOKStorageService } from './byokStorageService';
import { GatewayKeyStatusMonitor } from './gatewayKeyStatusMonitor';

interface OpenRouterModelData {
	id: string;
	name: string;
	supported_parameters?: string[];
	architecture?: {
		input_modalities?: string[];
	};
	/**
	 * The model's actual maximum context window, independent of which provider
	 * OpenRouter ranks highest. Prefer this over `top_provider.context_length`,
	 * which only reflects the primary provider and can be far smaller for
	 * multi-provider models.
	 * @see https://openrouter.ai/docs/guides/overview/models
	 */
	context_length?: number;
	top_provider: {
		context_length: number;
		/** Maximum tokens the primary provider will produce in a response. */
		max_completion_tokens?: number;
	};
	reasoning?: {
		supported_efforts?: string[] | null;
		default_effort?: string;
	};
}

/**
 * CreaEditor: an entry of the `models` array of an OpenRouter provider group in `chatLanguageModels.json`.
 * The id is either an OpenRouter preset (`@preset/<slug>`) or a regular OpenRouter model slug
 * (`anthropic/claude-sonnet-4.5`). Only configured entries are shown in the model picker unless
 * `showAllModels` is set, so the picker does not list every OpenRouter model.
 */
interface OpenRouterModelEntry {
	readonly id: string;
	readonly name?: string;
	/** OpenRouter model slug whose capabilities a preset inherits (context window, vision, tools, reasoning). */
	readonly baseModel?: string;
	readonly toolCalling?: boolean;
	readonly vision?: boolean;
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
	readonly supportsReasoningEffort?: string[];
}

interface OpenRouterProviderConfig extends LanguageModelChatConfiguration {
	readonly models?: readonly OpenRouterModelEntry[];
	readonly showAllModels?: boolean;
	/** List the presets of the key's account in the model picker automatically (default `true`). */
	readonly discoverPresets?: boolean;
	/** Model or preset ids to hide from the model picker (e.g. discovered presets). */
	readonly hiddenModels?: readonly string[];
}

/** Subset of an OpenRouter `GET /presets` entry. */
interface OpenRouterPreset {
	readonly slug: string;
	readonly name?: string;
	readonly status?: string;
}

/** CreaEditor: what the last model discovery found, offered by the "Add OpenRouter / LiteLLM Models" flow. */
export interface IDiscoveredGatewayModel {
	readonly id: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly isPreset: boolean;
}

/**
 * CreaEditor: the presets and guardrail-allowed models found by the most recent OpenRouter discovery,
 * per provider group (named API key; `''` for models resolved without a group). Every key has its own
 * guardrails and presets, so one key's discovery never stands in for another's.
 */
const lastOpenRouterDiscovery = new Map<string, readonly IDiscoveredGatewayModel[]>();

/**
 * CreaEditor: the discovery of one OpenRouter key. Without a group, the discovery of the only key is
 * returned, or nothing when there are several keys.
 */
export function getOpenRouterDiscovery(group: string | undefined): readonly IDiscoveredGatewayModel[] {
	if (group !== undefined) {
		return lastOpenRouterDiscovery.get(group) ?? [];
	}
	return lastOpenRouterDiscovery.size === 1 ? [...lastOpenRouterDiscovery.values()][0] : [];
}

const OPENROUTER_PRESET_PREFIX = '@preset/';
const DEFAULT_PRESET_CONTEXT_WINDOW = 200_000;
const DEFAULT_PRESET_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Normalizes user input such as `programmer-agent`, `@preset/programmer-agent` or
 * `https://openrouter.ai/settings/presets/programmer-agent` to an OpenRouter model id.
 */
export function normalizeOpenRouterModelId(value: string): string {
	const trimmed = value.trim();
	const presetUrl = /openrouter\.ai\/(?:settings\/)?presets\/([^/?#\s]+)/i.exec(trimmed);
	if (presetUrl) {
		return OPENROUTER_PRESET_PREFIX + presetUrl[1];
	}
	if (trimmed.startsWith(OPENROUTER_PRESET_PREFIX) || trimmed.includes('/')) {
		return trimmed;
	}
	return OPENROUTER_PRESET_PREFIX + trimmed;
}

function defaultPresetName(id: string): string {
	const slug = id.slice(OPENROUTER_PRESET_PREFIX.length);
	const title = slug.split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
	return `${title || slug} (preset)`;
}

/**
 * Fallback output-token budget used only when OpenRouter does not report
 * `top_provider.max_completion_tokens` for a model. The value is heuristic — most
 * tool-capable models do report an explicit budget, in which case this is unused.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export class OpenRouterLMProvider extends AbstractOpenAICompatibleLMProvider {

	public static readonly providerName = 'OpenRouter';
	public static readonly providerId = this.providerName.toLowerCase();

	constructor(
		byokStorageService: IBYOKStorageService,
		/** CreaEditor: the limit and balance of the keys. */
		private readonly _keyStatus: GatewayKeyStatusMonitor,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService
	) {
		super(
			OpenRouterLMProvider.providerId,
			OpenRouterLMProvider.providerName,
			undefined,
			byokStorageService,
			fetcherService,
			logService,
			instantiationService,
			configurationService,
			expService
		);
	}

	protected override async getAllModels(silent: boolean, apiKey: string | undefined, configuration: LanguageModelChatConfiguration | undefined, group?: string): Promise<OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>[]> {
		const config = configuration as OpenRouterProviderConfig | undefined;
		const hidden = new Set((config?.hiddenModels ?? []).map(normalizeOpenRouterModelId));
		const entries: OpenRouterModelEntry[] = (config?.models ?? [])
			.filter(entry => typeof entry?.id === 'string' && entry.id.trim().length > 0)
			.map(entry => ({ ...entry, id: normalizeOpenRouterModelId(entry.id) }));

		// CreaEditor: the account's presets show up automatically.
		const presets = apiKey && config?.discoverPresets !== false ? await this._fetchPresets(apiKey) : [];
		for (const preset of presets) {
			const id = OPENROUTER_PRESET_PREFIX + preset.slug;
			if (!entries.some(entry => entry.id === id)) {
				entries.push({ id, name: preset.name && preset.name !== preset.slug ? `${preset.name} (preset)` : undefined });
			}
		}
		// The catalog (limited to the key's guardrails) is always fetched when there is a key, so the
		// "Add OpenRouter / LiteLLM Models" flow can offer exactly the models the key may use.
		const needsCatalog = !!apiKey || config?.showAllModels === true || entries.some(entry => !entry.id.startsWith(OPENROUTER_PRESET_PREFIX) || entry.baseModel);

		let catalog: OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>[] = [];
		if (needsCatalog) {
			try {
				// CreaEditor: `/models/user` may ignore the tools filter; agents need tool calling.
				catalog = (await super.getAllModels(silent, apiKey, configuration)).filter(model => !!model.capabilities?.toolCalling);
			} catch (error) {
				// Presets must stay usable when the catalog cannot be fetched (e.g. offline).
				if (!entries.length) {
					throw error;
				}
				this._logService.warn(`[OpenRouter] Could not fetch the model catalog: ${error}`);
			}
		}

		const baseUrl = this.getModelsBaseUrl()!;
		const configured: BYOKKnownModels = {};
		for (const entry of entries) {
			const id = entry.id;
			const base = (entry.baseModel && this._knownModels?.[entry.baseModel]) || this._knownModels?.[id];
			const isPreset = id.startsWith(OPENROUTER_PRESET_PREFIX);
			const contextWindow = entry.contextWindow ?? base?.contextWindow ?? (base ? (base.maxInputTokens ?? 0) + base.maxOutputTokens : DEFAULT_PRESET_CONTEXT_WINDOW);
			const maxOutputTokens = entry.maxOutputTokens ?? base?.maxOutputTokens ?? Math.min(DEFAULT_PRESET_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 2));
			const capabilities: BYOKModelCapabilities = {
				...base,
				name: entry.name ?? (isPreset ? defaultPresetName(id) : base?.name ?? id),
				toolCalling: entry.toolCalling ?? base?.toolCalling ?? true,
				vision: entry.vision ?? base?.vision ?? false,
				contextWindow: undefined,
				maxInputTokens: contextWindow - maxOutputTokens,
				maxOutputTokens,
				// A preset owns its reasoning settings on OpenRouter; only expose an effort picker when asked to.
				supportsReasoningEffort: entry.supportsReasoningEffort ?? (isPreset ? undefined : base?.supportsReasoningEffort),
				defaultReasoningEffort: isPreset ? undefined : base?.defaultReasoningEffort,
			};
			configured[id] = capabilities;
			this._knownModels = { ...this._knownModels, [id]: capabilities };
		}

		const configuredModels = byokKnownModelsToAPIInfoWithEffort(this._name, configured)
			.filter(model => !hidden.has(model.id))
			.map(model => ({ ...model, url: baseUrl }));
		const configuredIds = new Set(configuredModels.map(model => model.id));
		lastOpenRouterDiscovery.set(group ?? '', [
			...presets.map(preset => {
				const id = OPENROUTER_PRESET_PREFIX + preset.slug;
				return { id, name: configured[id]?.name ?? defaultPresetName(id), isPreset: true };
			}),
			...catalog.map(model => ({ id: model.id, name: model.name, contextWindow: model.maxInputTokens + model.maxOutputTokens, isPreset: false })),
		]);
		if (config?.showAllModels !== true) {
			return configuredModels;
		}
		return [...configuredModels, ...catalog.filter(model => !configuredIds.has(model.id) && !hidden.has(model.id))];
	}

	/** CreaEditor: the remaining limit of the key, shown next to it in the model picker. */
	protected override getProviderGroupStatus(group: string | undefined, apiKey: string | undefined): IProviderGroupStatusPresentation | undefined {
		return this._keyStatus.present('openrouter', group, apiKey, this.getModelsBaseUrl());
	}

	/** CreaEditor: the presets of the key's account (`GET /api/v1/presets`). */
	private async _fetchPresets(apiKey: string): Promise<OpenRouterPreset[]> {
		try {
			const response = await this._fetcherService.fetch(`${this.getModelsBaseUrl()}/presets?limit=100`, {
				method: 'GET',
				headers: { Authorization: `Bearer ${apiKey}` },
				callSite: 'creaeditor-openrouter-presets',
			});
			if (!response.ok) {
				this._logService.trace(`[OpenRouter] Could not list presets: HTTP ${response.status}`);
				return [];
			}
			const data = (await response.json() as { data?: OpenRouterPreset[] }).data ?? [];
			return data.filter(preset => typeof preset.slug === 'string' && preset.slug && (!preset.status || preset.status === 'active'));
		} catch (error) {
			this._logService.trace(`[OpenRouter] Could not list presets: ${error}`);
			return [];
		}
	}

	protected override getModelsBaseUrl(): string | undefined {
		return 'https://openrouter.ai/api/v1';
	}

	protected override getModelsDiscoveryUrl(modelsBaseUrl: string): string {
		// CreaEditor: `/models/user` only lists models allowed by the key's guardrails, provider preferences
		// and privacy settings.
		return `${modelsBaseUrl}/models/user?supported_parameters=tools`;
	}

	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		const openRouterModelData = modelData as OpenRouterModelData;
		const supportedParameters = openRouterModelData.supported_parameters ?? [];

		// OpenRouter reports reasoning support per model via `supported_parameters`. The unified `reasoning` parameter and
		// the OpenAI-style `reasoning_effort` alias both indicate the model accepts an effort level.
		// See https://openrouter.ai/docs/use-cases/reasoning-tokens
		const supportedEfforts = openRouterModelData.reasoning?.supported_efforts ?? ['low', 'medium', 'high'];
		const supportsReasoningEffort = supportedParameters.includes('reasoning') || supportedParameters.includes('reasoning_effort')
			? supportedEfforts
			: undefined;

		// Set OpenRouter model's default reasoning effort if it is reported.
		const defaultReasoningEffort = openRouterModelData.reasoning?.default_effort;

		// Prefer the model-level `context_length` (the real capability) over
		// `top_provider.context_length`, which only reflects OpenRouter's
		// highest-ranked provider and can be much smaller for multi-provider models.
		const contextWindow = openRouterModelData.context_length ?? openRouterModelData.top_provider.context_length;
		// Reserve output tokens from the window. Clamp the reserve so a small-context
		// model (or a missing/oversized `max_completion_tokens`) never yields a
		// non-positive prompt budget.
		const requestedMaxOutputTokens = openRouterModelData.top_provider.max_completion_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
		const maxOutputTokens = Math.min(requestedMaxOutputTokens, Math.floor(contextWindow / 2));
		return {
			name: openRouterModelData.name,
			toolCalling: supportedParameters.includes('tools'),
			vision: openRouterModelData.architecture?.input_modalities?.includes('image') ?? false,
			maxInputTokens: contextWindow - maxOutputTokens,
			maxOutputTokens,
			supportsReasoningEffort,
			defaultReasoningEffort
		};
	}

	protected override async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<LanguageModelChatConfiguration>): Promise<OpenAIEndpoint> {
		const modelInfo = this.getModelInfo(model.id, model.url);
		const isAnthropic = isAnthropicModelId(model.id);

		if (isAnthropic) {
			// Anthropic models on OpenRouter use the native Messages API which
			// provides full cache_control, thinking, and tool support identical
			// to the direct Anthropic API.
			modelInfo.supported_endpoints = [ModelSupportedEndpoint.Messages];
		}

		const url = isAnthropic
			? `${model.url}/messages`
			: `${model.url}/chat/completions`;

		return this._instantiationService.createInstance(OpenRouterEndpoint, modelInfo, model.configuration?.apiKey ?? '', url);
	}
}

/**
 * Checks whether an OpenRouter model ID refers to an Anthropic model.
 * OpenRouter model IDs follow the format `provider/model-name`, e.g.
 * `anthropic/claude-sonnet-4` or `anthropic/claude-opus-4`.
 */
function isAnthropicModelId(modelId: string): boolean {
	return modelId.startsWith('anthropic/');
}

/**
 * OpenRouter-specific endpoint that routes Anthropic models through the native
 * Messages API (`/api/v1/messages`) for full prompt caching, thinking, and tool
 * support identical to the direct Anthropic API.
 *
 * @see https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages
 */
export class OpenRouterEndpoint extends OpenAIEndpoint {
	constructor(
		modelMetadata: IChatModelInformation,
		apiKey: string,
		modelUrl: string,
		@IDomainService domainService: IDomainService,
		@IChatMLFetcher chatMLFetcher: IChatMLFetcher,
		@ITokenizerProvider tokenizerProvider: ITokenizerProvider,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService,
		@IChatWebSocketManager chatWebSocketService: IChatWebSocketManager,
		@ILogService logService: ILogService,
		@IGatewayTrackingService gatewayTrackingService: IGatewayTrackingService,
		@IFetcherService fetcherService: IFetcherService,
	) {
		super(modelMetadata, apiKey, modelUrl, domainService, chatMLFetcher, tokenizerProvider, instantiationService, configurationService, expService, chatWebSocketService, logService, gatewayTrackingService, fetcherService);
	}

	/**
	 * Enable the Messages API path for Anthropic models. This bypasses the
	 * experiment flag check in the base class because BYOK models are always
	 * user-controlled — the `supported_endpoints` metadata is already set
	 * correctly by {@link OpenRouterLMProvider.createOpenAIEndPoint}.
	 */
	protected override get useMessagesApi(): boolean {
		return !!this.modelMetadata.supported_endpoints?.includes(ModelSupportedEndpoint.Messages);
	}

	public override getExtraHeaders(): Record<string, string> {
		const headers = super.getExtraHeaders();
		if (this.useMessagesApi) {
			Object.assign(headers, this.getAnthropicBetaHeader());
		}
		return headers;
	}
}
