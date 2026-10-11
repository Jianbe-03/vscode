/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: desktop windows send CreaEditor Server API requests (and ntfy test notifications) from
// the main process, where CORS and the window CSP do not apply.

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { CREAEDITOR_SERVER_HTTP_CHANNEL_NAME, ICreaEditorServerHttpService } from '../common/creaeditorServerHttp.js';

registerMainProcessRemoteService(ICreaEditorServerHttpService, CREAEDITOR_SERVER_HTTP_CHANNEL_NAME);
