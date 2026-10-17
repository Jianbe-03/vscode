/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, getWindow } from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { IAction, Separator, toAction } from '../../../../../base/common/actions.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { createConfigureKeybindingAction } from '../../../../../platform/actions/common/menuService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { AgentsVoiceSettingId } from '../../../agentsVoice/common/agentsVoice.js';
import { CONFIGURE_DICTATION_INSTRUCTIONS_ACTION_ID, CONFIGURE_VOICE_INSTRUCTIONS_ACTION_ID } from '../actions/configureVoiceInstructionsAction.js';
import { SHOW_DICTATION_ONBOARDING_COMMAND } from './dictationOnboarding.js';

/** CreaEditor: opens a page of the CreaEditor Guide; its argument is the page name (see `creaeditorHelp.ts`). */
const OPEN_CREAEDITOR_HELP_COMMAND = 'creaeditor.help.open';
/** CreaEditor: command that lets the user choose the spoken dictation language. */
export const PICK_DICTATION_LANGUAGE_COMMAND = 'workbench.action.chat.pickDictationLanguage';
/** CreaEditor: command that switches the on-device dictation model (Whisper Small or Large). */
export const SWITCH_DICTATION_MODEL_COMMAND = 'workbench.action.chat.switchDictationModel';
/** Command that opens the microphone picker shared by dictation and Voice Mode. */
export const SELECT_MICROPHONE_COMMAND = 'workbench.action.chat.selectSpeechToTextMicrophone';
/** Command that tears down an active Voice Mode session. */
const VOICE_DISCONNECT_COMMAND = 'agentsVoice.disconnect';
/** Command that opens the Voice Mode settings; the affordance that used to live behind the toolbar gear. */
const VOICE_OPEN_SETTINGS_COMMAND = 'agentsVoice.openSettings';
/** Command that opens the Settings editor. */
const OPEN_SETTINGS_COMMAND = 'workbench.action.openSettings';
/** Narrows the Settings editor to dictation settings. */
const DICTATION_SETTINGS_QUERY = 'dictation';
/** Command that shows the Voice Mode onboarding card again. */
export const SHOW_VOICE_MODE_ONBOARDING_COMMAND = 'agentsVoice.showOnboarding';
/** Setting that enables Voice Mode; toggled off by "Disable". */
const VOICE_ENABLED_SETTING = 'agents.voice.enabled';
/** Setting that shows the live voice transcript overlay; toggled from the menu. */
const VOICE_SHOW_TRANSCRIPT_SETTING = 'agents.voice.showTranscript';

/**
 * "Select Microphone" entry shared by every dictation / Voice Mode mic button
 * context menu. Opens the picker shared by both features.
 */
function createSelectMicrophoneAction(commandService: ICommandService): IAction {
	return toAction({
		id: SELECT_MICROPHONE_COMMAND,
		label: localize('mic.selectMicrophone', "Select Microphone"),
		run: () => commandService.executeCommand(SELECT_MICROPHONE_COMMAND),
	});
}

/** CreaEditor: "Switch Speech Model..." entry for dictation: Whisper Small (faster) or Large (more accurate). */
function createSwitchDictationModelAction(commandService: ICommandService): IAction {
	return toAction({
		id: SWITCH_DICTATION_MODEL_COMMAND,
		label: localize('dictation.switchModel', "Switch Speech Model..."),
		run: () => commandService.executeCommand(SWITCH_DICTATION_MODEL_COMMAND),
	});
}

/** CreaEditor: "Spoken Language..." entry for dictation: the language Whisper is told the user speaks. */
function createPickDictationLanguageAction(commandService: ICommandService): IAction {
	return toAction({
		id: PICK_DICTATION_LANGUAGE_COMMAND,
		label: localize('dictation.pickLanguage', "Spoken Language..."),
		run: () => commandService.executeCommand(PICK_DICTATION_LANGUAGE_COMMAND),
	});
}

/** CreaEditor: "How Dictation Works" entry: the Dictation page of the CreaEditor Guide. */
function createDictationHelpAction(commandService: ICommandService): IAction {
	return toAction({
		id: 'chat.dictation.help',
		label: localize('dictation.help', "How Dictation Works"),
		run: () => commandService.executeCommand(OPEN_CREAEDITOR_HELP_COMMAND, 'dictation'),
	});
}

function createShowDictationOnboardingAction(commandService: ICommandService): IAction {
	return toAction({
		id: SHOW_DICTATION_ONBOARDING_COMMAND,
		label: localize('dictation.showIntroduction', "Show Introduction"),
		run: () => commandService.executeCommand(SHOW_DICTATION_ONBOARDING_COMMAND),
	});
}

/**
 * Checkable "Microphone Button" entry mirroring the action bar visibility toggles:
 * checked while the button is shown, unchecking it hides the button. Hiding only
 * removes the toolbar affordance — dictation can still be launched with its
 * Cmd/Ctrl+I shortcut, and the button can be restored from Settings.
 */
function createToggleButtonAction(configurationService: IConfigurationService, settingId: AgentsVoiceSettingId.ShowButton, id: string, label: string): IAction {
	const shown = configurationService.getValue<boolean>(settingId) !== false;
	return toAction({
		id,
		label,
		checked: shown,
		run: () => configurationService.updateValue(settingId, !shown),
	});
}

/**
 * "Disable" entry for Voice Mode. Tears down any active session first so disabling
 * the setting doesn't leave the microphone capturing while the toolbar
 * affordance disappears, then turns off the feature setting.
 */
function createDisableVoiceModeAction(commandService: ICommandService, configurationService: IConfigurationService): IAction {
	return toAction({
		id: 'chat.voiceMode.disable',
		label: localize('voiceMode.disable', "Disable"),
		run: async () => {
			await commandService.executeCommand(VOICE_DISCONNECT_COMMAND);
			await configurationService.updateValue(VOICE_ENABLED_SETTING, false);
		},
	});
}

/**
 * Actions for the dictation mic button context menu. Keybinding and feature
 * disabling are grouped separately from configuration and onboarding.
 */
export function getDictationContextMenuActions(commandService: ICommandService, configurationService: IConfigurationService, keybindingService: IKeybindingService, keybindingCommandId: string): IAction[] {
	return Separator.join(
		// CreaEditor: no "Microphone Button" or "Disable" here: once the button was hidden there was no
		// way back to it from the input box.
		[
			createConfigureKeybindingAction(commandService, keybindingService, keybindingCommandId),
		],
		[
			createDictationSettingsAction(commandService),
			createConfigureInstructionsAction(commandService, CONFIGURE_DICTATION_INSTRUCTIONS_ACTION_ID, localize('dictation.configureInstructions', "Configure Instructions")),
			createShowDictationOnboardingAction(commandService),
			createSelectMicrophoneAction(commandService),
			createSwitchDictationModelAction(commandService),
			createPickDictationLanguageAction(commandService),
		],
		[
			createDictationHelpAction(commandService),
		],
	);
}

/**
 * "Settings" entry. Opens the Voice Mode settings — the affordance
 * that used to live behind the toolbar gear button.
 */
function createVoiceModeSettingsAction(commandService: ICommandService): IAction {
	return toAction({
		id: VOICE_OPEN_SETTINGS_COMMAND,
		label: localize('voiceMode.openSettings', "Open Settings"),
		run: () => commandService.executeCommand(VOICE_OPEN_SETTINGS_COMMAND),
	});
}

function createDictationSettingsAction(commandService: ICommandService): IAction {
	return toAction({
		id: 'chat.dictation.openSettings',
		label: localize('dictation.openSettings', "Open Settings"),
		run: () => commandService.executeCommand(OPEN_SETTINGS_COMMAND, { query: DICTATION_SETTINGS_QUERY }),
	});
}

function createShowVoiceModeOnboardingAction(commandService: ICommandService): IAction {
	return toAction({
		id: SHOW_VOICE_MODE_ONBOARDING_COMMAND,
		label: localize('voiceMode.showIntroduction', "Show Introduction"),
		run: () => commandService.executeCommand(SHOW_VOICE_MODE_ONBOARDING_COMMAND),
	});
}

function createConfigureInstructionsAction(commandService: ICommandService, commandId: string, label: string): IAction {
	return toAction({
		id: commandId,
		label,
		run: () => commandService.executeCommand(commandId),
	});
}

/**
 * Checkable "Show Transcript" entry: a quick per-session toggle for the live
 * voice transcript overlay. Reflects and flips `agents.voice.showTranscript`,
 * which also serves as the user's default preference.
 */
function createToggleTranscriptAction(configurationService: IConfigurationService): IAction {
	const shown = configurationService.getValue<boolean>(VOICE_SHOW_TRANSCRIPT_SETTING) === true;
	return toAction({
		id: 'chat.voiceMode.toggleTranscript',
		label: localize('voiceMode.showTranscript', "Show Transcript"),
		checked: shown,
		run: () => configurationService.updateValue(VOICE_SHOW_TRANSCRIPT_SETTING, !shown),
	});
}

/**
 * Actions for the Voice Mode mic button context menu. Keybinding and feature
 * disabling are grouped separately from configuration and onboarding.
 */
export function getVoiceModeContextMenuActions(commandService: ICommandService, configurationService: IConfigurationService, keybindingService: IKeybindingService, keybindingCommandId: string): IAction[] {
	return Separator.join(
		[
			createConfigureKeybindingAction(commandService, keybindingService, keybindingCommandId),
			createToggleButtonAction(configurationService, AgentsVoiceSettingId.ShowButton, 'chat.voiceMode.toggleButton', localize('voiceMode.button', "Voice Mode Button")),
			createToggleTranscriptAction(configurationService),
			createDisableVoiceModeAction(commandService, configurationService),
		],
		[
			createVoiceModeSettingsAction(commandService),
			createConfigureInstructionsAction(commandService, CONFIGURE_VOICE_INSTRUCTIONS_ACTION_ID, localize('voiceMode.configureInstructions', "Configure Instructions")),
			createShowVoiceModeOnboardingAction(commandService),
			createSelectMicrophoneAction(commandService),
		],
	);
}

/**
 * Wire a right-click context menu onto a mic button. Stops the event before it
 * reaches the toolbar's generic context-menu handler so the mic-specific menu is
 * shown instead. Works for both `MenuEntryActionViewItem` containers and the
 * Agents-window custom mic `<div>`s.
 */
export function addMicButtonContextMenuListener(container: HTMLElement, getActions: () => IAction[], contextMenuService: IContextMenuService): IDisposable {
	return addDisposableListener(container, 'contextmenu', e => {
		e.preventDefault();
		e.stopPropagation();
		const event = new StandardMouseEvent(getWindow(container), e);
		contextMenuService.showContextMenu({
			getAnchor: () => event,
			getActions,
		});
	});
}
