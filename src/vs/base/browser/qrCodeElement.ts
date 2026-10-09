/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: a QR code as an SVG element, black on white (scanners need the contrast in every theme).

import { encodeQrCode, qrCodeToSvgPath } from '../common/qrCode.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Draws `text` as a QR code that scales with its container (set the size in CSS). */
export function createQrCodeSvg(text: string, quietZone = 4): SVGSVGElement {
	const code = encodeQrCode(text);
	const size = code.size + quietZone * 2;
	const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
	svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
	svg.setAttribute('shape-rendering', 'crispEdges');
	const background = document.createElementNS(SVG_NAMESPACE, 'rect');
	background.setAttribute('width', String(size));
	background.setAttribute('height', String(size));
	background.setAttribute('fill', '#ffffff');
	const modules = document.createElementNS(SVG_NAMESPACE, 'path');
	modules.setAttribute('d', qrCodeToSvgPath(code, quietZone));
	modules.setAttribute('fill', '#000000');
	svg.append(background, modules);
	return svg;
}
