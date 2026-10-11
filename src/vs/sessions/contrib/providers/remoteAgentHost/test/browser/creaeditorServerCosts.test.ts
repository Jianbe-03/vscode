/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { Event } from '../../../../../../base/common/event.js';
import { constObservable } from '../../../../../../base/common/observable.js';
import { URI } from '../../../../../../base/common/uri.js';
import { mock } from '../../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ICreaEditorServerCostsResponse } from '../../../../../../platform/agentHost/common/creaeditorCosts.js';
import { IRemoteAgentHostService } from '../../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { TestConfigurationService } from '../../../../../../platform/configuration/test/common/testConfigurationService.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../../platform/log/common/log.js';
import { IUserDataProfilesService, toUserDataProfile } from '../../../../../../platform/userDataProfile/common/userDataProfile.js';
import { IHostService } from '../../../../../../workbench/services/host/browser/host.js';
import { IUserDataProfileService } from '../../../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { CreaEditorServerCostsSync, getServerCostsCacheFile } from '../../browser/creaeditorServerCosts.js';
import { ICreaEditorServer, ICreaEditorServersService } from '../../browser/creaeditorServers.js';

suite('CreaEditor Server Costs', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the costs in the default profile\'s global storage (read by every window) and moves an older cache there', async () => {
		const fileService = store.add(new FileService(new NullLogService()));
		store.add(fileService.registerProvider('test', store.add(new InMemoryFileSystemProvider())));
		const user = URI.from({ scheme: 'test', path: '/ud/User' });
		const cache = URI.from({ scheme: 'test', path: '/ud/CachedProfilesData' });
		const defaultProfile = toUserDataProfile('__default__profile__', 'Default', user, cache);
		// The Agents window runs in a built-in profile with its own global storage.
		const agentsProfile = toUserDataProfile('agents', 'Agents', URI.joinPath(user, 'profiles', 'builtin', 'agents'), cache);
		const server: ICreaEditorServer = { id: 's1', name: 'Office Server', serverUrl: 'http://127.0.0.1:1', deviceId: 'd', addedAt: 0 };
		const oldEntry = { id: 'old', time: 1 };
		const newEntry = { id: 'new', time: 2 };
		const oldFile = getServerCostsCacheFile(agentsProfile.globalStorageHome, server.id);
		await fileService.writeFile(oldFile, VSBuffer.fromString(JSON.stringify({ serverId: server.id, serverName: server.name, cursor: 1, entries: [oldEntry] })));

		const serversService = new class extends mock<ICreaEditorServersService>() {
			override readonly servers = constObservable([server]);
			override async fetchCosts(): Promise<ICreaEditorServerCostsResponse> {
				return { entries: [newEntry], cursor: 2, reset: false };
			}
			override async pushBudgets(): Promise<boolean> {
				return true;
			}
		};
		const sync = store.add(new CreaEditorServerCostsSync(
			serversService,
			new class extends mock<IRemoteAgentHostService>() { override readonly onDidChangeConnections = Event.None; },
			fileService,
			new class extends mock<IUserDataProfileService>() { override readonly currentProfile = agentsProfile; },
			new class extends mock<IUserDataProfilesService>() { override readonly defaultProfile = defaultProfile; },
			new TestConfigurationService(),
			new class extends mock<IHostService>() { override readonly hasFocus = false; override readonly onDidChangeFocus = Event.None; },
			new NullLogService(),
		));
		await sync.syncNow();

		const sharedFile = getServerCostsCacheFile(defaultProfile.globalStorageHome, server.id);
		assert.deepStrictEqual({
			sharedFile: sharedFile.path,
			shared: JSON.parse((await fileService.readFile(sharedFile)).value.toString()),
			oldFileExists: await fileService.exists(oldFile),
		}, {
			sharedFile: '/ud/User/globalStorage/creaeditor-server-costs/s1.json',
			shared: { serverId: 's1', serverName: 'Office Server', cursor: 2, entries: [oldEntry, newEntry] },
			oldFileExists: false,
		});
	});
});
