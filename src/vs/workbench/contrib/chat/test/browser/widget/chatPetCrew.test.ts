/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: tests for the crew of pets that act out what a chat's subagents are doing.

import assert from 'assert';
import sinon from 'sinon';
import { mainWindow } from '../../../../../../base/browser/window.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { NullHoverService } from '../../../../../../platform/hover/test/browser/nullHoverService.js';
import { AgentsTreeStatus } from '../../../common/agentsTree/agentsTreeModel.js';
import { ChatAgentActivity, IChatAgentActivityEntry } from '../../../common/chatPet/chatAgentActivity.js';
import { CHAT_PET_CREW_FINISHED_DURATION, CHAT_PET_CREW_LEAVE_DURATION, ChatPetCrew, IChatPetCrewOptions } from '../../../browser/widget/chatPetCrew.js';
import { getChatPetActivityState, getChatPetBaseState, getChatPetCrewSpeechSheet, getChatPetCrewSpriteSheet } from '../../../browser/widget/chatPetWidget.js';

function entry(id: string, activity: ChatAgentActivity, status = AgentsTreeStatus.Running, depth = 1, name?: string): IChatAgentActivityEntry {
	return { id, parentId: undefined, depth, name, description: undefined, activity, status };
}

suite('ChatPetCrew', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	const options: IChatPetCrewOptions = { visible: true, variant: 'stable', motionReduced: false, scale: 1 };

	function createCrew(): { crew: ChatPetCrew; snapshot: () => object } {
		const parent = mainWindow.document.createElement('div');
		mainWindow.document.body.append(parent);
		disposables.add(toDisposable(() => parent.remove()));
		const crew = disposables.add(new ChatPetCrew(parent, getChatPetCrewSpriteSheet, getChatPetCrewSpeechSheet, NullHoverService));
		const snapshot = () => ({
			hidden: crew.element.classList.contains('hidden'),
			label: crew.element.getAttribute('aria-label'),
			pets: Array.from(crew.element.querySelectorAll<HTMLElement>('.chat-pet-crew-member'), pet => `${pet.dataset.activity}${pet.classList.contains('leaving') ? ' (leaving)' : ''}, tint ${pet.style.getPropertyValue('--chat-pet-crew-hue')}${pet.querySelector('.chat-pet-crew-bubble:not(.hidden)') ? ', speech bubble' : ''}`),
			crowded: crew.element.classList.contains('crowded'),
		});
		return { crew, snapshot };
	}

	test('maps the main agent activity to pet states', () => {
		assert.deepStrictEqual({
			states: [undefined, ...Object.values({
				thinking: ChatAgentActivity.Thinking,
				programming: ChatAgentActivity.Programming,
				testing: ChatAgentActivity.Testing,
				researching: ChatAgentActivity.Researching,
				planning: ChatAgentActivity.Planning,
				reviewing: ChatAgentActivity.Reviewing,
				waiting: ChatAgentActivity.WaitingForInput,
			})].map(activity => getChatPetActivityState(activity)),
			baseWhileWorking: getChatPetBaseState(true, false, false, true, false, ChatAgentActivity.Researching),
			baseWhileIdle: getChatPetBaseState(false, false, false, true, false, ChatAgentActivity.Researching),
			sheets: (['idle', 'typing', 'search', 'worry', 'love', 'dizzy', 'planning', 'reviewing', 'thinking', 'testing'] as const).map(pose => {
				const sheet = getChatPetCrewSpriteSheet(pose, 'stable', false);
				return `${sheet.url.slice(sheet.url.lastIndexOf('/') + 1)} ${sheet.frameWidth}x${sheet.frameHeight} x${sheet.frameDurations.length}`;
			}),
		}, {
			states: ['rendering', 'rendering', 'typing', 'testing', 'searching', 'planning', 'reviewing', 'clapping'],
			baseWhileWorking: 'searching',
			baseWhileIdle: 'typing',
			sheets: [
				'buddy-idle-stable-96.spritesheet.png 96x144 x50',
				'buddy-typing-stable-96.spritesheet.png 168x144 x2',
				'buddy-search-stable-96.spritesheet.png 96x144 x4',
				'buddy-worry-stable-96.spritesheet.png 96x144 x2',
				'buddy-love-stable-96.spritesheet.png 96x144 x6',
				'buddy-dizzy-stable-128.spritesheet.png 96x176 x8',
				'buddy-planning-stable-96.spritesheet.png 96x144 x4',
				'buddy-reviewing-stable-96.spritesheet.png 96x144 x6',
				'buddy-idle-stable-96.spritesheet.png 96x144 x50',
				'buddy-testing-stable-96.spritesheet.png 96x144 x4',
			],
		});
	});

	test('shows one tinted pet per running subagent, crowding instead of hiding any, and lets finished ones leave', () => {
		const clock = sinon.useFakeTimers();
		const { crew, snapshot } = createCrew();
		const root = entry('root', ChatAgentActivity.Programming, AgentsTreeStatus.Running, 0);
		const reviewer = entry('reviewer', ChatAgentActivity.Reviewing, AgentsTreeStatus.Running, 1, 'Review agent');
		const explorer = entry('explorer', ChatAgentActivity.Researching, AgentsTreeStatus.Running, 2, 'Explore');
		crew.update([root, reviewer, explorer, entry('old', ChatAgentActivity.Done, AgentsTreeStatus.Done)], options);
		const working = snapshot();

		crew.update([root, { ...reviewer, activity: ChatAgentActivity.Done, status: AgentsTreeStatus.Done }, { ...explorer, activity: ChatAgentActivity.Failed, status: AgentsTreeStatus.Failed }], options);
		const finished = snapshot();
		clock.tick(CHAT_PET_CREW_FINISHED_DURATION);
		const leaving = snapshot();
		clock.tick(CHAT_PET_CREW_LEAVE_DURATION);
		const left = snapshot();

		crew.update([root, ...Array.from({ length: 8 }, (_, index) => entry(`worker-${index}`, ChatAgentActivity.Testing))], options);
		const crowded = snapshot();
		crew.update([root], { ...options, visible: false });
		const hidden = snapshot();

		assert.deepStrictEqual({ working, finished, leaving, left, crowded, hidden }, {
			working: {
				hidden: false,
				label: '3 agents working: Main agent: Programming, Review agent: Reviewing, Explore: Researching',
				pets: ['reviewing, tint 35deg', 'researching, tint -35deg'],
				crowded: false,
			},
			finished: {
				hidden: false,
				label: '1 agent working: Main agent: Programming',
				pets: ['done, tint 35deg', 'failed, tint -35deg'],
				crowded: false,
			},
			leaving: {
				hidden: false,
				label: '1 agent working: Main agent: Programming',
				pets: ['done (leaving), tint 35deg', 'failed (leaving), tint -35deg'],
				crowded: false,
			},
			left: { hidden: false, label: '1 agent working: Main agent: Programming', pets: [], crowded: false },
			crowded: {
				hidden: false,
				label: '9 agents working: Main agent: Programming, Subagent: Running Commands, Subagent: Running Commands, Subagent: Running Commands, Subagent: Running Commands, Subagent: Running Commands, Subagent: Running Commands, Subagent: Running Commands, Subagent: Running Commands',
				// Every subagent keeps its pet; the seventh and eighth reuse the first tints.
				pets: [35, -35, 70, -70, 105, 150, 35, -35].map(hue => `testing, tint ${hue}deg`),
				crowded: true,
			},
			hidden: { hidden: true, label: '1 agent working: Main agent: Programming', pets: [], crowded: false },
		});
	});
});
