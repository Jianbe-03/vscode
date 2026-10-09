/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: pairs this computer with a CreaEditor Server and adds it (Add CreaEditor Server, and the
// end of installing one over SSH).

import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { CreaEditorServerPairError, ICreaEditorServerInput } from '../../../../../platform/agentHost/common/creaeditorServer.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ICreaEditorServer, ICreaEditorServersService } from './creaeditorServers.js';

function pairErrorMessage(error: CreaEditorServerPairError, retryAfterSeconds: number | undefined): string {
	switch (error) {
		case 'invalidCode': return localize('creaeditorServers.invalidCode', "That pairing code is not right. Run `creaeditor-server pair` on the server for a new one.");
		case 'expiredCode': return localize('creaeditorServers.expiredCode', "That pairing code expired. Run `creaeditor-server pair` on the server for a new one.");
		case 'passwordRequired': return localize('creaeditorServers.passwordRequired', "This server is public: pairing needs its password.");
		case 'wrongPassword': return localize('creaeditorServers.wrongPassword', "The password is not right.");
		case 'noPasswordSet': return localize('creaeditorServers.noPasswordSet', "This server is public but has no password yet. Run `creaeditor-server password` on the server first.");
		case 'lockedOut': return localize('creaeditorServers.lockedOut', "Too many failed attempts. Try again in {0} minutes.", Math.max(1, Math.ceil((retryAfterSeconds ?? 900) / 60)));
		case 'unreachable': return localize('creaeditorServers.unreachable', "The server does not answer.");
		default: return localize('creaeditorServers.pairFailed', "Pairing failed.");
	}
}

function osName(): string {
	return isMacintosh ? 'macOS' : isWindows ? 'Windows' : 'Linux';
}

/**
 * Pairs with the server at `input` and adds it: asks for the pairing code (unless the link had one) and,
 * for a public server, the password. Returns the added server, or undefined when the user stopped.
 */
export async function pairAndAddCreaEditorServer(accessor: ServicesAccessor, input: ICreaEditorServerInput, publicMode: boolean, options?: { readonly sshHost?: string; readonly name?: string }): Promise<ICreaEditorServer | undefined> {
	const quickInputService = accessor.get(IQuickInputService);
	const serversService = accessor.get(ICreaEditorServersService);
	const notificationService = accessor.get(INotificationService);
	const progressService = accessor.get(IProgressService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const productService = accessor.get(IProductService);
	const title = localize('creaeditorServers.addTitle', "Add CreaEditor Server");

	let code = input.pairingCode;
	let password: string | undefined;
	let needsPassword = publicMode;
	let lastError: string | undefined;
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!code || lastError) {
			code = (await quickInputService.input({
				title,
				prompt: lastError ?? localize('creaeditorServers.codePrompt', "Enter the pairing code. Run `creaeditor-server pair` on the server to get one."),
				placeHolder: 'ABCDE-12345',
				value: lastError ? undefined : code,
				ignoreFocusLost: true,
				validateInput: async value => value.trim() ? undefined : localize('creaeditorServers.codeEmpty', "Enter the pairing code."),
			}))?.trim();
			if (!code) {
				return undefined;
			}
		}
		if (needsPassword && !password) {
			password = await quickInputService.input({
				title,
				prompt: localize('creaeditorServers.passwordPrompt', "This server is reachable from the internet. Enter its password."),
				password: true,
				ignoreFocusLost: true,
			});
			if (!password) {
				return undefined;
			}
		}
		const deviceName = localize('creaeditorServers.deviceName', "{0} on {1}", productService.nameShort, osName());
		const result = await progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('creaeditorServers.pairing', "Pairing with {0}...", input.suggestedName) },
			() => serversService.pair(input.baseUrl, code!, password, deviceName),
		);
		if (result.ok) {
			const name = options?.name ?? (await quickInputService.input({
				title,
				prompt: localize('creaeditorServers.namePrompt', "Name this server."),
				value: input.suggestedName,
				valueSelection: [0, input.suggestedName.length],
				ignoreFocusLost: true,
			}))?.trim() ?? input.suggestedName;
			const server = await serversService.addServer({ name: name || input.suggestedName, serverUrl: input.baseUrl, sshHost: options?.sshHost }, result);
			try {
				await progressService.withProgress(
					{ location: ProgressLocation.Notification, title: localize('creaeditorServers.connecting', "Connecting to {0}...", server.name) },
					() => remoteAgentHostService.waitForConnection(serversService.getAgentHostAddress(server)),
				);
				notificationService.info(localize('creaeditorServers.added', "{0} is added. Its chats show in the Agents window.", server.name));
			} catch {
				notificationService.warn(localize('creaeditorServers.addedNotConnected', "{0} is paired, but connecting to its agents failed. Check CreaEditor Servers for its status.", server.name));
			}
			return server;
		}
		if (result.error === 'passwordRequired' || result.error === 'wrongPassword') {
			needsPassword = true;
			password = undefined;
			if (result.error === 'wrongPassword') {
				notificationService.warn(pairErrorMessage(result.error, undefined));
			}
			continue;
		}
		if (result.error === 'invalidCode' || result.error === 'expiredCode') {
			lastError = pairErrorMessage(result.error, result.retryAfterSeconds);
			continue;
		}
		notificationService.error(pairErrorMessage(result.error, result.retryAfterSeconds));
		return undefined;
	}
	return undefined;
}
