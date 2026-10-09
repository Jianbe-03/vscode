/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: a small dependency-free QR code encoder (ISO/IEC 18004, byte mode, versions 1-40),
// used to show the Remote Access pairing link. Follows the structure of Project Nayuki's
// QR Code generator (MIT).

import { VSBuffer } from './buffer.js';

/** How much of the code can be damaged and still be read. */
export const enum QrErrorCorrection {
	/** About 7%. */
	Low = 0,
	/** About 15%. */
	Medium = 1,
	/** About 25%. */
	Quartile = 2,
	/** About 30%. */
	High = 3,
}

/** Options for {@link encodeQrCode}. */
export interface IQrCodeOptions {
	/** Defaults to {@link QrErrorCorrection.Medium}. */
	readonly errorCorrection?: QrErrorCorrection;
	/** The smallest version (1-40) to use. Defaults to 1. */
	readonly minVersion?: number;
	/** A fixed mask pattern (0-7). By default the mask with the lowest penalty is chosen. */
	readonly mask?: number;
}

/** A QR code: `modules[y][x]` is `true` for a dark module. */
export interface IQrCode {
	readonly version: number;
	readonly size: number;
	readonly mask: number;
	readonly modules: readonly (readonly boolean[])[];
}

// Indexed by [errorCorrection][version]; index 0 is unused.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
	[-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	[-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
	[-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	[-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
	[-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	[-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	[-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	[-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** The two format bits of each error correction level, as stored in the format information. */
const FORMAT_BITS: readonly number[] = [1, 0, 3, 2];

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/**
 * Encodes `text` (as UTF-8, byte mode) into the smallest QR code that fits.
 * Throws when the text is too long for a version 40 code.
 */
export function encodeQrCode(text: string, options: IQrCodeOptions = {}): IQrCode {
	const errorCorrection = options.errorCorrection ?? QrErrorCorrection.Medium;
	const bytes = VSBuffer.fromString(text).buffer;

	let version = Math.max(MIN_VERSION, options.minVersion ?? MIN_VERSION);
	for (; ; version++) {
		if (version > MAX_VERSION) {
			throw new Error('The text is too long for a QR code.');
		}
		const dataBits = 4 + characterCountBits(version) + bytes.length * 8;
		if (bytes.length < (1 << characterCountBits(version)) && dataBits <= getNumDataCodewords(version, errorCorrection) * 8) {
			break;
		}
	}

	// Data bits: mode indicator, character count, data, terminator, padding.
	const capacityBits = getNumDataCodewords(version, errorCorrection) * 8;
	const bits: number[] = [];
	appendBits(bits, 0b0100, 4);
	appendBits(bits, bytes.length, characterCountBits(version));
	for (const byte of bytes) {
		appendBits(bits, byte, 8);
	}
	appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
	appendBits(bits, 0, (8 - bits.length % 8) % 8);
	for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) {
		appendBits(bits, pad, 8);
	}
	const dataCodewords: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let codeword = 0;
		for (let j = 0; j < 8; j++) {
			codeword = (codeword << 1) | bits[i + j];
		}
		dataCodewords.push(codeword);
	}

	const matrix = new QrMatrix(version);
	matrix.drawFunctionPatterns(errorCorrection);
	matrix.drawCodewords(addErrorCorrectionAndInterleave(dataCodewords, version, errorCorrection));

	let mask = options.mask;
	if (mask === undefined) {
		let lowestPenalty = Number.MAX_SAFE_INTEGER;
		for (let candidate = 0; candidate < 8; candidate++) {
			matrix.applyMask(candidate);
			matrix.drawFormatBits(errorCorrection, candidate);
			const penalty = matrix.getPenaltyScore();
			if (penalty < lowestPenalty) {
				mask = candidate;
				lowestPenalty = penalty;
			}
			matrix.applyMask(candidate); // XOR again to undo
		}
	}
	if (mask === undefined || mask < 0 || mask > 7) {
		throw new Error('Invalid QR code mask.');
	}
	matrix.applyMask(mask);
	matrix.drawFormatBits(errorCorrection, mask);

	return { version, size: matrix.size, mask, modules: matrix.modules };
}

/**
 * The SVG path (`d` attribute) of the dark modules, one unit per module, offset by `quietZone`
 * modules. Draw it in a `viewBox` of `size + 2 * quietZone` units on a light background.
 */
export function qrCodeToSvgPath(code: IQrCode, quietZone = 4): string {
	const parts: string[] = [];
	for (let y = 0; y < code.size; y++) {
		for (let x = 0; x < code.size; x++) {
			if (code.modules[y][x]) {
				parts.push(`M${x + quietZone},${y + quietZone}h1v1h-1z`);
			}
		}
	}
	return parts.join('');
}

function characterCountBits(version: number): number {
	return version <= 9 ? 8 : 16;
}

function appendBits(bits: number[], value: number, length: number): void {
	for (let i = length - 1; i >= 0; i--) {
		bits.push((value >>> i) & 1);
	}
}

function getNumRawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) {
			result -= 36;
		}
	}
	return result;
}

function getNumDataCodewords(version: number, errorCorrection: QrErrorCorrection): number {
	return Math.floor(getNumRawDataModules(version) / 8) - ECC_CODEWORDS_PER_BLOCK[errorCorrection][version] * NUM_ERROR_CORRECTION_BLOCKS[errorCorrection][version];
}

function addErrorCorrectionAndInterleave(data: readonly number[], version: number, errorCorrection: QrErrorCorrection): number[] {
	const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[errorCorrection][version];
	const blockEccLength = ECC_CODEWORDS_PER_BLOCK[errorCorrection][version];
	const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
	const numShortBlocks = numBlocks - rawCodewords % numBlocks;
	const shortBlockLength = Math.floor(rawCodewords / numBlocks);

	const divisor = reedSolomonComputeDivisor(blockEccLength);
	const blocks: number[][] = [];
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const blockData = data.slice(k, k + shortBlockLength - blockEccLength + (i < numShortBlocks ? 0 : 1));
		k += blockData.length;
		const ecc = reedSolomonComputeRemainder(blockData, divisor);
		if (i < numShortBlocks) {
			blockData.push(0);
		}
		blocks.push(blockData.concat(ecc));
	}

	const result: number[] = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			// Skip the padding byte of short blocks.
			if (i !== shortBlockLength - blockEccLength || j >= numShortBlocks) {
				result.push(block[i]);
			}
		});
	}
	return result;
}

function reedSolomonComputeDivisor(degree: number): number[] {
	const result: number[] = new Array<number>(degree - 1).fill(0);
	result.push(1);
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = reedSolomonMultiply(result[j], root);
			if (j + 1 < result.length) {
				result[j] ^= result[j + 1];
			}
		}
		root = reedSolomonMultiply(root, 0x02);
	}
	return result;
}

/** The Reed-Solomon error correction codewords of `data` for `degree` codewords. */
export function reedSolomonComputeRemainder(data: readonly number[], divisorOrDegree: readonly number[] | number): number[] {
	const divisor = typeof divisorOrDegree === 'number' ? reedSolomonComputeDivisor(divisorOrDegree) : divisorOrDegree;
	const result = divisor.map(() => 0);
	for (const byte of data) {
		const factor = byte ^ result.shift()!;
		result.push(0);
		divisor.forEach((coefficient, i) => result[i] ^= reedSolomonMultiply(coefficient, factor));
	}
	return result;
}

function reedSolomonMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11D);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function getBit(value: number, index: number): boolean {
	return ((value >>> index) & 1) !== 0;
}

class QrMatrix {

	readonly size: number;
	readonly modules: boolean[][];
	private readonly _isFunction: boolean[][];

	constructor(private readonly _version: number) {
		this.size = _version * 4 + 17;
		this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		this._isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
	}

	drawFunctionPatterns(errorCorrection: QrErrorCorrection): void {
		for (let i = 0; i < this.size; i++) {
			this._setFunctionModule(6, i, i % 2 === 0);
			this._setFunctionModule(i, 6, i % 2 === 0);
		}

		this._drawFinderPattern(3, 3);
		this._drawFinderPattern(this.size - 4, 3);
		this._drawFinderPattern(3, this.size - 4);

		const alignPositions = this._getAlignmentPatternPositions();
		const last = alignPositions.length - 1;
		for (let i = 0; i <= last; i++) {
			for (let j = 0; j <= last; j++) {
				if (!(i === 0 && j === 0 || i === 0 && j === last || i === last && j === 0)) {
					this._drawAlignmentPattern(alignPositions[i], alignPositions[j]);
				}
			}
		}

		// Reserve the format areas (drawn for real once the mask is known) and draw the version.
		this.drawFormatBits(errorCorrection, 0);
		this._drawVersion();
	}

	drawFormatBits(errorCorrection: QrErrorCorrection, mask: number): void {
		const data = FORMAT_BITS[errorCorrection] << 3 | mask;
		let remainder = data;
		for (let i = 0; i < 10; i++) {
			remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
		}
		const bits = (data << 10 | remainder) ^ 0x5412;

		for (let i = 0; i <= 5; i++) {
			this._setFunctionModule(8, i, getBit(bits, i));
		}
		this._setFunctionModule(8, 7, getBit(bits, 6));
		this._setFunctionModule(8, 8, getBit(bits, 7));
		this._setFunctionModule(7, 8, getBit(bits, 8));
		for (let i = 9; i < 15; i++) {
			this._setFunctionModule(14 - i, 8, getBit(bits, i));
		}

		for (let i = 0; i < 8; i++) {
			this._setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
		}
		for (let i = 8; i < 15; i++) {
			this._setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
		}
		this._setFunctionModule(8, this.size - 8, true); // The dark module
	}

	drawCodewords(data: readonly number[]): void {
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) {
				right = 5;
			}
			for (let vertical = 0; vertical < this.size; vertical++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vertical : vertical;
					if (!this._isFunction[y][x] && i < data.length * 8) {
						this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
						i++;
					}
				}
			}
		}
	}

	/** XORs the mask onto the data modules; applying the same mask twice undoes it. */
	applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				let invert: boolean;
				switch (mask) {
					case 0: invert = (x + y) % 2 === 0; break;
					case 1: invert = y % 2 === 0; break;
					case 2: invert = x % 3 === 0; break;
					case 3: invert = (x + y) % 3 === 0; break;
					case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
					case 5: invert = x * y % 2 + x * y % 3 === 0; break;
					case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
					case 7: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
					default: throw new Error('Invalid QR code mask.');
				}
				if (!this._isFunction[y][x] && invert) {
					this.modules[y][x] = !this.modules[y][x];
				}
			}
		}
	}

	/** The penalty score of ISO/IEC 18004 section 7.8.3: lower is easier to scan. */
	getPenaltyScore(): number {
		let result = 0;
		const lines: boolean[][] = [];
		for (let y = 0; y < this.size; y++) {
			lines.push(this.modules[y]);
		}
		for (let x = 0; x < this.size; x++) {
			lines.push(this.modules.map(row => row[x]));
		}

		for (const line of lines) {
			// Runs of five or more modules of the same color.
			let runLength = 0;
			for (let i = 0; i < line.length; i++) {
				runLength = i > 0 && line[i] === line[i - 1] ? runLength + 1 : 1;
				if (runLength === 5) {
					result += 3;
				} else if (runLength > 5) {
					result += 1;
				}
			}
			// Finder-like patterns 1:1:3:1:1 with four light modules on either side
			// (the light area may extend into the quiet zone).
			for (let i = 0; i < line.length; i++) {
				if (matchesFinderLikePattern(line, i)) {
					result += 40;
				}
			}
		}

		// 2x2 blocks of the same color.
		for (let y = 0; y < this.size - 1; y++) {
			for (let x = 0; x < this.size - 1; x++) {
				const color = this.modules[y][x];
				if (color === this.modules[y][x + 1] && color === this.modules[y + 1][x] && color === this.modules[y + 1][x + 1]) {
					result += 3;
				}
			}
		}

		// Balance of dark and light modules.
		let dark = 0;
		for (const row of this.modules) {
			for (const module of row) {
				if (module) {
					dark++;
				}
			}
		}
		const total = this.size * this.size;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += Math.max(0, k) * 10;
		return result;
	}

	private _drawFinderPattern(x: number, y: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const distance = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size) {
					this._setFunctionModule(xx, yy, distance !== 2 && distance !== 4);
				}
			}
		}
	}

	private _drawAlignmentPattern(x: number, y: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				this._setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}

	private _drawVersion(): void {
		if (this._version < 7) {
			return;
		}
		let remainder = this._version;
		for (let i = 0; i < 12; i++) {
			remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1F25);
		}
		const bits = this._version << 12 | remainder;
		for (let i = 0; i < 18; i++) {
			const bit = getBit(bits, i);
			const a = this.size - 11 + i % 3;
			const b = Math.floor(i / 3);
			this._setFunctionModule(a, b, bit);
			this._setFunctionModule(b, a, bit);
		}
	}

	private _getAlignmentPatternPositions(): number[] {
		if (this._version === 1) {
			return [];
		}
		const numAlign = Math.floor(this._version / 7) + 2;
		const step = Math.floor((this._version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
		const result = [6];
		for (let position = this.size - 7; result.length < numAlign; position -= step) {
			result.splice(1, 0, position);
		}
		return result;
	}

	private _setFunctionModule(x: number, y: number, isDark: boolean): void {
		this.modules[y][x] = isDark;
		this._isFunction[y][x] = true;
	}
}

function matchesFinderLikePattern(line: readonly boolean[], start: number): boolean {
	// dark:light pattern 1 1 3 1 1 preceded or followed by 4 light modules
	const at = (i: number) => i >= 0 && i < line.length ? line[i] : false;
	const core = [true, false, true, true, true, false, true];
	for (let i = 0; i < core.length; i++) {
		if (at(start + i) !== core[i]) {
			return false;
		}
	}
	let lightBefore = true;
	let lightAfter = true;
	for (let i = 1; i <= 4; i++) {
		lightBefore = lightBefore && !at(start - i);
		lightAfter = lightAfter && !at(start + core.length - 1 + i);
	}
	return lightBefore || lightAfter;
}
