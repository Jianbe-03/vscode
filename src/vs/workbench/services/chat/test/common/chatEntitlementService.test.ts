/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatEntitlement, chatRequiresSetup, IChatSetupRequirement } from '../../common/chatEntitlementService.js';

suite('chatRequiresSetup', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function context(overrides: Partial<IChatSetupRequirement> = {}): IChatSetupRequirement {
		return {
			completed: true,
			disabled: false,
			untrusted: false,
			entitlement: ChatEntitlement.Pro,
			anonymous: false,
			hasByokModels: false,
			...overrides,
		};
	}

	test('a completed, signed-up user does not require setup', () => {
		assert.strictEqual(chatRequiresSetup(context()), false);
	});

	test('not completed does not require setup (CreaEditor: no Copilot setup flow)', () => {
		assert.strictEqual(chatRequiresSetup(context({ completed: false })), false);
	});

	test('not completed but BYOK models present does not require setup', () => {
		assert.strictEqual(chatRequiresSetup(context({ completed: false, hasByokModels: true })), false);
	});

	test('disabled requires setup', () => {
		assert.strictEqual(chatRequiresSetup(context({ disabled: true })), true);
	});

	test('untrusted requires setup', () => {
		assert.strictEqual(chatRequiresSetup(context({ untrusted: true })), true);
	});

	test('entitlement Available does not require setup (CreaEditor: no Copilot sign up)', () => {
		assert.strictEqual(chatRequiresSetup(context({ entitlement: ChatEntitlement.Available })), false);
	});

	test('signed out (Unknown) does not require setup (CreaEditor: no Copilot sign in)', () => {
		assert.strictEqual(chatRequiresSetup(context({ completed: true, entitlement: ChatEntitlement.Unknown })), false);
	});

	test('signed out but anonymous access enabled does not require setup', () => {
		// Anonymous excepts the "signed out" entitlement clause; the completed
		// clause is satisfied because opting into anonymous completes setup.
		assert.strictEqual(chatRequiresSetup(context({ completed: true, entitlement: ChatEntitlement.Unknown, anonymous: true })), false);
	});

	test('signed out but BYOK models present does not require setup', () => {
		assert.strictEqual(chatRequiresSetup(context({ completed: false, entitlement: ChatEntitlement.Unknown, hasByokModels: true })), false);
	});
});
