/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the agent host of a CreaEditor Server writes how many chats run and wait to a small
// file, so the server's front can tell a paired device in `/health` (it has no agent host connection).

import * as fs from 'fs';
import { ICreaEditorServerChats, readCreaEditorServerChats, CREAEDITOR_SERVER_CHATS_KEY } from '../../common/creaeditorServer.js';

/** Set by the CreaEditor Server: how many chats may run at once (a positive integer). */
export const AGENT_HOST_MAX_RUNNING_CHATS_ENV_VAR = 'CREAEDITOR_AGENT_HOST_MAX_RUNNING_CHATS';

/** Set by the CreaEditor Server: where the agent host writes {@link ICreaEditorServerChats}. */
export const AGENT_HOST_CHATS_STATUS_FILE_ENV_VAR = 'CREAEDITOR_AGENT_HOST_CHATS_STATUS_FILE';

/** Writes the counts (atomically); errors are ignored, the file is only informational. */
export function writeServerChatsStatus(file: string, chats: ICreaEditorServerChats): void {
	try {
		const temp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(chats), { mode: 0o600 });
		fs.renameSync(temp, file);
	} catch {
		// Informational only.
	}
}

/** Reads the counts the agent host wrote; undefined before it wrote any. */
export function readServerChatsStatus(file: string): ICreaEditorServerChats | undefined {
	try {
		return readCreaEditorServerChats({ [CREAEDITOR_SERVER_CHATS_KEY]: JSON.parse(fs.readFileSync(file, 'utf8')) });
	} catch {
		return undefined;
	}
}
