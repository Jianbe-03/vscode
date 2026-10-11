/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: pairs this computer with a CreaEditor Server and adds it (Add CreaEditor Server, and the
// end of installing one over SSH), or pairs again with a server that no longer knows this computer.

import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { CreaEditorServerPairError, ICreaEditorServerInput } from '../../../../../platform/agentHost/common/creaeditorServer.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ICreaEditorServer, ICreaEditorServersService, parsePairAgainInput } from './creaeditorServers.js';

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
export async function pairAndAddCreaEditorServer(accessor: ServicesAccessor, input: ICreaEditorServerInput, publicMode: boolean, options?: { readonly sshHost?: string; readonly name?: string; readonly pairAgain?: ICreaEditorServer }): Promise<ICreaEditorServer | undefined> {
	const quickInputService = accessor.get(IQuickInputService);
	const serversService = accessor.get(ICreaEditorServersService);
	const notificationService = accessor.get(INotificationService);
	const progressService = accessor.get(IProgressService);
	const remoteAgentHostService = accessor.get(IRemoteAgentHostService);
	const productService = accessor.get(IProductService);
	const pairAgain = options?.pairAgain;
	const title = pairAgain
		? localize('creaeditorServers.pairAgainTitle', "Pair Again with {0}", pairAgain.name)
		: localize('creaeditorServers.addTitle', "Add CreaEditor Server");

	let code = input.pairingCode;
	let password: string | undefined;
	let needsPassword = publicMode;
	let lastError: string | undefined;
	let name = options?.name;
	for (let attempt = 0; attempt < 5; attempt++) {
		if (!code || lastError) {
			const typed = (await quickInputService.input({
				title,
				prompt: lastError ?? (pairAgain
					? localize('creaeditorServers.pairAgainPrompt', "{0} no longer knows this computer. Paste a new pairing link or code from it: run `creaeditor-server pair` on the server, or use Pair Phone on another paired device.", pairAgain.name)
					: localize('creaeditorServers.codePrompt', "Enter the pairing code. Run `creaeditor-server pair` on the server to get one.")),
				placeHolder: 'ABCDE-12345',
				value: lastError ? undefined : code,
				ignoreFocusLost: true,
				validateInput: async value => {
					if (!value.trim()) {
						return localize('creaeditorServers.codeEmpty', "Enter the pairing code.");
					}
					return pairAgain && !parsePairAgainInput(value, input.baseUrl) ? localize('creaeditorServers.pairAgainInvalid', "Paste a pairing link of {0} or its pairing code.", pairAgain.name) : undefined;
				},
			}))?.trim();
			code = typed && pairAgain ? parsePairAgainInput(typed, input.baseUrl) : typed;
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
		// The name before pairing: no quick input is open while the server answers, so text typed then
		// would land in the chat input behind it (and be sent as a chat message).
		if (!pairAgain && name === undefined) {
			const typedName = await quickInputService.input({
				title,
				prompt: localize('creaeditorServers.namePrompt', "Name this server."),
				value: input.suggestedName,
				valueSelection: [0, input.suggestedName.length],
				ignoreFocusLost: true,
			});
			if (typedName === undefined) {
				return undefined;
			}
			name = typedName.trim() || input.suggestedName;
		}
		const deviceName = localize('creaeditorServers.deviceName', "{0} on {1}", productService.nameShort, osName());
		const result = await progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('creaeditorServers.pairing', "Pairing with {0}...", input.suggestedName) },
			() => serversService.pair(input.baseUrl, code!, password, deviceName),
		);
		if (result.ok && pairAgain) {
			const server = await serversService.replaceDeviceKey(pairAgain.id, result);
			if (server) {
				notificationService.info(localize('creaeditorServers.pairedAgain', "{0} is paired again.", server.name));
			}
			return server;
		}
		if (result.ok) {
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

/** Pair Again: asks for a new pairing link or code of a server that no longer knows this computer, and replaces its device key. */
export async function pairAgainWithCreaEditorServer(accessor: ServicesAccessor, server: ICreaEditorServer): Promise<ICreaEditorServer | undefined> {
	const serversService = accessor.get(ICreaEditorServersService);
	const progressService = accessor.get(IProgressService);
	const notificationService = accessor.get(INotificationService);
	const instantiationService = accessor.get(IInstantiationService);
	// The last health check usually knows whether the server is public: no request (and no moment
	// without a quick input) before asking for the code.
	const known = serversService.healthStates.get().get(server.id);
	const health = known?.reachable ? known.health : (await progressService.withProgress(
		{ location: ProgressLocation.Notification, title: localize('creaeditorServers.checkingServer', "Checking {0}...", server.name), delay: 500 },
		() => serversService.checkAddress(server.serverUrl),
	))?.health;
	if (!health) {
		notificationService.error(localize('creaeditorServers.pairAgainUnreachable', "{0} does not answer. Pair again once it is online.", server.name));
		return undefined;
	}
	return instantiationService.invokeFunction(pairAndAddCreaEditorServer, { baseUrl: server.serverUrl, suggestedName: server.name }, health.publicMode, { pairAgain: server });
}
