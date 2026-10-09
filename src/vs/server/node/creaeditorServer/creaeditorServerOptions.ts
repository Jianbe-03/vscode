/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the command line of `creaeditor-server`.

import { join } from '../../../base/common/path.js';
import { CREAEDITOR_SERVER_DEFAULT_PORT } from '../../../platform/agentHost/common/creaeditorServer.js';

export type CreaEditorServerCommand = 'serve' | 'pair' | 'password' | 'status' | 'help' | 'version';

export interface ICreaEditorServerOptions {
	readonly command: CreaEditorServerCommand;
	/** The address the web page and the agent host listen on. */
	readonly host: string;
	readonly port: number;
	/** Sessions, accounts, secrets, worktrees and logs. */
	readonly dataDir: string;
	/** `trace`, `debug`, `info`, `warn`, `error` or `off`. */
	readonly logLevel: string;
	/** The address people reach the server at (a public domain or a Tailscale name), for pairing links. */
	readonly publicUrl?: string;
	/**
	 * Whether the server is reachable from the internet (a public domain or Tailscale Funnel): pairing
	 * then needs the password too.
	 */
	readonly public: boolean;
	/** Whether the Codex agent is offered (Claude always is). */
	readonly enableCodex: boolean;
	/** Development: a scripted agent instead of Claude and Codex, for tests. */
	readonly enableMockAgent: boolean;
}

/** Where the server runs, for the defaults. */
export interface ICreaEditorServerEnvironment {
	readonly env: { readonly [name: string]: string | undefined };
	readonly platform: NodeJS.Platform;
	readonly homeDir: string;
	/** Whether this runs in a container (`/.dockerenv`, or `CREAEDITOR_SERVER_DOCKER=1`). */
	readonly inDocker: boolean;
}

export class CreaEditorServerOptionsError extends Error { }

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'off'];

/** The data folder when none is given: `/data` in Docker, else `~/.creaeditor-server`. */
export function getDefaultDataDir(environment: ICreaEditorServerEnvironment): string {
	return environment.inDocker ? '/data' : join(environment.homeDir, '.creaeditor-server');
}

/**
 * Reads `creaeditor-server [serve|pair|status|help|version] [--host <address>] [--port <port>]
 * [--data-dir <folder>] [--public-url <url>] [--log <level>] [--enable-codex|--disable-codex]`. Every
 * option also has an environment variable (`CREAEDITOR_SERVER_HOST`, `_PORT`, `_DATA_DIR`, `_PUBLIC_URL`,
 * `_LOG`, `_CODEX=0|1`); the command line wins. Defaults: `0.0.0.0` in Docker, else `127.0.0.1`; port
 * {@link CREAEDITOR_SERVER_DEFAULT_PORT}.
 */
export function parseCreaEditorServerOptions(argv: readonly string[], environment: ICreaEditorServerEnvironment): ICreaEditorServerOptions {
	// An empty variable (such as `VAR=` in a compose file) counts as unset.
	const env = (name: string) => environment.env[name] || undefined;
	let command: CreaEditorServerCommand | undefined;
	const values = new Map<string, string>();
	const flags = new Set<string>();
	const valueOptions = new Set(['host', 'port', 'data-dir', 'public-url', 'log']);
	const flagOptions = new Set(['public', 'enable-codex', 'disable-codex', 'enable-mock-agent', 'help', 'version']);

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg.startsWith('--')) {
			const [name, inline] = splitOption(arg.slice(2));
			if (valueOptions.has(name)) {
				const value = inline ?? argv[++index];
				if (value === undefined || (inline === undefined && value.startsWith('--'))) {
					throw new CreaEditorServerOptionsError(`--${name} needs a value.`);
				}
				values.set(name, value);
			} else if (flagOptions.has(name) && inline === undefined) {
				flags.add(name);
			} else {
				throw new CreaEditorServerOptionsError(`Unknown option --${name}.`);
			}
		} else if (arg === '-h') {
			flags.add('help');
		} else if (!command && isCommand(arg)) {
			command = arg;
		} else {
			throw new CreaEditorServerOptionsError(`Unknown command '${arg}'.`);
		}
	}

	if (flags.has('help')) {
		command = 'help';
	} else if (flags.has('version')) {
		command = 'version';
	}

	const portText = values.get('port') ?? env('CREAEDITOR_SERVER_PORT');
	const port = portText === undefined ? CREAEDITOR_SERVER_DEFAULT_PORT : Number(portText);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new CreaEditorServerOptionsError(`--port must be a number from 0 to 65535, not '${portText}'.`);
	}

	const logLevel = values.get('log') ?? env('CREAEDITOR_SERVER_LOG') ?? 'info';
	if (!LOG_LEVELS.includes(logLevel)) {
		throw new CreaEditorServerOptionsError(`--log must be one of ${LOG_LEVELS.join(', ')}.`);
	}

	const publicUrl = values.get('public-url') ?? env('CREAEDITOR_SERVER_PUBLIC_URL') ?? (env('CREAEDITOR_PUBLIC_DOMAIN') ? `https://${env('CREAEDITOR_PUBLIC_DOMAIN')}` : undefined);
	if (publicUrl !== undefined && !/^https?:\/\/[^\s/]+/i.test(publicUrl)) {
		throw new CreaEditorServerOptionsError(`--public-url must start with http:// or https://, not '${publicUrl}'.`);
	}

	if (flags.has('enable-codex') && flags.has('disable-codex')) {
		throw new CreaEditorServerOptionsError('--enable-codex and --disable-codex cannot be used together.');
	}
	const enableCodex = flags.has('enable-codex') || (!flags.has('disable-codex') && env('CREAEDITOR_SERVER_CODEX') !== '0');

	return {
		command: command ?? 'serve',
		host: values.get('host') ?? env('CREAEDITOR_SERVER_HOST') ?? (environment.inDocker ? '0.0.0.0' : '127.0.0.1'),
		port,
		dataDir: values.get('data-dir') ?? env('CREAEDITOR_SERVER_DATA_DIR') ?? getDefaultDataDir(environment),
		logLevel,
		...(publicUrl ? { publicUrl: publicUrl.replace(/\/+$/, '') } : {}),
		public: flags.has('public') || env('CREAEDITOR_SERVER_PUBLIC') === '1' || !!env('CREAEDITOR_PUBLIC_DOMAIN'),
		enableCodex,
		enableMockAgent: flags.has('enable-mock-agent'),
	};
}

function splitOption(option: string): [string, string | undefined] {
	const equals = option.indexOf('=');
	return equals === -1 ? [option, undefined] : [option.slice(0, equals), option.slice(equals + 1)];
}

function isCommand(value: string): value is CreaEditorServerCommand {
	return value === 'serve' || value === 'pair' || value === 'password' || value === 'status' || value === 'help' || value === 'version';
}

/** The `creaeditor-server help` text. */
export const CREAEDITOR_SERVER_USAGE = `CreaEditor Server: runs CreaEditor's agents on this machine for your laptop and phone.

Usage: creaeditor-server [command] [options]

Commands:
  serve        Start the server (default).
  pair         Print a new one-time pairing code for a laptop or phone.
  password     Set the password that pairing needs when the server is public.
  status       Show whether the server runs, its address and its agents.
  version      Print the version.
  help         Show this help.

Options (environment variable in brackets):
  --host <address>     Address to listen on [CREAEDITOR_SERVER_HOST]
                       (default 127.0.0.1; 0.0.0.0 in Docker)
  --port <port>        Port to listen on [CREAEDITOR_SERVER_PORT] (default ${CREAEDITOR_SERVER_DEFAULT_PORT})
  --data-dir <folder>  Sessions, accounts, secrets, worktrees and logs [CREAEDITOR_SERVER_DATA_DIR]
                       (default ~/.creaeditor-server; /data in Docker)
  --public-url <url>   Address people reach this server at, used in pairing links
                       [CREAEDITOR_SERVER_PUBLIC_URL, or https://$CREAEDITOR_PUBLIC_DOMAIN]
  --public             Reachable from the internet: pairing also needs the password
                       [CREAEDITOR_SERVER_PUBLIC=1; on when CREAEDITOR_PUBLIC_DOMAIN is set]
  --log <level>        trace, debug, info, warn, error or off [CREAEDITOR_SERVER_LOG] (default info)
  --disable-codex      Do not offer the Codex agent [CREAEDITOR_SERVER_CODEX=0]
`;
