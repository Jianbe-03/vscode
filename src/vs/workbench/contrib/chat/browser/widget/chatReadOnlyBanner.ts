/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatReadOnlyBanner.css';
import * as dom from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';

export const CHAT_READ_ONLY_BANNER_HEIGHT = 26;

/** CreaEditor: an action of a {@link IChatLockNotice}, shown as a link in the banner. */
export interface IChatLockNoticeAction {
	readonly label: string;
	readonly run: () => void;
}

/** CreaEditor: why a chat cannot be sent to (e.g. it continues on a server), with what to do about it. */
export interface IChatLockNotice {
	readonly message: string;
	readonly actions: readonly IChatLockNoticeAction[];
}

export class ChatReadOnlyBanner extends Disposable {

	readonly domNode: HTMLElement;

	private _visible = false;
	private readonly _text: HTMLElement;
	private readonly _actions: HTMLElement;
	private readonly _defaultMessage: string;
	private readonly _noticeDisposables = this._register(new DisposableStore());

	constructor(
		message: string = localize('chatReadOnlyBanner.archivedMessage', "Archived sessions are read-only."),
		@IHoverService hoverService: IHoverService,
	) {
		super();

		this.domNode = dom.$('.chat-readonly-banner');
		this.domNode.setAttribute('role', 'status');

		const icon = dom.append(this.domNode, dom.$('.chat-readonly-banner-icon'));
		const renderedIcon = renderIcon(Codicon.lock);
		renderedIcon.setAttribute('aria-hidden', 'true');
		icon.appendChild(renderedIcon);

		const text = this._text = dom.append(this.domNode, dom.$('span.chat-readonly-banner-text'));
		text.textContent = message;
		this._defaultMessage = message;
		this._register(hoverService.setupDelayedHover(text, () => ({ content: text.textContent ?? '' })));
		this._actions = dom.append(this.domNode, dom.$('span.chat-readonly-banner-actions'));

		this.setVisible(false);
	}

	/** CreaEditor: shows `notice` instead of the default message, or the default again without one. */
	setNotice(notice: IChatLockNotice | undefined): void {
		this._noticeDisposables.clear();
		dom.clearNode(this._actions);
		this._text.textContent = notice?.message ?? this._defaultMessage;
		this.domNode.classList.toggle('lock-notice', !!notice);
		for (const action of notice?.actions ?? []) {
			const link = dom.append(this._actions, dom.$('a.chat-readonly-banner-action', { role: 'button', tabIndex: 0 }));
			link.textContent = action.label;
			this._noticeDisposables.add(dom.addDisposableListener(link, dom.EventType.CLICK, event => {
				dom.EventHelper.stop(event, true);
				action.run();
			}));
			this._noticeDisposables.add(dom.addDisposableListener(link, dom.EventType.KEY_DOWN, event => {
				if (event.key === 'Enter' || event.key === ' ') {
					dom.EventHelper.stop(event, true);
					action.run();
				}
			}));
		}
	}

	get visible(): boolean {
		return this._visible;
	}

	/** The height the banner takes: one line, or (CreaEditor) a lock notice's wrapped lines at the current width. */
	get height(): number {
		if (!this._visible) {
			return 0;
		}
		return this.domNode.classList.contains('lock-notice') ? this.domNode.offsetHeight || CHAT_READ_ONLY_BANNER_HEIGHT : CHAT_READ_ONLY_BANNER_HEIGHT;
	}

	setVisible(visible: boolean): void {
		this._visible = visible;
		this.domNode.classList.toggle('hidden', !visible);
	}
}
