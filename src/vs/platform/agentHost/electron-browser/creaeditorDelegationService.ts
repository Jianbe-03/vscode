/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: windows reach Delegate to Server, which runs in the main process.

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { CREAEDITOR_DELEGATION_CHANNEL_NAME, ICreaEditorDelegationService } from '../common/creaeditorDelegation.js';

registerMainProcessRemoteService(ICreaEditorDelegationService, CREAEDITOR_DELEGATION_CHANNEL_NAME);
