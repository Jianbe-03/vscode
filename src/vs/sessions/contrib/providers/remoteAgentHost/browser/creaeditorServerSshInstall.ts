/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: installs a CreaEditor Server on another computer over SSH (as a launchd or systemd
// service from a server tarball, or as a Docker container), reads the pairing link the server prints,
// and pairs this computer with it.

import { localize } from '../../../../../nls.js';
import { CREAEDITOR_SERVER_DEFAULT_PORT, ICreaEditorServerInput, parseCreaEditorServerInput } from '../../../../../platform/agentHost/common/creaeditorServer.js';
import { ISSHAgentHostConfig, ISSHRemoteAgentHostService, SSHAuthMethod } from '../../../../../platform/agentHost/common/sshRemoteAgentHost.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { pairAndAddCreaEditorServer } from './creaeditorServerPairFlow.js';
import { parseSSHHostInput } from './remoteAgentHostActions.js';

/** Where the server listens on the SSH host. */
export type CreaEditorServerSshNetwork = 'tailscale' | 'all' | 'local';

export type CreaEditorServerSshInstall =
	| { readonly kind: 'tarball'; readonly remoteTarball: string }
	| { readonly kind: 'download'; readonly downloadUrl: string }
	| { readonly kind: 'docker'; readonly image: string };

/** Quotes a value for a POSIX shell. */
function quote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The script that installs and starts the server on the SSH host and prints its pairing link (the
 * installers end with `creaeditor-server pair`; in Docker the script runs it).
 */
export function buildCreaEditorServerSshScript(install: CreaEditorServerSshInstall, network: CreaEditorServerSshNetwork, port = CREAEDITOR_SERVER_DEFAULT_PORT): string {
	const lines = [
		'set -e',
		`case ${quote(network)} in`,
		'\ttailscale) HOST="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"; if [ -z "$HOST" ]; then echo "CREAEDITOR_ERROR=tailscale" >&2; exit 3; fi ;;',
		'\tall) HOST=0.0.0.0 ;;',
		'\t*) HOST=127.0.0.1 ;;',
		'esac',
		`PORT=${port}`,
	];
	switch (install.kind) {
		case 'tarball':
		case 'download': {
			lines.push('DIR="$(mktemp -d)"', 'trap \'rm -rf "$DIR"\' EXIT');
			if (install.kind === 'tarball') {
				lines.push(`tar -xzf ${quote(install.remoteTarball)} -C "$DIR"`, `rm -f ${quote(install.remoteTarball)}`);
			} else {
				lines.push(
					'case "$(uname -s)" in Darwin) OS=darwin ;; *) OS=linux ;; esac',
					'case "$(uname -m)" in arm64 | aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac',
					`curl -fsSL ${quote(install.downloadUrl.replace(/\/+$/, ''))}"/creaeditor-server-$OS-$ARCH.tar.gz" | tar -xzf - -C "$DIR"`,
				);
			}
			lines.push('"$DIR/creaeditor-server/install.sh" --host "$HOST" --port "$PORT"');
			break;
		}
		case 'docker':
			lines.push(
				'if ! docker info >/dev/null 2>&1; then echo "CREAEDITOR_ERROR=docker" >&2; exit 4; fi',
				`IMAGE=${quote(install.image)}`,
				'docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE"',
				'docker volume create creaeditor-data >/dev/null',
				'docker rm -f creaeditor-server >/dev/null 2>&1 || true',
				'docker run -d --name creaeditor-server --restart unless-stopped -p "$HOST:$PORT:31600" -v creaeditor-data:/data -e CREAEDITOR_SERVER_PUBLIC_URL="http://$HOST:$PORT" "$IMAGE" >/dev/null',
				'i=0; until docker exec creaeditor-server creaeditor-server status >/dev/null 2>&1; do i=$((i + 1)); if [ $i -gt 60 ]; then docker logs --tail 40 creaeditor-server >&2; exit 5; fi; sleep 2; done',
				'docker exec creaeditor-server creaeditor-server pair',
			);
			break;
	}
	return lines.join('\n');
}

/** Reads the pairing link `creaeditor-server pair` printed (`Link: http://...#pair=CODE`). */
export function parseCreaEditorServerInstallOutput(output: string): ICreaEditorServerInput | undefined {
	const links = [...output.matchAll(/^\s*Link:\s+(?<link>https?:\/\/\S+)\s*$/gm)];
	const link = links.at(-1)?.groups?.link;
	return link ? parseCreaEditorServerInput(link) : undefined;
}

/** Why an install script stopped, from its `CREAEDITOR_ERROR=` marker. */
function describeInstallFailure(stderr: string, stdout: string): string {
	if (stderr.includes('CREAEDITOR_ERROR=tailscale')) {
		return localize('creaeditorServers.ssh.noTailscale', "Tailscale does not run on that computer. Install and sign in to Tailscale there, or choose another network.");
	}
	if (stderr.includes('CREAEDITOR_ERROR=docker')) {
		return localize('creaeditorServers.ssh.noDocker', "Docker does not run there, or this user may not use it (add it to the docker group).");
	}
	const tail = `${stdout}\n${stderr}`.trim().split('\n').slice(-6).join('\n');
	return localize('creaeditorServers.ssh.failed', "Installing failed: {0}", tail || localize('creaeditorServers.ssh.noOutput', "no output"));
}

async function pickSshHost(accessor: ServicesAccessor): Promise<ISSHAgentHostConfig | undefined> {
	const quickInputService = accessor.get(IQuickInputService);
	const sshService = accessor.get(ISSHRemoteAgentHostService);
	const notificationService = accessor.get(INotificationService);
	const title = localize('creaeditorServers.ssh.title', "Install CreaEditor Server over SSH");

	const aliases = await sshService.listSSHConfigHosts().catch(() => [] as string[]);
	type HostPick = IQuickPickItem & { readonly value: string };
	const picker = quickInputService.createQuickPick<HostPick>();
	picker.title = title;
	picker.placeholder = localize('creaeditorServers.ssh.hostPlaceholder', "Pick a host from your SSH config, or type user@host");
	const configItems: HostPick[] = aliases.map(alias => ({ value: alias, label: `$(remote) ${alias}` }));
	picker.items = configItems;
	const typed = picker.onDidChangeValue(value => {
		const trimmed = value.trim();
		picker.items = trimmed && !aliases.includes(trimmed) ? [{ value: trimmed, label: `$(add) ${trimmed}` }, ...configItems] : configItems;
	});
	const value = await new Promise<string | undefined>(resolve => {
		picker.onDidAccept(() => {
			resolve(picker.selectedItems[0]?.value ?? (picker.value.trim() || undefined));
			picker.hide();
		});
		picker.onDidHide(() => resolve(undefined));
		picker.show();
	});
	typed.dispose();
	picker.dispose();
	if (!value) {
		return undefined;
	}

	const parsed: { host: string; username?: string; port?: number } | undefined = aliases.includes(value) ? { host: value } : parseSSHHostInput(value);
	if (!parsed) {
		notificationService.error(localize('creaeditorServers.ssh.badHost', "Enter a host as user@host or user@host:port."));
		return undefined;
	}
	const resolved = await sshService.resolveSSHConfig(parsed.host).catch(() => undefined);
	let username = parsed.username ?? resolved?.user;
	if (!username) {
		username = (await quickInputService.input({ title, prompt: localize('creaeditorServers.ssh.user', "Enter the username for {0}.", parsed.host), ignoreFocusLost: true }))?.trim();
		if (!username) {
			return undefined;
		}
	}
	const port = parsed.port ?? (resolved?.port !== 22 ? resolved?.port : undefined);
	return {
		host: resolved?.hostname ?? parsed.host,
		...(port ? { port } : {}),
		username,
		authMethod: SSHAuthMethod.Agent,
		privateKeyPath: resolved?.identityFile[0],
		identityAgent: resolved?.identityAgent,
		name: value,
		...(aliases.includes(value) ? { sshConfigHost: value } : {}),
	};
}

/** The Install on a Computer over SSH flow of Add CreaEditor Server. */
export async function installCreaEditorServerOverSSH(accessor: ServicesAccessor): Promise<void> {
	const quickInputService = accessor.get(IQuickInputService);
	const sshService = accessor.get(ISSHRemoteAgentHostService);
	const notificationService = accessor.get(INotificationService);
	const progressService = accessor.get(IProgressService);
	const fileDialogService = accessor.get(IFileDialogService);
	const instantiationService = accessor.get(IInstantiationService);
	const title = localize('creaeditorServers.ssh.title', "Install CreaEditor Server over SSH");

	if (!sshService.runScript) {
		notificationService.error(localize('creaeditorServers.ssh.unsupported', "Installing over SSH works in the CreaEditor desktop app."));
		return;
	}
	const config = await instantiationService.invokeFunction(pickSshHost);
	if (!config) {
		return;
	}

	type InstallPick = IQuickPickItem & { readonly kind: CreaEditorServerSshInstall['kind'] };
	const how = await quickInputService.pick<InstallPick>([
		{ kind: 'tarball', label: localize('creaeditorServers.ssh.tarball', "Install as a Service from a Server Tarball..."), detail: localize('creaeditorServers.ssh.tarballDetail', "Copies a creaeditor-server-<os>-<arch>.tar.gz from this computer and installs it with launchd (macOS) or systemd (Linux).") },
		{ kind: 'download', label: localize('creaeditorServers.ssh.download', "Install as a Service from a Download URL..."), detail: localize('creaeditorServers.ssh.downloadDetail', "That computer downloads the tarball for its system from where you publish them.") },
		{ kind: 'docker', label: localize('creaeditorServers.ssh.docker', "Run with Docker..."), detail: localize('creaeditorServers.ssh.dockerDetail', "Starts the creaeditor-server image as a container with its data in a Docker volume.") },
	], { title, placeHolder: localize('creaeditorServers.ssh.howPlaceholder', "How should the server run on {0}?", config.name) });
	if (!how) {
		return;
	}

	let install: CreaEditorServerSshInstall;
	let upload: { localPath: string; remotePath: string } | undefined;
	if (how.kind === 'tarball') {
		const picked = await fileDialogService.showOpenDialog({
			title: localize('creaeditorServers.ssh.pickTarball', "Choose the Server Tarball for {0}", config.name),
			canSelectFiles: true,
			filters: [{ name: localize('creaeditorServers.ssh.tarballFilter', "Server Tarball"), extensions: ['gz'] }],
		});
		if (!picked?.[0]) {
			return;
		}
		const remoteTarball = `/tmp/creaeditor-server-${generateUuid()}.tar.gz`;
		upload = { localPath: picked[0].fsPath, remotePath: remoteTarball };
		install = { kind: 'tarball', remoteTarball };
	} else if (how.kind === 'download') {
		const downloadUrl = (await quickInputService.input({ title, prompt: localize('creaeditorServers.ssh.downloadPrompt', "The address where creaeditor-server-<os>-<arch>.tar.gz files are published."), placeHolder: 'https://downloads.example.com/creaeditor-server', ignoreFocusLost: true, validateInput: async input => /^https?:\/\/\S+$/.test(input.trim()) ? undefined : localize('creaeditorServers.ssh.downloadInvalid', "Enter an http(s) address.") }))?.trim();
		if (!downloadUrl) {
			return;
		}
		install = { kind: 'download', downloadUrl };
	} else {
		const image = (await quickInputService.input({ title, prompt: localize('creaeditorServers.ssh.imagePrompt', "The Docker image to run (built with build/creaeditor-server/Dockerfile)."), value: 'creaeditor-server:latest', ignoreFocusLost: true }))?.trim();
		if (!image) {
			return;
		}
		install = { kind: 'docker', image };
	}

	type NetworkPick = IQuickPickItem & { readonly network: CreaEditorServerSshNetwork };
	const network = await quickInputService.pick<NetworkPick>([
		{ network: 'tailscale', label: localize('creaeditorServers.ssh.tailscale', "Tailscale (Recommended)"), detail: localize('creaeditorServers.ssh.tailscaleDetail', "Only your own devices reach it, encrypted. Tailscale must run on both computers.") },
		{ network: 'all', label: localize('creaeditorServers.ssh.all', "Every Network of That Computer"), detail: localize('creaeditorServers.ssh.allDetail', "Plain HTTP on 0.0.0.0: use on a trusted network only.") },
		{ network: 'local', label: localize('creaeditorServers.ssh.local', "Only That Computer"), detail: localize('creaeditorServers.ssh.localDetail', "For a public domain (Caddy) or Tailscale Funnel you set up there; you enter its address next.") },
	], { title, placeHolder: localize('creaeditorServers.ssh.networkPlaceholder', "How will this computer reach the server?") });
	if (!network) {
		return;
	}

	const script = buildCreaEditorServerSshScript(install, network.network);
	let result;
	try {
		result = await progressService.withProgress(
			{ location: ProgressLocation.Notification, title: localize('creaeditorServers.ssh.installing', "Installing CreaEditor Server on {0}...", config.name) },
			() => sshService.runScript!(config, script, upload),
		);
	} catch (error) {
		notificationService.error(localize('creaeditorServers.ssh.connectFailed', "Could not connect to {0}: {1}", config.name, error instanceof Error ? error.message : String(error)));
		return;
	}
	const pairing = result.code === 0 ? parseCreaEditorServerInstallOutput(result.stdout) : undefined;
	if (!pairing) {
		notificationService.error(describeInstallFailure(result.stderr, result.stdout));
		return;
	}

	let input = pairing;
	if (network.network === 'local') {
		// The server only listens on that computer: ask where its proxy publishes it.
		const address = (await quickInputService.input({ title, prompt: localize('creaeditorServers.ssh.publicAddress', "The server runs. Enter the address this computer reaches it at (your domain or Funnel address)."), placeHolder: 'https://agents.example.com', ignoreFocusLost: true }))?.trim();
		const parsed = address ? parseCreaEditorServerInput(address) : undefined;
		if (!parsed) {
			notificationService.info(localize('creaeditorServers.ssh.installedNotPaired', "CreaEditor Server runs on {0}. Add it with Add CreaEditor Server once it is reachable.", config.name));
			return;
		}
		input = { ...parsed, ...(pairing.pairingCode ? { pairingCode: pairing.pairingCode } : {}) };
	}
	await instantiationService.invokeFunction(pairAndAddCreaEditorServer, input, network.network === 'local', { sshHost: config.sshConfigHost ?? `${config.username}@${config.host}`, name: config.name });
}
