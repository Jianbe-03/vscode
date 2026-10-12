/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestAccessibilityService } from '../../../../../platform/accessibility/test/common/testAccessibilityService.js';
import { ChatSpeechToTextState, IChatSpeechToTextService } from '../../browser/speechToText/chatSpeechToTextService.js';
import { DictationListeningBar } from '../../browser/speechToText/dictationListeningBar.js';

/** Never fires: the bar only needs it to size its graph. */
class TestResizeObserver implements ResizeObserver {
	disconnect(): void { }
	observe(): void { }
	unobserve(): void { }
}

suite('DictationListeningBar', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('shows only while dictation listens into its own input, and says when it transcribes', () => {
		const disposables = store.add(new DisposableStore());
		const onDidChangeState = disposables.add(new Emitter<ChatSpeechToTextState>());
		const onDidChangePreparingModel = disposables.add(new Emitter<boolean>());
		const onDidChangeTranscribingSegment = disposables.add(new Emitter<boolean>());
		const onDidChangeDictationTarget = disposables.add(new Emitter<void>());
		let state = ChatSpeechToTextState.Idle;
		let preparing = false;
		let transcribing = false;
		let here = true;
		const service = new class extends mock<IChatSpeechToTextService>() {
			override readonly onDidChangeState = onDidChangeState.event;
			override readonly onDidChangePreparingModel = onDidChangePreparingModel.event;
			override readonly onDidChangeTranscribingSegment = onDidChangeTranscribingSegment.event;
			override get state() { return state; }
			override get isPreparingModel() { return preparing; }
			override get isTranscribingSegment() { return transcribing; }
			override get analyserNode() { return undefined; }
		};
		const stack = mainWindow.document.createElement('div');
		stack.className = 'chat-input-stack';
		const slot = mainWindow.document.createElement('div');
		slot.className = 'chat-input-stack-slot';
		stack.appendChild(slot);
		disposables.add(new DictationListeningBar({
			container: slot,
			isDictatingHere: () => here,
			onDidChangeDictationTarget: onDidChangeDictationTarget.event,
		}, TestResizeObserver, service, new TestAccessibilityService()));

		const snapshot = () => ({
			docked: slot.classList.contains('chat-input-stack-docked'),
			label: slot.querySelector('.dictation-listening-label')?.textContent ?? '',
		});
		const idle = snapshot();
		state = ChatSpeechToTextState.Recording;
		preparing = true;
		onDidChangePreparingModel.fire(true);
		const downloading = snapshot();
		preparing = false;
		onDidChangePreparingModel.fire(false);
		const listening = snapshot();
		transcribing = true;
		onDidChangeTranscribingSegment.fire(true);
		const transcribingSegment = snapshot();
		here = false;
		onDidChangeDictationTarget.fire();
		const otherInput = snapshot();
		here = true;
		state = ChatSpeechToTextState.Transcribing;
		onDidChangeState.fire(state);
		const stopped = snapshot();

		assert.deepStrictEqual({ idle, downloading, listening, transcribingSegment, otherInput, stopped }, {
			idle: { docked: false, label: '' },
			downloading: { docked: false, label: '' },
			listening: { docked: true, label: 'Listening…' },
			transcribingSegment: { docked: true, label: 'Transcribing…' },
			otherInput: { docked: false, label: '' },
			stopped: { docked: false, label: '' },
		});
	});
});
