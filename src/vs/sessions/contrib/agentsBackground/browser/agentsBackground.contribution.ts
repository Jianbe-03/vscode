/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentsBackground.css';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { AGENTS_BACKGROUND_SETTING, AgentsBackground, AgentsBackgroundService, getAgentsBackgroundLabel, IAgentsBackgroundService } from './agentsBackground.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'sessions',
	properties: {
		[AGENTS_BACKGROUND_SETTING]: {
			type: 'string',
			enum: [AgentsBackground.StarryNight, AgentsBackground.Pattern, AgentsBackground.None],
			enumDescriptions: [
				localize('sessions.background.starryNight', "A night sky whose twinkling stars and shooting stars are Creacoon marks."),
				localize('sessions.background.pattern', "A calm, slowly drifting pattern of Creacoon marks."),
				localize('sessions.background.none', "No background."),
			],
			default: AgentsBackground.StarryNight,
			description: localize('sessions.background', "The background behind the new session view of the Agents window."),
		},
	},
});

registerSingleton(IAgentsBackgroundService, AgentsBackgroundService, InstantiationType.Delayed);

interface IBackgroundPickItem extends IQuickPickItem {
	readonly background: AgentsBackground;
}

class ChooseAgentsBackgroundAction extends Action2 {

	static readonly ID = 'sessions.chooseBackground';

	constructor() {
		super({
			id: ChooseAgentsBackgroundAction.ID,
			title: localize2('agentsBackground.choose', "Choose Agents Window Background"),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const backgroundService = accessor.get(IAgentsBackgroundService);
		const current = backgroundService.background;
		const items: IBackgroundPickItem[] = [AgentsBackground.StarryNight, AgentsBackground.Pattern, AgentsBackground.None].map(background => ({
			background,
			label: getAgentsBackgroundLabel(background),
			description: background === current ? localize('agentsBackground.current', "Current") : undefined,
		}));
		const picked = await quickInputService.pick(items, {
			placeHolder: localize('agentsBackground.placeholder', "Select a background for the Agents window"),
			activeItem: items.find(item => item.background === current),
		});
		if (picked) {
			await backgroundService.setBackground(picked.background);
		}
	}
}

registerAction2(ChooseAgentsBackgroundAction);
