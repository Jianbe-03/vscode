/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { GatewayKind, normalizeGatewayRoot } from '../../../platform/endpoint/common/gatewayTracking';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { BYOKModelCapabilities } from '../common/byokProvider';
import { AbstractOpenAICompatibleLMProvider, IProviderGroupStatusPresentation, LanguageModelChatConfiguration, OpenAICompatibleLanguageModelChatInformation } from './abstractLanguageModelChatProvider';
import { byokKnownModelToAPIInfoWithEffort } from './byokModelInfo';
import { IBYOKStorageService } from './byokStorageService';
import { GatewayKeyStatusMonitor } from './gatewayKeyStatusMonitor';

/** CreaEditor: an optional per-model override in a LiteLLM provider group. */
interface LiteLLMModelEntry {
	readonly id: string;
	readonly name?: string;
	readonly toolCalling?: boolean;
	readonly vision?: boolean;
	readonly contextWindow?: number;
	readonly maxOutputTokens?: number;
}

/** CreaEditor: a LiteLLM provider group in `chatLanguageModels.json`. */
export interface LiteLLMProviderConfig extends LanguageModelChatConfiguration {
	/** LiteLLM proxy URL, e.g. `http://litellm.tailnet.ts.net:4000`. */
	readonly url?: string;
	/** Optional display names and capability overrides; models are discovered from the proxy either way. */
	readonly models?: readonly LiteLLMModelEntry[];
	/** Model ids (or LiteLLM model group names) to hide from the model picker. */
	readonly hiddenModels?: readonly string[];
}

/** Subset of a LiteLLM `/model/info` entry. */
interface LiteLLMModelInfo {
	readonly model_name?: string;
	readonly model_info?: {
		readonly max_tokens?: number | null;
		readonly max_input_tokens?: number | null;
		readonly max_output_tokens?: number | null;
		readonly supports_function_calling?: boolean | null;
		readonly supports_vision?: boolean | null;
		readonly supports_reasoning?: boolean | null;
	};
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/**
 * CreaEditor: language models served by a LiteLLM proxy. The models are discovered from the proxy and
 * limited to what the virtual key may use (`/v1/models` is scoped to the key); capabilities come from
 * `/model/info` when the key may read it.
 */
export class LiteLLMLMProvider extends AbstractOpenAICompatibleLMProvider<LiteLLMProviderConfig> {

	public static readonly providerName = 'LiteLLM';
	public static readonly providerId = this.providerName.toLowerCase();

	private _modelInfo = new Map<string, LiteLLMModelInfo>();

	constructor(
		byokStorageService: IBYOKStorageService,
		/** The budget and spend of the keys. */
		private readonly _keyStatus: GatewayKeyStatusMonitor,
		@IFetcherService fetcherService: IFetcherService,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IExperimentationService expService: IExperimentationService
	) {
		super(LiteLLMLMProvider.providerId, LiteLLMLMProvider.providerName, undefined, byokStorageService, fetcherService, logService, instantiationService, configurationService, expService);
	}

	protected override async configureDefaultGroupWithApiKeyOnly(): Promise<string | undefined> {
		return undefined; // A LiteLLM group always needs a URL.
	}

	protected override async getAllModels(silent: boolean, apiKey: string | undefined, configuration: LiteLLMProviderConfig | undefined): Promise<OpenAICompatibleLanguageModelChatInformation<LiteLLMProviderConfig>[]> {
		const base = this.getModelsBaseUrl(configuration);
		if (!base) {
			return [];
		}
		this._modelInfo = await this._fetchModelInfo(base, apiKey);
		const hidden = new Set(configuration?.hiddenModels ?? []);
		const overrides = new Map((configuration?.models ?? []).map(entry => [entry.id, entry]));
		const models = await super.getAllModels(silent, apiKey, configuration);
		return models.filter(model => !hidden.has(model.id)).map(model => {
			// Entries in `models` override the discovered name and capabilities.
			const entry = overrides.get(model.id);
			const current = this._knownModels?.[model.id];
			if (!entry || !current) {
				return model;
			}
			const capabilities = this._applyOverrides(current, entry);
			this._knownModels = { ...this._knownModels, [model.id]: capabilities };
			return { ...byokKnownModelToAPIInfoWithEffort(this._name, model.id, capabilities), url: model.url };
		});
	}

	/** The remaining budget of the key, shown next to it in the model picker. */
	protected override getProviderGroupStatus(group: string | undefined, apiKey: string | undefined, configuration: LiteLLMProviderConfig | undefined): IProviderGroupStatusPresentation | undefined {
		return this._keyStatus.present('litellm', group, apiKey, configuration?.url);
	}

	protected override getModelsBaseUrl(configuration: LiteLLMProviderConfig | undefined): string | undefined {
		return configuration?.url ? `${normalizeGatewayRoot(configuration.url)}/v1` : undefined;
	}

	protected override resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		const id = (modelData as { id?: unknown }).id;
		if (typeof id !== 'string') {
			return undefined;
		}
		const info = this._modelInfo.get(id)?.model_info;
		const contextWindow = info?.max_input_tokens ?? info?.max_tokens ?? DEFAULT_CONTEXT_WINDOW;
		const maxOutputTokens = Math.min(info?.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS, Math.floor(contextWindow / 2));
		return {
			name: id,
			toolCalling: info?.supports_function_calling ?? true,
			vision: info?.supports_vision ?? false,
			maxInputTokens: contextWindow - maxOutputTokens,
			maxOutputTokens,
			supportsReasoningEffort: info?.supports_reasoning ? ['low', 'medium', 'high'] : undefined,
		};
	}

	protected override async resolveGatewayKind(): Promise<GatewayKind | undefined> {
		return 'litellm';
	}

	private _applyOverrides(capabilities: BYOKModelCapabilities, entry: LiteLLMModelEntry): BYOKModelCapabilities {
		const contextWindow = entry.contextWindow ?? (capabilities.maxInputTokens ?? 0) + capabilities.maxOutputTokens;
		const maxOutputTokens = entry.maxOutputTokens ?? capabilities.maxOutputTokens;
		return {
			...capabilities,
			name: entry.name ?? capabilities.name,
			toolCalling: entry.toolCalling ?? capabilities.toolCalling,
			vision: entry.vision ?? capabilities.vision,
			maxInputTokens: contextWindow - maxOutputTokens,
			maxOutputTokens,
		};
	}

	private async _fetchModelInfo(base: string, apiKey: string | undefined): Promise<Map<string, LiteLLMModelInfo>> {
		const result = new Map<string, LiteLLMModelInfo>();
		if (!apiKey) {
			return result;
		}
		try {
			const response = await this._fetcherService.fetch(`${base}/model/info`, {
				method: 'GET',
				headers: { Authorization: `Bearer ${apiKey}` },
				callSite: 'creaeditor-litellm-model-info',
			});
			if (!response.ok) {
				return result;
			}
			const data = (await response.json() as { data?: LiteLLMModelInfo[] }).data ?? [];
			for (const entry of data) {
				if (entry.model_name && !result.has(entry.model_name)) {
					result.set(entry.model_name, entry);
				}
			}
		} catch (error) {
			this._logService.trace(`[LiteLLM] Could not read /model/info: ${error}`);
		}
		return result;
	}
}
