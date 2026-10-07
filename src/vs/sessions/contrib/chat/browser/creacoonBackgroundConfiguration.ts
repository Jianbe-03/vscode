/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Creacoon backgrounds used to have their own `sessions.background` setting. They
// are now presets of the chat background settings, so carry a configured value over to both the
// dark and the light setting, unless the user already configured those.

import { ConfigurationKeyValuePairs, ConfigurationMigration } from '../../../../workbench/common/configuration.js';
import { AGENT_SESSIONS_CHAT_BACKGROUND_NONE_PRESET, AGENT_SESSIONS_CHAT_BACKGROUND_PATTERN_PRESET, AGENT_SESSIONS_PREFERRED_DARK_CHAT_BACKGROUND_IMAGE_SETTING, AGENT_SESSIONS_PREFERRED_LIGHT_CHAT_BACKGROUND_IMAGE_SETTING } from '../../../services/chatBackground/browser/chatBackgroundService.js';

export const LEGACY_CREACOON_BACKGROUND_SETTING = 'sessions.background';

export const creacoonBackgroundConfigurationMigration: ConfigurationMigration = {
	key: LEGACY_CREACOON_BACKGROUND_SETTING,
	migrateFn: (value, accessor) => {
		const pairs: ConfigurationKeyValuePairs = [[LEGACY_CREACOON_BACKGROUND_SETTING, { value: undefined }]];
		// `starryNight` was the default and still is, so it needs no value.
		const preset = value === AGENT_SESSIONS_CHAT_BACKGROUND_PATTERN_PRESET || value === AGENT_SESSIONS_CHAT_BACKGROUND_NONE_PRESET ? value : undefined;
		if (preset) {
			for (const setting of [AGENT_SESSIONS_PREFERRED_DARK_CHAT_BACKGROUND_IMAGE_SETTING, AGENT_SESSIONS_PREFERRED_LIGHT_CHAT_BACKGROUND_IMAGE_SETTING]) {
				if (accessor(setting) === undefined) {
					pairs.push([setting, { value: preset }]);
				}
			}
		}
		return pairs;
	},
};
