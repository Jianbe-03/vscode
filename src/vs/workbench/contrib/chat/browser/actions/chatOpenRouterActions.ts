/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: quick flow to connect an OpenRouter account or a LiteLLM proxy and to add OpenRouter
// presets or models to the model picker, without listing every model.

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { asJson, IRequestService } from '../../../../../platform/request/common/request.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../../common/languageModelsConfiguration.js';
import { CHAT_CATEGORY } from './chatActions.js';

export const ADD_OPENROUTER_MODEL_COMMAND_ID = 'workbench.action.chat.addOpenRouterModel';

const OPENROUTER_VENDOR = 'openrouter';
const LITELLM_VENDOR = 'litellm';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const PRESET_PREFIX = '@preset/';

/** Gateway kinds reported by the chat extension's `creaeditor.gateway.detect` command. */
type GatewayKind = 'openrouter' | 'litellm';

/** A model or preset discovered by the chat extension (`creaeditor.gateway.openRouterModels`). */
interface IDiscoveredModel {
	readonly id: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly isPreset: boolean;
}

interface IOpenRouterCatalogModel {
	readonly id: string;
	readonly name?: string;
	readonly context_length?: number;
}

interface IOpenRouterPick extends IQuickPickItem {
	readonly modelId: string;
	readonly defaultName: string;
}

interface IOpenRouterModelEntry {
	readonly id: string;
	readonly name?: string;
}

/** Services the connect flow needs. */
interface IConnectGatewayServices {
	readonly quickInputService: IQuickInputService;
	readonly commandService: ICommandService;
	readonly dialogService: IDialogService;
	readonly languageModelsService: ILanguageModelsService;
	readonly configurationService: ILanguageModelsConfigurationService;
}

/**
 * Normalizes `programmer-agent`, `@preset/programmer-agent` or a preset URL
 * (`https://openrouter.ai/settings/presets/programmer-agent`) to an OpenRouter model id.
 */
export function normalizeOpenRouterModelId(value: string): string {
	const trimmed = value.trim();
	const presetUrl = /openrouter\.ai\/(?:settings\/)?presets\/([^/?#\s]+)/i.exec(trimmed);
	if (presetUrl) {
		return PRESET_PREFIX + presetUrl[1];
	}
	if (trimmed.startsWith(PRESET_PREFIX) || trimmed.includes('/')) {
		return trimmed;
	}
	return PRESET_PREFIX + trimmed;
}

export function defaultOpenRouterPresetName(id: string): string {
	const slug = id.slice(PRESET_PREFIX.length);
	const title = slug.split(/[-_\s]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
	return localize('openRouter.presetName', "{0} (preset)", title || slug);
}

function presetPick(value: string): IOpenRouterPick {
	const modelId = normalizeOpenRouterModelId(value);
	const isPreset = modelId.startsWith(PRESET_PREFIX);
	return {
		modelId,
		defaultName: isPreset ? defaultOpenRouterPresetName(modelId) : modelId,
		label: isPreset
			? localize('openRouter.addPreset', "{0} Add preset {1}", '$(add)', modelId)
			: localize('openRouter.addModelId', "{0} Add model {1}", '$(add)', modelId),
		alwaysShow: true,
	};
}

/** The presets and guardrail-allowed models the chat extension discovered with the OpenRouter key of `groupName`. */
async function getDiscoveredModels(commandService: ICommandService, groupName: string): Promise<IDiscoveredModel[]> {
	try {
		return await commandService.executeCommand<IDiscoveredModel[]>('creaeditor.gateway.openRouterModels', groupName) ?? [];
	} catch {
		return [];
	}
}

/** The public OpenRouter catalog, used when nothing was discovered with a key yet. */
async function fetchPublicCatalog(requestService: IRequestService, logService: ILogService): Promise<IDiscoveredModel[]> {
	const cts = new CancellationTokenSource();
	try {
		const context = await requestService.request({ type: 'GET', url: `${OPENROUTER_URL}/models?supported_parameters=tools`, callSite: 'chat.openRouterCatalog' }, cts.token);
		const result = await asJson<{ data?: IOpenRouterCatalogModel[] }>(context);
		return (result?.data ?? []).map(model => ({ id: model.id, name: model.name ?? model.id, contextWindow: model.context_length, isPreset: false }));
	} catch (error) {
		logService.warn('[OpenRouter] Could not load the model catalog', error);
		return [];
	} finally {
		cts.dispose();
	}
}

async function pickOpenRouterModel(quickInputService: IQuickInputService, commandService: ICommandService, requestService: IRequestService, logService: ILogService, groupName: string, existingIds: ReadonlySet<string>): Promise<IOpenRouterPick | undefined> {
	const disposables = new DisposableStore();
	const picker = disposables.add(quickInputService.createQuickPick<IOpenRouterPick>({ useSeparators: true }));
	picker.title = localize('openRouter.pickTitle', "Add OpenRouter Preset or Model");
	picker.placeholder = localize('openRouter.pickPlaceholder', "Pick a preset or a model your key may use, or type a preset slug or URL");
	picker.matchOnDescription = true;
	picker.busy = true;

	let discoveredItems: (IOpenRouterPick | IQuickPickSeparator)[] = [];
	const update = () => {
		const value = picker.value.trim();
		const typed = value ? [presetPick(value)] : [];
		picker.items = [...typed, ...discoveredItems];
	};
	disposables.add(picker.onDidChangeValue(update));

	const toPick = (model: IDiscoveredModel): IOpenRouterPick => ({
		modelId: model.id,
		defaultName: model.name || model.id,
		label: model.name || model.id,
		description: existingIds.has(model.id) ? localize('openRouter.alreadyAdded', "{0} · added", model.id) : model.id,
		detail: model.contextWindow ? localize('openRouter.context', "{0}K context", Math.round(model.contextWindow / 1000)) : undefined,
	});
	const load = async () => {
		let models = await getDiscoveredModels(commandService, groupName);
		const fromKey = models.length > 0;
		if (!fromKey) {
			models = await fetchPublicCatalog(requestService, logService);
		}
		const presets = models.filter(model => model.isPreset);
		const others = models.filter(model => !model.isPreset);
		const presetSeparator: IQuickPickSeparator = { type: 'separator', label: localize('openRouter.presets', "Presets") };
		const modelSeparator: IQuickPickSeparator = {
			type: 'separator',
			label: fromKey ? localize('openRouter.allowedModels', "Models allowed by your key's guardrails") : localize('openRouter.allModels', "Models"),
		};
		discoveredItems = [
			...(presets.length ? [presetSeparator, ...presets.map(toPick)] : []),
			...(others.length ? [modelSeparator, ...others.map(toPick)] : []),
		];
		picker.busy = false;
		update();
	};
	void load();
	update();

	try {
		return await new Promise<IOpenRouterPick | undefined>(resolve => {
			disposables.add(picker.onDidAccept(() => {
				const selected = picker.selectedItems[0] ?? (picker.value.trim() ? presetPick(picker.value) : undefined);
				resolve(selected);
				picker.hide();
			}));
			disposables.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
	} finally {
		disposables.dispose();
	}
}

/**
 * Connects a new gateway: asks for its URL, detects whether it is OpenRouter or a LiteLLM proxy and
 * adds a provider group with the given API key. Returns the detected gateway kind.
 */
async function connectGateway(services: IConnectGatewayServices): Promise<GatewayKind | undefined> {
	const { quickInputService, commandService, dialogService, languageModelsService, configurationService } = services;
	const url = (await quickInputService.input({
		title: localize('gateway.urlTitle', "Connect OpenRouter or LiteLLM"),
		prompt: localize('gateway.urlPrompt', "OpenRouter, or the URL of your LiteLLM proxy (connect to Tailscale or your VPN first if the proxy is only reachable there)."),
		value: OPENROUTER_URL,
		validateInput: async value => {
			try {
				new URL(value.trim());
				return undefined;
			} catch {
				return localize('gateway.invalidUrl', "Please enter a valid URL.");
			}
		},
	}))?.trim();
	if (!url) {
		return undefined;
	}

	let kind = await commandService.executeCommand<GatewayKind | undefined>('creaeditor.gateway.detect', url);
	if (!kind) {
		const { confirmed } = await dialogService.confirm({
			message: localize('gateway.notDetected', "No OpenRouter or LiteLLM proxy was found at {0}.", url),
			detail: localize('gateway.notDetectedDetail', "If this is a LiteLLM proxy, check that you are connected to Tailscale or your VPN. You can also add it anyway; its models are discovered once it can be reached."),
			primaryButton: localize('gateway.addAnyway', "Add as LiteLLM Anyway"),
		});
		if (!confirmed) {
			return undefined;
		}
		kind = 'litellm';
	}

	const existingNames = new Set(configurationService.getLanguageModelsProviderGroups().map(group => group.name));
	const defaultName = kind === 'openrouter' ? 'OpenRouter' : 'LiteLLM';
	const name = (await quickInputService.input({
		title: kind === 'openrouter' ? localize('gateway.nameOpenRouter', "OpenRouter Detected") : localize('gateway.nameLiteLLM', "LiteLLM Proxy Detected"),
		prompt: localize('gateway.namePrompt', "Name for this key, e.g. \"Work key\". It is shown after every model of this key in the model picker; a chat and its subagents always stay on the key they started on."),
		value: existingNames.has(defaultName) ? `${defaultName} 2` : defaultName,
		validateInput: async value => !value.trim()
			? localize('gateway.nameRequired', "Please enter a name.")
			: existingNames.has(value.trim()) ? localize('gateway.nameExists', "A connection with this name already exists.") : undefined,
	}))?.trim();
	if (!name) {
		return undefined;
	}
	const apiKey = await quickInputService.input({
		title: kind === 'openrouter' ? localize('gateway.keyOpenRouter', "OpenRouter API Key") : localize('gateway.keyLiteLLM', "LiteLLM Virtual Key"),
		prompt: localize('gateway.keyPrompt', "Stored in the secret storage of this machine."),
		password: true,
		validateInput: async value => value.trim() ? undefined : localize('gateway.keyRequired', "Please enter an API key."),
	});
	if (!apiKey) {
		return undefined;
	}
	await languageModelsService.addLanguageModelsProviderGroup(name, kind === 'openrouter' ? OPENROUTER_VENDOR : LITELLM_VENDOR, kind === 'openrouter' ? { apiKey } : { url, apiKey });
	return kind;
}

export class AddOpenRouterModelAction extends Action2 {
	constructor() {
		super({
			id: ADD_OPENROUTER_MODEL_COMMAND_ID,
			title: localize2('chat.addGatewayModels', "Add OpenRouter or LiteLLM Models..."),
			category: CHAT_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const requestService = accessor.get(IRequestService);
		const logService = accessor.get(ILogService);
		const languageModelsService = accessor.get(ILanguageModelsService);
		const configurationService = accessor.get(ILanguageModelsConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);
		const dialogService = accessor.get(IDialogService);

		await configurationService.whenReady;
		const gatewayGroups = () => configurationService.getLanguageModelsProviderGroups().filter(group => group.vendor === OPENROUTER_VENDOR || group.vendor === LITELLM_VENDOR);

		let group: ILanguageModelsProviderGroup | undefined;
		const groups = gatewayGroups();
		if (groups.length) {
			const pick = await quickInputService.pick<IQuickPickItem & { group?: ILanguageModelsProviderGroup }>([
				...groups.map(g => ({ label: g.name, description: g.vendor === LITELLM_VENDOR ? localize('gateway.liteLLM', "LiteLLM") : localize('gateway.openRouter', "OpenRouter"), group: g })),
				{ label: localize('gateway.connectNew', "{0} Connect OpenRouter or a LiteLLM Proxy...", '$(plug)') },
			], { placeHolder: localize('gateway.pickGroup', "Add models to which connection?") });
			if (!pick) {
				return;
			}
			group = pick.group;
		}
		if (!group) {
			const kind = await connectGateway({ quickInputService, commandService, dialogService, languageModelsService, configurationService });
			if (!kind) {
				return;
			}
			if (kind === 'litellm') {
				notificationService.info(localize('gateway.liteLLMAdded', "LiteLLM connected. The models your key may use appear in the model picker automatically."));
				return;
			}
			notificationService.info(localize('gateway.openRouterAdded', "OpenRouter connected. Your presets appear in the model picker automatically; you can add models next."));
			group = gatewayGroups().filter(g => g.vendor === OPENROUTER_VENDOR).at(-1);
			if (!group) {
				return;
			}
		}

		if (group.vendor === LITELLM_VENDOR) {
			notificationService.info(localize('gateway.liteLLMAuto', "The models of \"{0}\" are discovered from the LiteLLM proxy automatically. Add a \"hiddenModels\" list in the language models JSON to hide some.", group.name));
			return;
		}

		const existing: IOpenRouterModelEntry[] = Array.isArray(group.models) ? group.models as IOpenRouterModelEntry[] : [];
		const picked = await pickOpenRouterModel(quickInputService, commandService, requestService, logService, group.name, new Set(existing.map(entry => entry.id)));
		if (!picked) {
			return;
		}

		const name = await quickInputService.input({
			title: localize('openRouter.nameTitle', "Name for {0}", picked.modelId),
			prompt: localize('openRouter.namePrompt', "Shown in the model picker; agents can reference the model by this name (e.g. model: \"{0}\").", picked.defaultName),
			value: picked.defaultName,
			validateInput: async value => value.trim() ? undefined : localize('openRouter.nameRequired', "Please enter a name."),
		});
		if (!name) {
			return;
		}

		const models = existing.some(entry => entry.id === picked.modelId)
			? existing.map(entry => entry.id === picked.modelId ? { ...entry, name: name.trim() } : entry)
			: [...existing, { id: picked.modelId, name: name.trim() }];
		await configurationService.updateLanguageModelsProviderGroup(group, { ...group, models });

		notificationService.info(localize('openRouter.added', "Added \"{0}\" ({1}) to \"{2}\".", name.trim(), picked.modelId, group.name));
	}
}
