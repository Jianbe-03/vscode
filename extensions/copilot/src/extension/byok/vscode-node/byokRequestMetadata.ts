/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { env, workspace } from 'vscode';
import { expandRequestMetadata, IRequestMetadata, resolveRequestMetadata } from '../../../platform/endpoint/common/requestMetadata';

interface IModelIdentity {
	readonly id: string;
	readonly name: string;
	readonly configuration?: unknown;
}

let cachedUserName: string | undefined;
function getUserName(): string {
	if (cachedUserName === undefined) {
		try {
			cachedUserName = os.userInfo().username;
		} catch {
			cachedUserName = '';
		}
	}
	return cachedUserName;
}

/**
 * Resolves the request metadata configured for `model` in its provider group (`chatLanguageModels.json`)
 * and expands all variables that are known before the request is made:
 *
 * `${model}`, `${modelName}`, `${provider}`, `${workspaceFolder}`, `${workspaceFolderName}`,
 * `${user}`, `${hostname}`, `${appName}`, `${date}`, `${env:NAME}`.
 *
 * `${sessionId}` and `${requestId}` are expanded later, per request, by the endpoint.
 */
export function resolveByokRequestMetadata(model: IModelIdentity, providerId: string): IRequestMetadata | undefined {
	const metadata = resolveRequestMetadata(model.configuration, model.id);
	if (!metadata) {
		return undefined;
	}
	const folder = workspace.workspaceFolders?.[0];
	return expandRequestMetadata(metadata, {
		model: model.id,
		modelName: model.name,
		provider: providerId,
		workspaceFolder: folder?.uri.fsPath,
		workspaceFolderName: folder?.name ?? workspace.name,
		user: getUserName(),
		hostname: os.hostname(),
		appName: env.appName,
		date: new Date().toISOString().slice(0, 10),
	}, process.env);
}
