/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../log/common/log.js';
import { readSubscriptionAccountsState, SUBSCRIPTION_ACCOUNTS_REQUEST_KEY, type ISubscriptionAccount, type ISubscriptionAccountsRequest, type SubscriptionProvider } from '../../../common/meta/subscriptionAccounts.js';
import { AgentConfigurationService } from '../../../node/agentConfigurationService.js';
import { AgentHostStateManager } from '../../../node/agentHostStateManager.js';
import { SubscriptionAccountsService, type ISubscriptionAccountsProvider } from '../../../node/shared/subscriptionAccountsService.js';

suite('SubscriptionAccountsService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createProvider(provider: SubscriptionProvider, accounts: ISubscriptionAccount[]): ISubscriptionAccountsProvider & { readonly requests: string[]; readonly changed: Emitter<void> } {
		const changed = disposables.add(new Emitter<void>());
		const requests: string[] = [];
		return {
			provider,
			changed,
			requests,
			onDidChangeAccounts: changed.event,
			getAccounts: () => accounts,
			handleRequest: async (request: ISubscriptionAccountsRequest) => { requests.push(`${request.type}:${request.id}`); },
			refreshUsage: async () => { requests.push('refreshUsage'); },
		};
	}

	test('publishes the merged accounts and routes requests to their provider', async () => {
		const logService = new NullLogService();
		const stateManager = disposables.add(new AgentHostStateManager(logService));
		const configService = disposables.add(new AgentConfigurationService(stateManager, logService));
		const service = disposables.add(new SubscriptionAccountsService(undefined, configService, logService));
		const claude = createProvider('claude', [{ id: 'c1', provider: 'claude', label: 'Work', kind: 'token', status: 'signedIn' }]);
		const codex = createProvider('codex', [{ id: 'x1', provider: 'codex', label: 'Home', kind: 'default', status: 'signedIn' }]);
		disposables.add(service.registerProvider(claude));
		disposables.add(service.registerProvider(codex));

		configService.updateRootConfig({ [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: { id: 'r1', type: 'rename', accountId: 'x1', label: 'Other' } });
		configService.updateRootConfig({ [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: { id: 'r2', type: 'add', provider: 'claude', kind: 'login', label: 'New', accountId: 'c2' } });
		configService.updateRootConfig({ [SUBSCRIPTION_ACCOUNTS_REQUEST_KEY]: { id: 'r3', type: 'refreshUsage' } });
		await Promise.resolve();

		assert.deepStrictEqual({
			accounts: readSubscriptionAccountsState(stateManager.rootState).accounts.map(account => account.id),
			claude: claude.requests,
			codex: codex.requests,
			pending: configService.getRootConfigValues()[SUBSCRIPTION_ACCOUNTS_REQUEST_KEY],
		}, {
			accounts: ['c1', 'x1'],
			claude: ['add:r2', 'refreshUsage'],
			codex: ['rename:r1', 'refreshUsage'],
			pending: undefined,
		});
	});
});
