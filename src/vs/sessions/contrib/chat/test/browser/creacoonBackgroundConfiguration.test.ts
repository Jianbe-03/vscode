/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AGENT_SESSIONS_PREFERRED_DARK_CHAT_BACKGROUND_IMAGE_SETTING, AGENT_SESSIONS_PREFERRED_LIGHT_CHAT_BACKGROUND_IMAGE_SETTING } from '../../../../services/chatBackground/browser/chatBackgroundService.js';
import { creacoonBackgroundConfigurationMigration, LEGACY_CREACOON_BACKGROUND_SETTING } from '../../browser/creacoonBackgroundConfiguration.js';

suite('CreacoonBackgroundConfiguration', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('moves the legacy background into the chat background settings without overwriting them', async () => {
		const migrate = (value: string, configured: Record<string, string> = {}) => creacoonBackgroundConfigurationMigration.migrateFn(value, key => configured[key]);

		assert.deepStrictEqual({
			key: creacoonBackgroundConfigurationMigration.key,
			starryNight: await migrate('starryNight'),
			pattern: await migrate('pattern', { [AGENT_SESSIONS_PREFERRED_LIGHT_CHAT_BACKGROUND_IMAGE_SETTING]: 'codicons' }),
			none: await migrate('none'),
		}, {
			key: LEGACY_CREACOON_BACKGROUND_SETTING,
			starryNight: [
				[LEGACY_CREACOON_BACKGROUND_SETTING, { value: undefined }],
			],
			pattern: [
				[LEGACY_CREACOON_BACKGROUND_SETTING, { value: undefined }],
				[AGENT_SESSIONS_PREFERRED_DARK_CHAT_BACKGROUND_IMAGE_SETTING, { value: 'pattern' }],
			],
			none: [
				[LEGACY_CREACOON_BACKGROUND_SETTING, { value: undefined }],
				[AGENT_SESSIONS_PREFERRED_DARK_CHAT_BACKGROUND_IMAGE_SETTING, { value: 'none' }],
				[AGENT_SESSIONS_PREFERRED_LIGHT_CHAT_BACKGROUND_IMAGE_SETTING, { value: 'none' }],
			],
		});
	});
});
