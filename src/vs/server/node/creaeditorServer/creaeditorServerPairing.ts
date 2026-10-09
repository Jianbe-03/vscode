/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: how the CreaEditor Server shows a pairing code: a link with the code, and the link as a
// QR code drawn with block characters so a phone can scan it from a terminal.

import { encodeQrCode, QrErrorCorrection } from '../../../base/common/qrCode.js';

/** The page a device opens to pair: the server's web page with the code in the fragment. */
export function getPairingLink(baseUrl: string, code: string): string {
	return `${baseUrl.replace(/\/+$/, '')}/#pair=${encodeURIComponent(code)}`;
}

/**
 * Draws `text` as a QR code for a terminal: two rows of modules per line with half blocks, dark
 * modules as spaces on a light background (`▀`/`▄`/`█` are light), with a quiet zone of two.
 */
export function renderTerminalQrCode(text: string): string {
	const code = encodeQrCode(text, { errorCorrection: QrErrorCorrection.Low });
	const quiet = 2;
	const size = code.size + quiet * 2;
	const dark = (x: number, y: number) => {
		const mx = x - quiet;
		const my = y - quiet;
		return mx >= 0 && my >= 0 && mx < code.size && my < code.size && code.modules[my][mx];
	};
	const lines: string[] = [];
	for (let y = 0; y < size; y += 2) {
		let line = '';
		for (let x = 0; x < size; x++) {
			const top = !dark(x, y);
			const bottom = y + 1 < size ? !dark(x, y + 1) : true;
			line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
		}
		lines.push(line);
	}
	return lines.join('\n');
}

/** The text of `pairing.txt` and of `creaeditor-server pair`. */
export function formatPairingText(link: string, code: string, expiresAt: number, qrCode: string | undefined): string {
	const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
	return [
		'Pair a laptop or phone with this CreaEditor Server:',
		'',
		`  Pairing code: ${code} (works once, for ${minutes} minutes)`,
		`  Link:         ${link}`,
		'',
		'In CreaEditor: Agents window > Add CreaEditor Server, and paste the link.',
		'On a phone: scan the code below, or open the link.',
		...(qrCode ? ['', qrCode] : []),
		'',
		'Run `creaeditor-server pair` for a new code.',
		'',
	].join('\n');
}
