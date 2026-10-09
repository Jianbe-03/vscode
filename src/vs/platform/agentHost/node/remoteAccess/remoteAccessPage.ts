/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the page a device opens for Remote Access. It pairs the device (pairing code from the
// QR code's URL fragment, plus the password with public access), keeps the device key in
// localStorage, then boots the web Agents window (`sessions.web.main.internal`) from `/static/`
// against this origin's agent host WebSocket.

import { localize } from '../../../../nls.js';

/** localStorage key of the device key on the device. */
export const REMOTE_ACCESS_DEVICE_KEY_STORAGE_KEY = 'creaeditor.remoteAccess.deviceKey';

/** The HTML of `/`. Self-contained: inline styles and script, strings localized on the server. */
export function renderRemoteAccessPage(): string {
	const strings = {
		pairTitle: localize('remoteAccess.page.pairTitle', "Pair This Device"),
		pairIntro: localize('remoteAccess.page.pairIntro', "On your Mac, open Remote Access in CreaEditor and scan its QR code with this device, or type the pairing code shown there."),
		pairIntroFromCode: localize('remoteAccess.page.pairIntroFromCode', "Name this device to finish pairing it with {0}."),
		code: localize('remoteAccess.page.code', "Pairing Code"),
		deviceName: localize('remoteAccess.page.deviceName', "Device Name"),
		password: localize('remoteAccess.page.password', "Password"),
		passwordHint: localize('remoteAccess.page.passwordHint', "This Mac is reachable from the internet, so it also asks for its Remote Access password."),
		pair: localize('remoteAccess.page.pair', "Pair"),
		pairing: localize('remoteAccess.page.pairing', "Pairing…"),
		connecting: localize('remoteAccess.page.connecting', "Connecting to {0}…"),
		signedOut: localize('remoteAccess.page.signedOut', "This device was signed out. Pair it again to continue."),
		noWebUi: localize('remoteAccess.page.noWebUi', "This CreaEditor build does not include the web Agents window. Rebuild the app with scripts/creaeditor-build-macos.sh."),
		failed: localize('remoteAccess.page.failed', "Could not reach your Mac. Check that Remote Access is on and that this device is connected to Tailscale."),
		invalidCode: localize('remoteAccess.page.invalidCode', "That pairing code is not valid. Create a new one on your Mac."),
		expiredCode: localize('remoteAccess.page.expiredCode', "That pairing code expired. Create a new one on your Mac."),
		passwordRequired: localize('remoteAccess.page.passwordRequired', "Enter the Remote Access password."),
		wrongPassword: localize('remoteAccess.page.wrongPassword', "Wrong password."),
		noPasswordSet: localize('remoteAccess.page.noPasswordSet', "Public access needs a password. Set one in Remote Access on your Mac first."),
		lockedOut: localize('remoteAccess.page.lockedOut', "Too many attempts. Try again in {0} minutes."),
		thisMac: localize('remoteAccess.page.thisMac', "your Mac"),
	};
	const json = JSON.stringify({ strings, storageKey: REMOTE_ACCESS_DEVICE_KEY_STORAGE_KEY }).replace(/</g, '\\u003c');

	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no, viewport-fit=cover" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-title" content="CreaEditor" />
	<meta name="color-scheme" content="light dark" />
	<title>CreaEditor</title>
	<style>
		:root { --bg: #f8f8f8; --fg: #1f1f1f; --muted: #616161; --border: #d4d4d4; --accent: #005fb8; --accent-fg: #ffffff; --error: #c72e2e; --input: #ffffff; }
		@media (prefers-color-scheme: dark) {
			:root { --bg: #1f1f1f; --fg: #cccccc; --muted: #9d9d9d; --border: #3c3c3c; --accent: #0078d4; --accent-fg: #ffffff; --error: #f48771; --input: #313131; }
		}
		html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
		.ra-card { box-sizing: border-box; max-width: 420px; margin: 0 auto; padding: max(32px, env(safe-area-inset-top)) 16px 32px; }
		.ra-card h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
		.ra-card p { margin: 0 0 16px; color: var(--muted); }
		.ra-card label { display: block; font-size: 13px; font-weight: 600; margin: 16px 0 6px; }
		.ra-card input { box-sizing: border-box; width: 100%; padding: 10px 12px; font-size: 16px; border-radius: 6px; border: 1px solid var(--border); background: var(--input); color: var(--fg); }
		.ra-card input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
		.ra-card button { width: 100%; margin-top: 24px; padding: 12px; font-size: 16px; font-weight: 600; border: 0; border-radius: 6px; background: var(--accent); color: var(--accent-fg); }
		.ra-card button:disabled { opacity: 0.6; }
		.ra-error { color: var(--error) !important; margin-top: 16px !important; }
		.ra-hint { font-size: 13px; margin-top: 6px !important; }
		[hidden] { display: none !important; }
	</style>
</head>
<body aria-label="">
	<div class="ra-card" id="ra-card" hidden>
		<h1 id="ra-title"></h1>
		<p id="ra-intro"></p>
		<form id="ra-form" hidden>
			<div id="ra-code-row">
				<label for="ra-code" id="ra-code-label"></label>
				<input id="ra-code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" />
			</div>
			<label for="ra-name" id="ra-name-label"></label>
			<input id="ra-name" autocomplete="off" />
			<div id="ra-password-row" hidden>
				<label for="ra-password" id="ra-password-label"></label>
				<input id="ra-password" type="password" autocomplete="current-password" />
				<p class="ra-hint" id="ra-password-hint"></p>
			</div>
			<button type="submit" id="ra-submit"></button>
		</form>
		<p class="ra-error" id="ra-error" role="alert" hidden></p>
	</div>
	<script type="module">
${PAGE_SCRIPT.replace('__CONFIG__', () => json)}
	</script>
</body>
</html>`;
}

const PAGE_SCRIPT = `
const config = __CONFIG__;
const s = config.strings;
const $ = id => document.getElementById(id);
const format = (text, ...args) => text.replace(/\\{(\\d+)\\}/g, (match, index) => args[Number(index)] ?? match);
const readKey = () => { try { return localStorage.getItem(config.storageKey) ?? undefined; } catch { return undefined; } };
const writeKey = key => { try { if (key) { localStorage.setItem(config.storageKey, key); } else { localStorage.removeItem(config.storageKey); } } catch { } };

function defaultDeviceName() {
	const ua = navigator.userAgent;
	const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? (navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac') : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
	const browser = /EdgA?\\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : '';
	return browser ? device + ' (' + browser + ')' : device;
}

function showCard(title, intro) {
	$('ra-card').hidden = false;
	$('ra-title').textContent = title;
	$('ra-intro').textContent = intro;
}

function showError(message) {
	$('ra-error').hidden = !message;
	$('ra-error').textContent = message ?? '';
}

function showPairForm(info, code, error) {
	const hostName = info.hostName || s.thisMac;
	showCard(s.pairTitle, code ? format(s.pairIntroFromCode, hostName) : s.pairIntro);
	$('ra-form').hidden = false;
	$('ra-code-row').hidden = !!code;
	$('ra-code-label').textContent = s.code;
	$('ra-code').value = code ?? '';
	$('ra-name-label').textContent = s.deviceName;
	$('ra-name').value = defaultDeviceName();
	$('ra-password-row').hidden = !info.passwordRequired;
	$('ra-password-label').textContent = s.password;
	$('ra-password-hint').textContent = s.passwordHint;
	$('ra-submit').textContent = s.pair;
	showError(error);
	$('ra-form').onsubmit = async event => {
		event.preventDefault();
		$('ra-submit').disabled = true;
		$('ra-submit').textContent = s.pairing;
		showError(undefined);
		try {
			const response = await fetch('/api/pair', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ code: $('ra-code').value, deviceName: $('ra-name').value, password: info.passwordRequired ? $('ra-password').value : undefined }),
			});
			const result = await response.json();
			if (response.ok && result.deviceKey) {
				writeKey(result.deviceKey);
				$('ra-form').hidden = true;
				await boot(info, result.deviceKey);
				return;
			}
			const reason = result.error;
			showError(reason === 'lockedOut' ? format(s.lockedOut, Math.max(1, Math.ceil((result.retryAfterSeconds ?? 60) / 60))) : (s[reason] ?? s.invalidCode));
			if (reason === 'invalidCode' || reason === 'expiredCode') {
				$('ra-code-row').hidden = false;
			}
		} catch {
			showError(s.failed);
		}
		$('ra-submit').disabled = false;
		$('ra-submit').textContent = s.pair;
	};
}

async function boot(info, deviceKey) {
	if (!info.webUi) {
		showCard(s.pairTitle, s.noWebUi);
		return;
	}
	showCard(format(s.connecting, info.hostName || s.thisMac), '');
	const staticRoot = location.origin + '/static/';
	globalThis._VSCODE_FILE_ROOT = staticRoot;
	const stylesheet = document.createElement('link');
	stylesheet.rel = 'stylesheet';
	stylesheet.href = staticRoot + 'vs/sessions/sessions.web.main.internal.css';
	document.head.appendChild(stylesheet);
	try {
		await import(staticRoot + 'nls.messages.js');
	} catch {
		// English strings are built in.
	}
	const { create } = await import(staticRoot + 'vs/sessions/sessions.web.main.internal.js');
	// The welcome and sign-in flow is for vscode.dev; this page talks to the Mac's agent host directly.
	history.replaceState(null, '', '/?skip-sessions-welcome');
	$('ra-card').remove();
	const address = location.protocol === 'https:' ? 'wss://' + location.host + '/ahp' : location.host + '/ahp';
	create(document.body, {
		productConfiguration: { nameShort: 'CreaEditor', nameLong: 'CreaEditor Agents', enableTelemetry: false },
		configurationDefaults: {
			'chat.remoteAgentHostsEnabled': true,
			'chat.remoteAgentHosts': [{ address, name: info.hostName || 'Mac', connectionToken: deviceKey }],
		},
		workspaceProvider: {
			workspace: undefined,
			trusted: true,
			open: async () => false,
			payload: [['isSessionsWindow', 'true']],
		},
	});
	// Notice when this device is signed out on the Mac.
	setInterval(async () => {
		try {
			const response = await fetch('/api/device', { headers: { Authorization: 'Bearer ' + deviceKey } });
			if (response.status === 401) {
				writeKey(undefined);
				location.replace('/#signedOut');
				location.reload();
			}
		} catch {
			// Offline: the workbench shows the connection state.
		}
	}, 60000);
}

async function main() {
	let info;
	try {
		info = await (await fetch('/api/info')).json();
	} catch {
		showCard(s.pairTitle, s.failed);
		return;
	}
	const fragment = new URLSearchParams(location.hash.slice(1));
	const code = fragment.get('pair') ?? undefined;
	const signedOut = fragment.has('signedOut');
	if (location.hash) {
		// Keep the pairing code out of the history.
		history.replaceState(null, '', location.pathname);
	}
	if (code) {
		showPairForm(info, code);
		return;
	}
	const key = readKey();
	if (key) {
		const response = await fetch('/api/device', { headers: { Authorization: 'Bearer ' + key } }).catch(() => undefined);
		if (response?.ok) {
			await boot(info, key);
			return;
		}
		if (response?.status === 401) {
			writeKey(undefined);
			showPairForm(info, undefined, s.signedOut);
			return;
		}
		showCard(s.pairTitle, s.failed);
		return;
	}
	showPairForm(info, undefined, signedOut ? s.signedOut : undefined);
}

main();
`;
