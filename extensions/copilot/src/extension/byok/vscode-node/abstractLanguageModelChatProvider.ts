/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GatewayKind } from '../../../platform/endpoint/common/gatewayTracking';
import { CancellationToken, commands, EventEmitter, LanguageModelChatInformation, LanguageModelChatMessage, LanguageModelChatMessage2, LanguageModelChatProvider, LanguageModelResponsePart2, PrepareLanguageModelChatModelOptions, Progress, ProvideLanguageModelChatResponseOptions } from 'vscode';
import { IConfigurationService } from '../../../platform/configuration/common/configurationService';
import { IChatModelInformation, ModelSupportedEndpoint } from '../../../platform/endpoint/common/endpointProvider';
import { ILogService } from '../../../platform/log/common/logService';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { IExperimentationService } from '../../../platform/telemetry/common/nullExperimentationService';
import { IStringDictionary } from '../../../util/vs/base/common/collections';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { CopilotLanguageModelWrapper } from '../../conversation/vscode-node/languageModelAccess';
import { BYOKAuthType, BYOKKnownModels, BYOKModelCapabilities, resolveModelInfo } from '../common/byokProvider';
import { OpenAIEndpoint } from '../node/openAIEndpoint';
import { byokKnownModelsToAPIInfoWithEffort } from './byokModelInfo';
import { resolveByokRequestMetadata } from './byokRequestMetadata';
import { IBYOKStorageService } from './byokStorageService';
import { detectGatewayKind } from './gatewayDetection';

export interface LanguageModelChatConfiguration {
	readonly apiKey?: string;
}

export interface ExtendedLanguageModelChatInformation<C extends LanguageModelChatConfiguration> extends LanguageModelChatInformation {
	readonly configuration?: C;
	/** CreaEditor: the provider group (named API key) the model was resolved for, recorded in the cost ledger. */
	readonly providerGroup?: string;
}

/** CreaEditor: what the models of a provider group show of the status of its key. */
export interface IProviderGroupStatusPresentation {
	/** Short text next to the group in the model picker. */
	readonly detail: string;
	/** Text for the model hover. */
	readonly info: string;
}

/** CreaEditor: how long after a status refresh the models of a group are reused instead of listed again. */
const STATUS_REFRESH_REUSE_WINDOW = 30_000;

export abstract class AbstractLanguageModelChatProvider<C extends LanguageModelChatConfiguration = LanguageModelChatConfiguration, T extends ExtendedLanguageModelChatInformation<C> = ExtendedLanguageModelChatInformation<C>> implements LanguageModelChatProvider<T> {

	// CreaEditor: lets a provider update the key status its models show without listing them again.
	private readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;
	private readonly _lastModels = new Map<string, { readonly apiKey: string | undefined; readonly configuration: string; readonly models: T[] }>();
	private _reuseModelsUntil = 0;

	constructor(
		protected readonly _id: string,
		protected readonly _name: string,
		protected _knownModels: BYOKKnownModels | undefined,
		protected readonly _byokStorageService: IBYOKStorageService,
		@ILogService protected readonly _logService: ILogService,
	) {
		this.configureDefaultGroupWithApiKeyOnly();
	}

	updateKnownModels(knownModels: BYOKKnownModels | undefined): void {
		if (!knownModels) {
			return;
		}
		this._knownModels = { ...this._knownModels, ...knownModels };
	}

	// TODO: Remove this after 6 months
	protected async configureDefaultGroupWithApiKeyOnly(): Promise<string | undefined> {
		const apiKey = await this._byokStorageService.getAPIKey(this._name);
		if (apiKey) {
			this.configureDefaultGroupIfExists(this._name, { apiKey } as C);
			await this._byokStorageService.deleteAPIKey(this._name, BYOKAuthType.GlobalApiKey);
		}
		return apiKey;
	}

	protected async configureDefaultGroupIfExists(name: string, configuration: C): Promise<void> {
		await commands.executeCommand('lm.migrateLanguageModelsProviderGroup', { vendor: this._id, name, ...configuration });
	}

	async provideLanguageModelChatInformation({ silent, configuration, group }: PrepareLanguageModelChatModelOptions, token: CancellationToken): Promise<T[]> {
		let apiKey: string | undefined = (configuration as C)?.apiKey;
		if (!apiKey) {
			apiKey = await this.configureDefaultGroupWithApiKeyOnly();
		}

		// CreaEditor: right after a key status refresh, the models of an unchanged group are reused.
		const serializedConfiguration = JSON.stringify(configuration ?? null);
		const cached = this._lastModels.get(group ?? '');
		let models: T[];
		if (cached && Date.now() < this._reuseModelsUntil && cached.apiKey === apiKey && cached.configuration === serializedConfiguration) {
			models = cached.models;
		} else {
			models = await this.getAllModels(silent, apiKey, configuration as C, group);
			this._lastModels.set(group ?? '', { apiKey, configuration: serializedConfiguration, models });
		}
		const status = this.getProviderGroupStatus(group, apiKey, configuration as C | undefined);
		return models.map(model => ({
			...model,
			isBYOK: true,
			apiKey,
			configuration,
			// CreaEditor: remember the provider group (API key) so its requests are attributed to it.
			providerGroup: group,
			...(status ? { providerGroupDetail: status.detail, infoText: { ...model.infoText, creaeditorKeyStatus: status.info } } : {}),
		}));
	}

	/**
	 * CreaEditor: the status of the key of a provider group (e.g. its remaining limit) its models show.
	 * Must answer from memory; model listing never waits for it.
	 */
	protected getProviderGroupStatus(group: string | undefined, apiKey: string | undefined, configuration: C | undefined): IProviderGroupStatusPresentation | undefined {
		return undefined;
	}

	/** CreaEditor: shows a new key status in the model picker; the models are reused for a short while instead of listed again. */
	refreshProviderGroupStatus(): void {
		this._reuseModelsUntil = Date.now() + STATUS_REFRESH_REUSE_WINDOW;
		this._onDidChangeLanguageModelChatInformation.fire();
	}

	abstract provideLanguageModelChatResponse(model: T, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void>;
	abstract provideTokenCount(model: T, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number>;
	/** @param group CreaEditor: the provider group (named API key) the models are resolved for, if any. */
	protected abstract getAllModels(silent: boolean, apiKey: string | undefined, configuration: C | undefined, group?: string): Promise<T[]>;
}

export interface OpenAICompatibleLanguageModelChatInformation<C extends LanguageModelChatConfiguration> extends ExtendedLanguageModelChatInformation<C> {
	url: string;
}

export abstract class AbstractOpenAICompatibleLMProvider<T extends LanguageModelChatConfiguration = LanguageModelChatConfiguration> extends AbstractLanguageModelChatProvider<T, OpenAICompatibleLanguageModelChatInformation<T>> {
	protected readonly _lmWrapper: CopilotLanguageModelWrapper;

	constructor(
		id: string,
		name: string,
		knownModels: BYOKKnownModels | undefined,
		byokStorageService: IBYOKStorageService,
		@IFetcherService protected readonly _fetcherService: IFetcherService,
		logService: ILogService,
		@IInstantiationService protected readonly _instantiationService: IInstantiationService,
		@IConfigurationService protected readonly _configurationService: IConfigurationService,
		@IExperimentationService protected readonly _expService: IExperimentationService
	) {
		super(id, name, knownModels, byokStorageService, logService);
		this._lmWrapper = this._instantiationService.createInstance(CopilotLanguageModelWrapper);
	}

	async provideLanguageModelChatResponse(model: OpenAICompatibleLanguageModelChatInformation<T>, messages: Array<LanguageModelChatMessage | LanguageModelChatMessage2>, options: ProvideLanguageModelChatResponseOptions, progress: Progress<LanguageModelResponsePart2>, token: CancellationToken): Promise<void> {
		const openAIChatEndpoint = await this.createRequestEndpoint(model);
		return this._lmWrapper.provideLanguageModelResponse(openAIChatEndpoint, messages, options, options.requestInitiator, progress, token);
	}

	async provideTokenCount(model: OpenAICompatibleLanguageModelChatInformation<T>, text: string | LanguageModelChatMessage | LanguageModelChatMessage2, token: CancellationToken): Promise<number> {
		const openAIChatEndpoint = await this.createRequestEndpoint(model);
		return this._lmWrapper.provideTokenCount(openAIChatEndpoint, text);
	}

	protected async getAllModels(silent: boolean, apiKey: string | undefined, configuration: T | undefined): Promise<OpenAICompatibleLanguageModelChatInformation<T>[]> {
		const modelsUrl = this.getModelsBaseUrl(configuration);
		if (modelsUrl) {
			const models = await this.getModelsFromEndpoint(modelsUrl, silent, apiKey);
			return byokKnownModelsToAPIInfoWithEffort(this._name, models).map(model => ({
				...model,
				url: modelsUrl
			}));
		}
		return [];
	}

	private async getModelsFromEndpoint(endpoint: string, silent: boolean, apiKey: string | undefined): Promise<BYOKKnownModels> {
		if (!apiKey && silent) {
			return {};
		}

		try {
			const headers: IStringDictionary<string> = {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			};

			const modelsEndpoint = this.getModelsDiscoveryUrl(endpoint);
			const response = await this._fetcherService.fetch(modelsEndpoint, {
				method: 'GET',
				headers,
				callSite: 'byok-models-discovery',
			});
			const data = await response.json();
			const modelList: BYOKKnownModels = {};

			const models = data.data ?? data.models;
			if (!models || !Array.isArray(models)) {
				throw new Error('Invalid response format');
			}

			for (const model of models) {
				let modelCapabilities = this._knownModels?.[model.id];
				if (!modelCapabilities) {
					modelCapabilities = this.resolveModelCapabilities(model);
					if (!modelCapabilities) {
						continue;
					}
					if (!this._knownModels) {
						this._knownModels = {};
					}
					this._knownModels[model.id] = modelCapabilities;
				}
				modelList[model.id] = modelCapabilities;
			}
			return modelList;
		} catch (error) {
			this._logService.error(error, `Error fetching available OpenRouter models`);
			throw error;
		}
	}

	/**
	 * Creates the endpoint for a request and attaches the user's configured request metadata
	 * (group-level `requestMetadata` plus per-model overrides) to it.
	 */
	protected async createRequestEndpoint(model: OpenAICompatibleLanguageModelChatInformation<T>): Promise<OpenAIEndpoint> {
		const endpoint = await this.createOpenAIEndPoint(model);
		this.attachRequestMetadata(endpoint, model);
		// CreaEditor: requests through OpenRouter or LiteLLM always carry chat/issue tracking and record their cost.
		endpoint.setGateway(await this.resolveGatewayKind(endpoint), model.providerGroup);
		return endpoint;
	}

	/**
	 * CreaEditor: the LLM gateway behind an endpoint. OpenRouter is known by its URL; other OpenAI-compatible
	 * URLs are probed once for a LiteLLM proxy.
	 */
	protected async resolveGatewayKind(endpoint: OpenAIEndpoint): Promise<GatewayKind | undefined> {
		return endpoint.gatewayKind ?? detectGatewayKind(endpoint.urlOrRequestMetadata, this._fetcherService);
	}

	protected attachRequestMetadata(endpoint: OpenAIEndpoint, model: OpenAICompatibleLanguageModelChatInformation<T>): void {
		const metadata = resolveByokRequestMetadata(model, this._id);
		if (metadata) {
			endpoint.modelMetadata.requestMetadata = metadata;
		}
	}

	protected async createOpenAIEndPoint(model: OpenAICompatibleLanguageModelChatInformation<T>): Promise<OpenAIEndpoint> {
		const modelInfo = this.getModelInfo(model.id, model.url);
		const url = modelInfo.supported_endpoints?.includes(ModelSupportedEndpoint.Responses) ?
			`${model.url}/responses` :
			`${model.url}/chat/completions`;
		return this._instantiationService.createInstance(OpenAIEndpoint, modelInfo, model.configuration?.apiKey ?? '', url);
	}

	protected getModelInfo(modelId: string, modelUrl: string): IChatModelInformation {
		return resolveModelInfo(modelId, this._name, this._knownModels);
	}

	protected resolveModelCapabilities(modelData: unknown): BYOKModelCapabilities | undefined {
		return undefined;
	}

	protected abstract getModelsBaseUrl(configuration: T | undefined): string | undefined;

	protected getModelsDiscoveryUrl(modelsBaseUrl: string): string {
		return `${modelsBaseUrl}/models`;
	}

}
