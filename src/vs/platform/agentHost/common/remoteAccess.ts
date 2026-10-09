/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: Remote Access lets a phone or another computer use this Mac's Agents window. The
// main process runs the server (see node/remoteAccess/README.md); windows talk to it through
// IRemoteAccessService.

import { Event } from '../../../base/common/event.js';
import { localize } from '../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { Registry } from '../../registry/common/platform.js';

export const RemoteAccessEnabledSettingId = 'creaeditor.remoteAccess.enabled';
export const RemoteAccessNetworkSettingId = 'creaeditor.remoteAccess.network';
export const RemoteAccessPortSettingId = 'creaeditor.remoteAccess.port';

/** Where Remote Access listens. */
export const enum RemoteAccessNetwork {
	/** This Mac's Tailscale address (the default). */
	Tailscale = 'tailscale',
	/** 127.0.0.1 only, for trying it out on this Mac. */
	Localhost = 'localhost',
}

export const REMOTE_ACCESS_DEFAULT_PORT = 8790;
export const REMOTE_ACCESS_CHANNEL_NAME = 'creaeditorRemoteAccess';
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';

export const enum RemoteAccessState {
	Off = 'off',
	Starting = 'starting',
	On = 'on',
	Error = 'error',
}

/** A paired device, as shown in the devices list. */
export interface IRemoteAccessDeviceInfo {
	readonly id: string;
	readonly name: string;
	readonly createdAt: number;
	readonly lastSeenAt: number;
	readonly pairedPublicly: boolean;
}

/** Everything the Remote Access UI shows. */
export interface IRemoteAccessStatus {
	readonly state: RemoteAccessState;
	readonly network: RemoteAccessNetwork;
	readonly port: number;
	/** The address devices on the tailnet (or this Mac, with localhost) open. */
	readonly url?: string;
	/** The same through MagicDNS, when Tailscale has a name for this Mac. */
	readonly magicDnsUrl?: string;
	/** The user turned public access (Tailscale Funnel) on. */
	readonly publicAccess: boolean;
	/** The https URL of the Funnel, once Tailscale reports it. */
	readonly publicUrl?: string;
	readonly tailscale: {
		readonly installed: boolean;
		readonly running: boolean;
		readonly backendState?: string;
		readonly ipv4?: string;
		readonly dnsName?: string;
	};
	readonly hasPassword: boolean;
	/** A chat runs while Remote Access is on, so the Mac does not sleep. */
	readonly keepingAwake: boolean;
	/** Open connections of devices. */
	readonly connections: number;
	readonly devices: readonly IRemoteAccessDeviceInfo[];
	/** The app includes the web Agents window. */
	readonly webUi: boolean;
	/** Why Remote Access is in the error state, ready to show. */
	readonly error?: string;
}

/** A pairing code and the link a device opens (shown as a QR code). */
export interface IRemoteAccessPairing {
	readonly code: string;
	readonly url: string;
	readonly expiresAt: number;
}

export const IRemoteAccessService = createDecorator<IRemoteAccessService>('remoteAccessService');

/**
 * Remote Access, run by the main process. Turn it on and off with
 * {@link RemoteAccessEnabledSettingId}.
 */
export interface IRemoteAccessService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeStatus: Event<IRemoteAccessStatus>;

	getStatus(): Promise<IRemoteAccessStatus>;
	/** A new one-time pairing code (replaces the previous one). Remote Access must be on. */
	createPairing(): Promise<IRemoteAccessPairing>;
	/** Signs a device out and closes its connections. */
	signOutDevice(id: string): Promise<void>;
	/** Sets or (with `undefined`) removes the password devices give to pair over public access. */
	setPassword(password: string | undefined): Promise<void>;
	/**
	 * Turns public access over Tailscale Funnel on or off. Turning it on needs Tailscale and a
	 * password; rejects with a message to show (that may include a Tailscale link).
	 */
	setPublicAccess(enabled: boolean): Promise<void>;
	/** Checks Tailscale again and restarts the server when its address changed. */
	refresh(): Promise<void>;
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'creaeditor.remoteAccess',
	title: localize('remoteAccess.title', "Remote Access"),
	type: 'object',
	properties: {
		[RemoteAccessEnabledSettingId]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			ignoreSync: true,
			markdownDescription: localize('remoteAccess.enabled', "Allow phones and other devices to use the Agents window of this Mac over Tailscale. Pair devices with the **Remote Access** command."),
		},
		[RemoteAccessNetworkSettingId]: {
			type: 'string',
			enum: [RemoteAccessNetwork.Tailscale, RemoteAccessNetwork.Localhost],
			enumDescriptions: [
				localize('remoteAccess.network.tailscale', "Listen on this Mac's Tailscale address, so devices in your tailnet can connect."),
				localize('remoteAccess.network.localhost', "Listen on 127.0.0.1 only, to try Remote Access in a browser on this Mac."),
			],
			default: RemoteAccessNetwork.Tailscale,
			scope: ConfigurationScope.APPLICATION,
			ignoreSync: true,
			description: localize('remoteAccess.network', "Where Remote Access listens."),
		},
		[RemoteAccessPortSettingId]: {
			type: 'number',
			default: REMOTE_ACCESS_DEFAULT_PORT,
			minimum: 1024,
			maximum: 65535,
			scope: ConfigurationScope.APPLICATION,
			ignoreSync: true,
			description: localize('remoteAccess.port', "The port Remote Access listens on."),
		},
	},
});
