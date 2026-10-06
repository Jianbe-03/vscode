/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: quick flow to add an OpenRouter preset (or a single OpenRouter model) to the
// model picker without listing every OpenRouter model.

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { asJson, IRequestService } from '../../../../../platform/request/common/request.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { ILanguageModelsConfigurationService, ILanguageModelsProviderGroup } from '../../common/languageModelsConfiguration.js';
import { CHAT_CATEGORY } from './chatActions.js';

export const ADD_OPENROUTER_MODEL_COMMAND_ID = 'workbench.action.chat.addOpenRouterModel';

const OPENROUTER_VENDOR = 'openrouter';
const PRESET_PREFIX = '@preset/';

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

async function fetchCatalog(requestService: IRequestService, logService: ILogService): Promise<IOpenRouterCatalogModel[]> {
	const cts = new CancellationTokenSource();
	try {
		const context = await requestService.request({ type: 'GET', url: 'https://openrouter.ai/api/v1/models?supported_parameters=tools', callSite: 'chat.openRouterCatalog' }, cts.token);
		const result = await asJson<{ data?: IOpenRouterCatalogModel[] }>(context);
		return result?.data ?? [];
	} catch (error) {
		logService.warn('[OpenRouter] Could not load the model catalog', error);
		return [];
	} finally {
		cts.dispose();
	}
}

async function pickOpenRouterModel(quickInputService: IQuickInputService, requestService: IRequestService, logService: ILogService): Promise<IOpenRouterPick | undefined> {
	const disposables = new DisposableStore();
	const picker = disposables.add(quickInputService.createQuickPick<IOpenRouterPick>());
	picker.title = localize('openRouter.pickTitle', "Add OpenRouter Preset or Model");
	picker.placeholder = localize('openRouter.pickPlaceholder', "Type a preset slug (e.g. programmer-agent), paste a preset URL, or pick a model");
	picker.matchOnDescription = true;
	picker.busy = true;

	let catalogItems: IOpenRouterPick[] = [];
	const update = () => {
		const value = picker.value.trim();
		const typed = value ? [presetPick(value)] : [];
		picker.items = [...typed, ...catalogItems];
	};
	disposables.add(picker.onDidChangeValue(update));
	fetchCatalog(requestService, logService).then(models => {
		catalogItems = models.map(model => ({
			modelId: model.id,
			defaultName: model.name ?? model.id,
			label: model.name ?? model.id,
			description: model.id,
			detail: model.context_length ? localize('openRouter.context', "{0}K context", Math.round(model.context_length / 1000)) : undefined,
		}));
		picker.busy = false;
		update();
	});
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

export class AddOpenRouterModelAction extends Action2 {
	constructor() {
		super({
			id: ADD_OPENROUTER_MODEL_COMMAND_ID,
			title: localize2('chat.addOpenRouterModel', "Add OpenRouter Preset or Model..."),
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

		const picked = await pickOpenRouterModel(quickInputService, requestService, logService);
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

		await configurationService.whenReady;
		const openRouterGroups = () => configurationService.getLanguageModelsProviderGroups().filter(group => group.vendor === OPENROUTER_VENDOR);
		let groups = openRouterGroups();
		if (!groups.length) {
			// No API key configured yet: run the regular "add OpenRouter" flow (asks for a name and API key).
			await languageModelsService.configureLanguageModelsProviderGroup(OPENROUTER_VENDOR);
			groups = openRouterGroups();
			if (!groups.length) {
				return;
			}
		}

		let group: ILanguageModelsProviderGroup | undefined = groups[0];
		if (groups.length > 1) {
			const pick = await quickInputService.pick(groups.map(g => ({ label: g.name, group: g })), { placeHolder: localize('openRouter.pickGroup', "Add to which OpenRouter API key?") });
			group = pick?.group;
		}
		if (!group) {
			return;
		}

		const existing: IOpenRouterModelEntry[] = Array.isArray(group.models) ? group.models as IOpenRouterModelEntry[] : [];
		const models = existing.some(entry => entry.id === picked.modelId)
			? existing.map(entry => entry.id === picked.modelId ? { ...entry, name: name.trim() } : entry)
			: [...existing, { id: picked.modelId, name: name.trim() }];
		await configurationService.updateLanguageModelsProviderGroup(group, { ...group, models });

		notificationService.info(localize('openRouter.added', "Added \"{0}\" ({1}) to OpenRouter group \"{2}\".", name.trim(), picked.modelId, group.name));
	}
}
