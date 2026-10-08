/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Agents section of the Sessions sidebar, which folds open to show the Agents tree.

import * as DOM from '../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { SessionsAgentsTreeControl } from './sessionsAgentsTreeView.js';

const $ = DOM.$;

const COLLAPSED_STORAGE_KEY = 'sessions.agentsTree.collapsed';
const OPEN_HEIGHT_STORAGE_KEY = 'sessions.agentsTree.openHeight';

/** Height of the section header, the same as a section of the Sessions list. */
const HEADER_HEIGHT = 26;

const DEFAULT_OPEN_HEIGHT = 280;
const MIN_OPEN_HEIGHT = 120;

/**
 * A pane of the Sessions sidebar with a header like the Chats section. Clicking the header folds
 * the Agents tree open or closed; the host lets the user drag the open pane to another height.
 * Both are remembered.
 */
export class SessionsAgentsTreeSection extends Disposable {

	readonly element: HTMLElement;
	private readonly _header: HTMLElement;
	private readonly _chevron: HTMLElement;
	private readonly _treeContainer: HTMLElement;
	private readonly _control: SessionsAgentsTreeControl;
	private _collapsed: boolean;
	private _openHeight: number;
	private _hostVisible = true;

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	/** Fires when the section folds open or closed, so the host resizes it. */
	readonly onDidChangeHeight: Event<void> = this._onDidChangeHeight.event;

	constructor(
		parent: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._collapsed = this._storageService.getBoolean(COLLAPSED_STORAGE_KEY, StorageScope.PROFILE, true);
		this._openHeight = Math.max(MIN_OPEN_HEIGHT, this._storageService.getNumber(OPEN_HEIGHT_STORAGE_KEY, StorageScope.PROFILE, DEFAULT_OPEN_HEIGHT));

		this.element = DOM.append(parent, $('.agent-sessions-agents-tree-section'));
		const header = this._header = DOM.append(this.element, $('.session-section.agents-tree-section-header'));
		header.setAttribute('role', 'button');
		header.tabIndex = 0;
		this._chevron = DOM.append(header, $('span.session-section-chevron.collapsible'));
		this._chevron.setAttribute('aria-hidden', 'true');
		const icon = DOM.append(header, $('span.session-section-icon'));
		icon.setAttribute('aria-hidden', 'true');
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.typeHierarchySub));
		const labelContainer = DOM.append(header, $('span.session-section-label-container'));
		DOM.append(labelContainer, $('span.session-section-label')).textContent = localize('sessionsAgentsTree.section', "Agents");

		this._register(DOM.addDisposableListener(header, DOM.EventType.CLICK, () => this.toggle()));
		this._register(DOM.addDisposableListener(header, DOM.EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.toggle();
			}
		}));

		this._treeContainer = DOM.append(this.element, $('.agents-tree-section-tree'));
		this._control = this._register(instantiationService.createInstance(SessionsAgentsTreeControl));
		this._control.render(this._treeContainer);
		this._update();
	}

	get collapsed(): boolean {
		return this._collapsed;
	}

	/** Height of the folded section: just its header. */
	get collapsedHeight(): number {
		return HEADER_HEIGHT;
	}

	get minimumOpenHeight(): number {
		return MIN_OPEN_HEIGHT;
	}

	/** Height of the open section, as the user last dragged it. */
	get openHeight(): number {
		return this._openHeight;
	}

	set openHeight(height: number) {
		height = Math.max(MIN_OPEN_HEIGHT, Math.round(height));
		if (height !== this._openHeight) {
			this._openHeight = height;
			this._storageService.store(OPEN_HEIGHT_STORAGE_KEY, height, StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	toggle(): void {
		this.setCollapsed(!this._collapsed);
	}

	setCollapsed(collapsed: boolean): void {
		if (this._collapsed === collapsed) {
			return;
		}
		if (collapsed && this._treeContainer.contains(DOM.getActiveElement())) {
			this._header.focus();
		}
		this._collapsed = collapsed;
		this._storageService.store(COLLAPSED_STORAGE_KEY, collapsed, StorageScope.PROFILE, StorageTarget.USER);
		this._update();
		this._onDidChangeHeight.fire();
	}

	/** Opens the section and moves focus to it. */
	reveal(): void {
		this.setCollapsed(false);
		this._header.focus();
	}

	/** Whether the Sessions sidebar that hosts the section is visible. */
	setHostVisible(visible: boolean): void {
		this._hostVisible = visible;
		this._control.setVisible(visible && !this._collapsed);
	}

	layout(height: number): void {
		this.element.style.height = `${height}px`;
		this._control.layout(Math.max(0, height - HEADER_HEIGHT));
	}

	private _update(): void {
		this._header.classList.toggle('collapsed', this._collapsed);
		this._header.setAttribute('aria-expanded', String(!this._collapsed));
		this._chevron.className = 'session-section-chevron collapsible';
		this._chevron.classList.add(...ThemeIcon.asClassNameArray(this._collapsed ? Codicon.chevronRight : Codicon.chevronDown));
		this._treeContainer.style.display = this._collapsed ? 'none' : '';
		this._control.setVisible(this._hostVisible && !this._collapsed);
	}
}
