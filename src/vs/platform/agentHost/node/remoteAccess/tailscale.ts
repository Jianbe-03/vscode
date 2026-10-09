/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: reads the Tailscale address Remote Access listens on, and turns Tailscale Funnel
// (public HTTPS) on and off. Funnel is only changed when the user asks for it.

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { delimiter, join } from '../../../../base/common/path.js';

/** What Remote Access needs to know about Tailscale on this machine. */
export interface ITailscaleStatus {
	/** The CLI was found. */
	readonly installed: boolean;
	/** Signed in and connected (`BackendState` is `Running`). */
	readonly running: boolean;
	/** E.g. `Stopped`, `NeedsLogin`, `Running`. */
	readonly backendState?: string;
	/** This machine's Tailscale IPv4 address. */
	readonly ipv4?: string;
	/** This machine's MagicDNS name without the trailing dot, e.g. `my-mac.tailnet.ts.net`. */
	readonly dnsName?: string;
	readonly cliPath?: string;
}

const MAC_APP_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const COMMAND_TIMEOUT_MS = 15_000;
const FUNNEL_TIMEOUT_MS = 45_000;

/** The Tailscale CLI: the macOS app's binary, else `tailscale` on the PATH. */
export async function findTailscaleCli(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const candidates = process.platform === 'darwin' ? [MAC_APP_CLI] : [];
	for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
		candidates.push(join(directory, process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'));
	}
	if (process.platform === 'darwin') {
		candidates.push('/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale');
	}
	for (const candidate of candidates) {
		try {
			await fs.access(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// next
		}
	}
	return undefined;
}

/** Reads `tailscale status --json` (and `tailscale ip -4` as a fallback for the address). */
export async function getTailscaleStatus(cliPath?: string): Promise<ITailscaleStatus> {
	const cli = cliPath ?? await findTailscaleCli();
	if (!cli) {
		return { installed: false, running: false };
	}
	let status: ITailscaleStatus = { installed: true, running: false, cliPath: cli };
	try {
		status = { ...status, ...parseTailscaleStatus(await run(cli, ['status', '--json'], COMMAND_TIMEOUT_MS)) };
	} catch {
		// Not connected: `status` exits non-zero when stopped or signed out.
	}
	if (!status.ipv4) {
		try {
			const ipv4 = (await run(cli, ['ip', '-4'], COMMAND_TIMEOUT_MS)).trim().split(/\s+/)[0];
			if (ipv4 && isIPv4(ipv4)) {
				status = { ...status, ipv4 };
			}
		} catch {
			// ignore
		}
	}
	return status;
}

/** Extracts the state, address and MagicDNS name from `tailscale status --json` output. */
export function parseTailscaleStatus(json: string): Partial<ITailscaleStatus> {
	const data = JSON.parse(json) as { BackendState?: unknown; Self?: { TailscaleIPs?: unknown; DNSName?: unknown } };
	const backendState = typeof data.BackendState === 'string' ? data.BackendState : undefined;
	const ips = Array.isArray(data.Self?.TailscaleIPs) ? data.Self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string') : [];
	const dnsName = typeof data.Self?.DNSName === 'string' && data.Self.DNSName ? data.Self.DNSName.replace(/\.$/, '') : undefined;
	return { backendState, running: backendState === 'Running', ipv4: ips.find(isIPv4), dnsName };
}

/**
 * Turns on Tailscale Funnel for `https://<magicdns-name>/` to `http://127.0.0.1:<port>`
 * (`tailscale funnel --bg --yes <port>`). Only call this when the user turned public access on.
 * Rejects with the CLI's output, which may contain a link to allow Funnel for the tailnet.
 */
export async function enableTailscaleFunnel(cliPath: string, port: number): Promise<void> {
	await run(cliPath, ['funnel', '--bg', '--yes', String(port)], FUNNEL_TIMEOUT_MS);
}

/** Turns Tailscale Funnel off for HTTPS port 443 (`tailscale funnel --https=443 off`). */
export async function disableTailscaleFunnel(cliPath: string): Promise<void> {
	await run(cliPath, ['funnel', '--https=443', 'off'], COMMAND_TIMEOUT_MS);
}

/** The public URL of a Funnel to `port`, from `tailscale funnel status --json`, if one is on. */
export async function getTailscaleFunnelUrl(cliPath: string, port: number): Promise<string | undefined> {
	try {
		return parseFunnelStatus(await run(cliPath, ['funnel', 'status', '--json'], COMMAND_TIMEOUT_MS), port);
	} catch {
		return undefined;
	}
}

/**
 * Finds the public URL in `tailscale funnel status --json` output (a serve config): a web
 * handler that proxies to `port` on this machine on a host:port that allows Funnel.
 */
export function parseFunnelStatus(json: string, port: number): string | undefined {
	if (!json.trim()) {
		return undefined;
	}
	const config = JSON.parse(json) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>; AllowFunnel?: Record<string, unknown> };
	const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`);
	for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
		if (config.AllowFunnel?.[hostPort] !== true) {
			continue;
		}
		const proxies = Object.values(web.Handlers ?? {}).map(handler => handler.Proxy);
		if (!proxies.some(proxy => typeof proxy === 'string' && target.test(proxy))) {
			continue;
		}
		const separator = hostPort.lastIndexOf(':');
		const host = separator > 0 ? hostPort.slice(0, separator) : hostPort;
		const httpsPort = separator > 0 ? hostPort.slice(separator + 1) : '443';
		return httpsPort === '443' ? `https://${host}` : `https://${host}:${httpsPort}`;
	}
	return undefined;
}

/** The first `https://login.tailscale.com/...` link in CLI output, e.g. to allow Funnel. */
export function findTailscaleLink(output: string): string | undefined {
	return /https:\/\/login\.tailscale\.com\/\S+/.exec(output)?.[0];
}

function isIPv4(value: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

function run(cli: string, args: readonly string[], timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cli, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`${stdout}\n${stderr}`.trim() || error.message));
				return;
			}
			resolve(stdout);
		});
	});
}
