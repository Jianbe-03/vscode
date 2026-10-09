/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: on a CreaEditor Server, the agent host publishes how busy its machine is (CPU, memory)
// as a transient root config value, so every client sees it with the server's chats.

import * as os from 'os';
import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { CREAEDITOR_SERVER_MACHINE_KEY, ICreaEditorServerMachine } from '../../common/creaeditorServer.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';

/** Set (to `1`) by the CreaEditor Server for the agent host it runs. */
export const AGENT_HOST_PUBLISH_MACHINE_ENV_VAR = 'CREAEDITOR_AGENT_HOST_PUBLISH_MACHINE';

const PUBLISH_INTERVAL_MS = 30_000;

/** The machine reading of now. */
export function readServerMachine(now = Date.now()): ICreaEditorServerMachine {
	const cores = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
	return {
		cpuPercent: Math.min(100, Math.round(os.loadavg()[0] / cores * 100)),
		cores,
		memoryTotalBytes: os.totalmem(),
		memoryFreeBytes: os.freemem(),
		updatedAt: now,
	};
}

/** Publishes {@link readServerMachine} every 30 seconds while it lives. */
export class ServerMachineStatusPublisher extends Disposable {
	private readonly _timer = this._register(new IntervalTimer());

	constructor(@IAgentConfigurationService private readonly _configurationService: IAgentConfigurationService) {
		super();
		this._publish();
		this._timer.cancelAndSet(() => this._publish(), PUBLISH_INTERVAL_MS);
	}

	private _publish(): void {
		this._configurationService.publishRootTransientValues?.({ [CREAEDITOR_SERVER_MACHINE_KEY]: readServerMachine() });
	}
}
