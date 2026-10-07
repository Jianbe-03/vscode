/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatPetState } from './chatPetWidget.js';

export type ChatPetAccessoryRigPose = 'upright' | 'sleeping' | 'airborne' | 'impact' | 'splat';
export type ChatPetAccessoryTrack = 'idle' | 'sleep' | 'waking' | 'typing' | 'rendering' | 'buttonPress' | 'love' | 'clapping' | 'jump' | 'cool' | 'yapping' | 'sing' | 'speechless' | 'worry' | 'dizzy' | 'falling' | 'wallImpact' | 'splat' | 'search' | 'activity';

export interface IChatPetAccessoryAnchor {
	readonly x: number;
	readonly y: number;
}

export interface IChatPetAccessoryRigFrame {
	readonly pose: ChatPetAccessoryRigPose;
	readonly head?: IChatPetAccessoryAnchor;
	readonly rightEye?: IChatPetAccessoryAnchor;
	readonly mirrorsHeadAccessory?: boolean;
}

export interface IChatPetAntennaeOcclusionBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

interface IChatPetAccessoryTrackSpan {
	readonly firstFrame: number;
	readonly lastFrame: number;
	readonly head: IChatPetAccessoryAnchor;
	readonly pose?: ChatPetAccessoryRigPose;
	readonly rightEye?: IChatPetAccessoryAnchor;
	readonly hideEyeAccessory?: boolean;
	readonly mirrorsHeadAccessory?: boolean;
}

const defaultHeadAnchor: IChatPetAccessoryAnchor = { x: 48, y: 32 };
const defaultRightEyeAnchor: IChatPetAccessoryAnchor = { x: 56, y: 56 };
export const CHAT_PET_HEAD_WEAR_OFFSET = 8;
/**
 * CreaEditor: transparent source pixels on top of every pet body frame, which make room for the
 * Creacoon mark antenna. Rig anchors below are measured from the top of the original art, so
 * they are moved down by this much.
 */
export const CHAT_PET_HEADROOM = 48;

const trackSpans: Partial<Record<ChatPetAccessoryTrack, readonly IChatPetAccessoryTrackSpan[]>> = {
	idle: [
		{ firstFrame: 0, lastFrame: 19, head: defaultHeadAnchor, rightEye: defaultRightEyeAnchor },
		{ firstFrame: 20, lastFrame: 49, head: { x: 48, y: 36 }, rightEye: { x: 56, y: 60 } },
	],
	rendering: [
		{ firstFrame: 0, lastFrame: 19, head: defaultHeadAnchor, rightEye: defaultRightEyeAnchor },
		{ firstFrame: 20, lastFrame: 49, head: { x: 48, y: 36 }, rightEye: { x: 56, y: 60 } },
	],
	sleep: [
		{ firstFrame: 0, lastFrame: 2, head: defaultHeadAnchor, rightEye: { x: 56, y: 64 } },
		{ firstFrame: 3, lastFrame: 7, head: { x: 48, y: 36 }, rightEye: { x: 56, y: 64 } },
	],
	waking: [
		{ firstFrame: 0, lastFrame: 2, head: { x: 48, y: 36 }, pose: 'sleeping', rightEye: { x: 56, y: 64 } },
		{ firstFrame: 3, lastFrame: 7, head: defaultHeadAnchor, pose: 'upright', rightEye: defaultRightEyeAnchor },
	],
	love: [
		{ firstFrame: 0, lastFrame: 3, head: { x: 48, y: 36 } },
		{ firstFrame: 4, lastFrame: 5, head: defaultHeadAnchor },
	],
	jump: [
		{ firstFrame: 0, lastFrame: 0, head: defaultHeadAnchor, rightEye: { x: 56, y: 56 } },
		{ firstFrame: 1, lastFrame: 1, head: { x: 48, y: 48 }, rightEye: { x: 56, y: 64 } },
		{ firstFrame: 2, lastFrame: 2, head: defaultHeadAnchor, rightEye: { x: 56, y: 48 } },
		{ firstFrame: 3, lastFrame: 3, head: defaultHeadAnchor, rightEye: { x: 56, y: 40 } },
		{ firstFrame: 4, lastFrame: 4, head: { x: 48, y: 56 }, rightEye: { x: 56, y: 64 } },
		{ firstFrame: 5, lastFrame: 5, head: defaultHeadAnchor, rightEye: { x: 56, y: 56 } },
	],
	cool: [
		{ firstFrame: 0, lastFrame: 1, head: defaultHeadAnchor },
		{ firstFrame: 2, lastFrame: 2, head: { x: 48, y: 36 } },
		{ firstFrame: 3, lastFrame: 8, head: defaultHeadAnchor },
	],
	sing: [
		{ firstFrame: 0, lastFrame: 3, head: { x: 48, y: 52 }, rightEye: { x: 56, y: 72 } },
	],
	worry: [
		{ firstFrame: 0, lastFrame: 0, head: defaultHeadAnchor },
		{ firstFrame: 1, lastFrame: 1, head: defaultHeadAnchor, mirrorsHeadAccessory: true },
	],
	dizzy: [
		{ firstFrame: 0, lastFrame: 7, head: { x: 48, y: 48 }, hideEyeAccessory: true },
	],
	falling: [
		{ firstFrame: 0, lastFrame: 5, head: defaultHeadAnchor, rightEye: { x: 48, y: 48 } },
	],
	splat: [
		{ firstFrame: 0, lastFrame: 0, head: { x: 48, y: 72 }, pose: 'splat', hideEyeAccessory: true },
		{ firstFrame: 1, lastFrame: 1, head: { x: 48, y: 64 }, pose: 'splat', hideEyeAccessory: true },
		{ firstFrame: 2, lastFrame: 2, head: { x: 48, y: 48 }, pose: 'splat', hideEyeAccessory: true },
		{ firstFrame: 3, lastFrame: 3, head: defaultHeadAnchor, pose: 'upright' },
	],
};

export function getChatPetAccessoryTrack(state: ChatPetState): ChatPetAccessoryTrack {
	switch (state) {
		case 'achievementUnlocked':
			return 'rendering';
		case 'sleep':
		case 'waking':
		case 'typing':
		case 'rendering':
		case 'love':
		case 'clapping':
		case 'jump':
		case 'cool':
		case 'sing':
		case 'speechless':
		case 'worry':
		case 'dizzy':
		case 'falling':
		case 'splat':
			return state;
		case 'buttonPress':
			return 'buttonPress';
		case 'yappingMouthOpen':
			return 'yapping';
		case 'wallImpact':
			return 'wallImpact';
		case 'onTheRun':
		case 'searching':
		case 'searchingDown':
			return 'search';
		case 'complete':
		case 'yapping':
		case 'idle':
			return 'idle';
		case 'planning':
		case 'reviewing':
		case 'testing':
			return 'activity';
	}
}

function getDefaultChatPetAccessoryRigPose(state: ChatPetState): ChatPetAccessoryRigPose {
	switch (state) {
		case 'sleep':
		case 'waking':
			return 'sleeping';
		case 'jump':
		case 'dizzy':
		case 'falling':
			return 'airborne';
		case 'wallImpact':
			return 'impact';
		case 'splat':
			return 'splat';
		default:
			return 'upright';
	}
}

export function getChatPetAccessoryRigPose(state: ChatPetState, frameIndex = 0): ChatPetAccessoryRigPose {
	const spans = trackSpans[getChatPetAccessoryTrack(state)];
	const span = spans?.find(candidate => frameIndex >= candidate.firstFrame && frameIndex <= candidate.lastFrame);
	return span?.pose ?? getDefaultChatPetAccessoryRigPose(state);
}

function withHeadroom(anchor: IChatPetAccessoryAnchor): IChatPetAccessoryAnchor {
	return { x: anchor.x, y: anchor.y + CHAT_PET_HEADROOM };
}

export function getChatPetAccessoryRigFrame(state: ChatPetState, frameIndex: number): IChatPetAccessoryRigFrame {
	const spans = trackSpans[getChatPetAccessoryTrack(state)];
	const span = spans?.find(candidate => frameIndex >= candidate.firstFrame && frameIndex <= candidate.lastFrame);
	const trackedHead = span?.head ?? defaultHeadAnchor;
	const hideEyeAccessory = span?.hideEyeAccessory || doesChatPetStateHideEyeAccessory(state);
	return {
		pose: span?.pose ?? getDefaultChatPetAccessoryRigPose(state),
		head: state === 'love' || state === 'complete' || state === 'dizzy' ? undefined : {
			x: trackedHead.x,
			y: trackedHead.y + CHAT_PET_HEAD_WEAR_OFFSET + CHAT_PET_HEADROOM,
		},
		rightEye: hideEyeAccessory ? undefined : withHeadroom(span?.rightEye ?? defaultRightEyeAnchor),
		...(span?.mirrorsHeadAccessory ? { mirrorsHeadAccessory: true } : {}),
	};
}

export function getChatPetAntennaeOcclusionBounds(state: ChatPetState, frameIndex: number): IChatPetAntennaeOcclusionBounds | undefined {
	const rigFrame = getChatPetAccessoryRigFrame(state, frameIndex);
	if (!rigFrame.head) {
		return undefined;
	}
	if (rigFrame.pose === 'impact') {
		return {
			x: 16,
			y: 24 + CHAT_PET_HEADROOM,
			width: 64,
			height: 8,
		};
	}
	// CreaEditor: the mark antenna reaches into the headroom and sways sideways.
	return {
		x: rigFrame.head.x - 40,
		y: Math.max(0, rigFrame.head.y - 48 - CHAT_PET_HEADROOM),
		width: 80,
		height: 40 + CHAT_PET_HEADROOM,
	};
}

export function getChatPetEyeAccessoryAnchor(state: ChatPetState, frameIndex: number, facingDirection: 'left' | 'right', mirrorsWithFacing: boolean, frameWidth = 96): IChatPetAccessoryAnchor | undefined {
	const anchor = getChatPetAccessoryRigFrame(state, frameIndex).rightEye;
	if (!anchor || facingDirection === 'right' || mirrorsWithFacing) {
		return anchor;
	}
	return {
		x: anchor.x - 16 + frameWidth - 96,
		y: anchor.y,
	};
}

export function getChatPetReducedMotionRigFrame(state: ChatPetState): number {
	switch (state) {
		case 'sleep':
			return 4;
		case 'waking':
			return 7;
		case 'buttonPress':
			return 4;
		case 'love':
			return 5;
		case 'splat':
			return 3;
		default:
			return 0;
	}
}

function doesChatPetStateHideEyeAccessory(state: ChatPetState): boolean {
	// CreaEditor: the reviewing pose wears its own reading glasses.
	return state === 'reviewing'
		|| state === 'love'
		|| state === 'complete'
		|| state === 'cool'
		|| state === 'speechless'
		|| state === 'worry'
		|| state === 'dizzy'
		|| state === 'wallImpact';
}
