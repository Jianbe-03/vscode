/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: windows reach Remote Access, which runs in the main process.

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { IRemoteAccessService, REMOTE_ACCESS_CHANNEL_NAME } from '../common/remoteAccess.js';

registerMainProcessRemoteService(IRemoteAccessService, REMOTE_ACCESS_CHANNEL_NAME);
