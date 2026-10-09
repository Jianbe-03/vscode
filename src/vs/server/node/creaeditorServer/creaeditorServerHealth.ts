/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the `/health` answer of the CreaEditor Server.

import * as os from 'os';
import { ICreaEditorServerHealth } from '../../../platform/agentHost/common/creaeditorServer.js';
import { CreaEditorAgentHostState } from './creaeditorServerAgentHost.js';

export interface ICreaEditorServerHealthInput {
	readonly version: string;
	readonly commit?: string;
	readonly startedAt: number;
	readonly agentHost: CreaEditorAgentHostState;
	readonly runningChats?: number;
	readonly connectedClients?: number;
}

/** What the machine reports, separate so tests can pass fixed numbers. */
export interface ICreaEditorServerMachine {
	readonly platform: string;
	readonly arch: string;
	readonly cores: number;
	readonly loadAverage: number;
	readonly totalBytes: number;
	readonly freeBytes: number;
	readonly now: number;
}

export function readMachine(): ICreaEditorServerMachine {
	return {
		platform: process.platform,
		arch: process.arch,
		cores: os.availableParallelism?.() ?? os.cpus().length,
		loadAverage: os.loadavg()[0],
		totalBytes: os.totalmem(),
		freeBytes: os.freemem(),
		now: Date.now(),
	};
}

export function createCreaEditorServerHealth(input: ICreaEditorServerHealthInput, machine: ICreaEditorServerMachine): ICreaEditorServerHealth {
	const cores = Math.max(1, machine.cores);
	return {
		product: 'creaeditor-server',
		ok: input.agentHost === 'running',
		version: input.version,
		...(input.commit ? { commit: input.commit } : {}),
		platform: machine.platform,
		arch: machine.arch,
		uptimeSeconds: Math.max(0, Math.round((machine.now - input.startedAt) / 1000)),
		agentHost: input.agentHost,
		cpu: { cores, percent: Math.min(100, Math.round(machine.loadAverage / cores * 100)) },
		memory: { totalBytes: machine.totalBytes, freeBytes: machine.freeBytes },
		...(input.runningChats !== undefined ? { runningChats: input.runningChats } : {}),
		...(input.connectedClients !== undefined ? { connectedClients: input.connectedClients } : {}),
	};
}
