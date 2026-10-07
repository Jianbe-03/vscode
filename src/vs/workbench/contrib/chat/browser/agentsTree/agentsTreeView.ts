/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the "Agents" view, a live tree of chats and the (nested) subagents they started.

import './media/agentsTree.css';
import * as dom from '../../../../../base/browser/dom.js';
import { IManagedHover } from '../../../../../base/browser/ui/hover/hover.js';
import { getDefaultHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { getDurationString } from '../../../../../base/common/date.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, runOnChange } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { AgentsTreeActivity, AgentsTreeStatus, buildSubagentNodes, getAgentsTreeActivity, getClosedChatStatus, IAgentsTreeSubagentNode, orderAgentsTreeRoots } from '../../common/agentsTree/agentsTreeModel.js';
import { IChatDetail, IChatService, IChatToolInvocation } from '../../common/chatService/chatService.js';
import { ChatAgentLocation, CHAT_OPEN_AGENT_HOST_CHAT_COMMAND_ID } from '../../common/constants.js';
import { IChatModel } from '../../common/model/chatModel.js';
import { isResponseVM } from '../../common/model/chatViewModel.js';
import { IChatWidget, IChatWidgetService } from '../chat.js';
import { ChatSubagentContentPart } from '../widget/chatContentParts/chatSubagentContentPart.js';
import { IOpenSubagentChatContext } from '../widget/chatContentParts/chatSubagentOpenChat.js';
import { ChatWidget } from '../widget/chatWidget.js';

export const AGENTS_TREE_VIEW_ID = 'workbench.panel.chat.view.agentsTree';

/**
 * A chat (or, in the Agents window, a session) at the root of the tree, or a session created by another session.
 */
export interface IAgentsTreeChatElement {
	readonly kind: 'chat';
	readonly id: string;
	readonly label: string;
	readonly status: AgentsTreeStatus | undefined;
	/** The chat session resource, or the Agents window session resource. */
	readonly resource: URI;
	/** Set when the chat was closed (no longer loaded) or the Agents window session was archived. */
	readonly closed?: 'closed' | 'archived';
	readonly children: readonly AgentsTreeElement[];
}

/**
 * A subagent started by a chat request or by another subagent.
 */
export interface IAgentsTreeSubagentElement {
	readonly kind: 'subagent';
	readonly id: string;
	readonly node: IAgentsTreeSubagentNode;
	/** The chat whose response started the subagent. */
	readonly sessionResource: URI;
	readonly responseId: string;
	readonly children: readonly AgentsTreeElement[];
}

/**
 * A named group of sessions, such as an agent-created session group.
 */
export interface IAgentsTreeGroupElement {
	readonly kind: 'group';
	readonly id: string;
	readonly label: string;
	readonly children: readonly AgentsTreeElement[];
}

export type AgentsTreeElement = IAgentsTreeChatElement | IAgentsTreeSubagentElement | IAgentsTreeGroupElement;

/**
 * Builds the subagent elements of all requests of a chat model. A subagent that runs as its own
 * chat continues with the subagents of that chat when its model is loaded.
 * @param referencedChats collects the chat resources of subagents that run as their own chat.
 */
export function buildChatModelSubagentElements(chatService: IChatService, model: IChatModel, now: number, referencedChats: Set<string>, visited = new Set<string>()): IAgentsTreeSubagentElement[] {
	const modelKey = model.sessionResource.toString();
	if (visited.has(modelKey)) {
		return [];
	}
	visited.add(modelKey);

	const toElement = (node: IAgentsTreeSubagentNode, responseId: string): IAgentsTreeSubagentElement => {
		let children: AgentsTreeElement[] = node.children.map(child => toElement(child, responseId));
		if (node.chatResource) {
			referencedChats.add(node.chatResource);
			const childModel = children.length === 0 ? chatService.getSession(URI.parse(node.chatResource)) : undefined;
			if (childModel) {
				children = buildChatModelSubagentElements(chatService, childModel, now, referencedChats, visited);
			}
		}
		return { kind: 'subagent', id: `${modelKey}#${node.id}`, node, sessionResource: model.sessionResource, responseId, children };
	};

	const elements: IAgentsTreeSubagentElement[] = [];
	for (const request of model.getRequests()) {
		const response = request.response;
		if (!response) {
			continue;
		}
		const invocations = response.response.value.filter(part => part.kind === 'toolInvocation' || part.kind === 'toolInvocationSerialized');
		for (const node of buildSubagentNodes(invocations, now)) {
			elements.push(toElement(node, response.id));
		}
	}
	return elements;
}

/**
 * Returns the status shown for a chat: running while a request is in progress, waiting when it needs input.
 */
export function getChatModelStatus(model: IChatModel): AgentsTreeStatus | undefined {
	if (model.requestNeedsInput.get()) {
		return AgentsTreeStatus.WaitingForConfirmation;
	}
	return model.requestInProgress.get() ? AgentsTreeStatus.Running : undefined;
}

/**
 * Calls `onChange` whenever a live chat model changes in a way that affects the Agents tree:
 * requests and response parts being added, titles, request progress and tool invocation state.
 */
export class ChatModelsActivityTracker extends Disposable {

	private readonly _models = this._register(new DisposableMap<IChatModel, DisposableStore>());

	constructor(
		private readonly _onChange: () => void,
		@IChatService chatService: IChatService,
	) {
		super();
		this._register(autorun(reader => {
			const models = new Set(chatService.chatModels.read(reader));
			for (const model of [...this._models.keys()]) {
				if (!models.has(model)) {
					this._models.deleteAndDispose(model);
				}
			}
			for (const model of models) {
				if (!this._models.has(model)) {
					this._models.set(model, this._trackModel(model));
				}
			}
			this._onChange();
		}));
	}

	private _trackModel(model: IChatModel): DisposableStore {
		const store = new DisposableStore();
		const responses = store.add(new DisposableMap<string, DisposableStore>());
		const invocations = store.add(new DisposableMap<string, DisposableStore>());

		const syncInvocations = () => {
			for (const request of model.getRequests()) {
				for (const part of request.response?.response.value ?? []) {
					if (part.kind !== 'toolInvocation' || invocations.has(part.toolCallId) || IChatToolInvocation.isComplete(part)) {
						continue;
					}
					const invocationStore = new DisposableStore();
					invocationStore.add(runOnChange(part.state, () => this._onChange()));
					invocationStore.add(runOnChange(part.toolSpecificDataKind, () => this._onChange()));
					invocations.set(part.toolCallId, invocationStore);
				}
			}
		};
		const syncResponses = () => {
			for (const request of model.getRequests()) {
				const response = request.response;
				if (response && !responses.has(response.id)) {
					const responseStore = new DisposableStore();
					responseStore.add(response.onDidChange(() => {
						syncInvocations();
						this._onChange();
					}));
					responses.set(response.id, responseStore);
				}
			}
			syncInvocations();
		};

		store.add(model.onDidChange(() => {
			syncResponses();
			this._onChange();
		}));
		store.add(runOnChange(model.requestInProgress, () => this._onChange()));
		store.add(runOnChange(model.requestNeedsInput, () => this._onChange()));
		syncResponses();
		return store;
	}
}

function getStatusIcon(status: AgentsTreeStatus | undefined): ThemeIcon | undefined {
	switch (status) {
		case AgentsTreeStatus.Running: return ThemeIcon.modify(Codicon.loading, 'spin');
		case AgentsTreeStatus.WaitingForConfirmation: return Codicon.question;
		case AgentsTreeStatus.Done: return Codicon.check;
		case AgentsTreeStatus.Failed: return Codicon.error;
		case AgentsTreeStatus.Cancelled: return Codicon.circleSlash;
		default: return undefined;
	}
}

function getStatusLabel(status: AgentsTreeStatus | undefined): string | undefined {
	switch (status) {
		case AgentsTreeStatus.Running: return localize('agentsTree.status.running', "Running");
		case AgentsTreeStatus.WaitingForConfirmation: return localize('agentsTree.status.waiting', "Waiting for Confirmation");
		case AgentsTreeStatus.Done: return localize('agentsTree.status.done', "Done");
		case AgentsTreeStatus.Failed: return localize('agentsTree.status.failed', "Failed");
		case AgentsTreeStatus.Cancelled: return localize('agentsTree.status.cancelled', "Cancelled");
		default: return undefined;
	}
}

function getSubagentLabel(node: IAgentsTreeSubagentNode): string {
	return node.name ?? localize('agentsTree.subagent', "Subagent");
}

function formatDuration(duration: number | undefined): string | undefined {
	if (duration === undefined) {
		return undefined;
	}
	// Whole seconds keep the live duration calm while it ticks.
	return getDurationString(duration < 1000 ? duration : Math.round(duration / 1000) * 1000);
}

function getElementLabel(element: AgentsTreeElement): string {
	return element.kind === 'subagent' ? getSubagentLabel(element.node) : element.label;
}
function getElementStatus(element: AgentsTreeElement): AgentsTreeStatus | undefined {
	switch (element.kind) {
		case 'chat': return element.status;
		case 'subagent': return element.node.status;
		case 'group': return undefined;
	}
}

/**
 * Returns whether an element is active, idle or has ended. A session group is active while one of its sessions is.
 */
function getElementActivity(element: AgentsTreeElement): AgentsTreeActivity {
	switch (element.kind) {
		case 'chat': return getAgentsTreeActivity(element.status, !!element.closed);
		case 'subagent': return getAgentsTreeActivity(element.node.status, false);
		case 'group': {
			const activities = element.children.map(getElementActivity);
			return activities.includes(AgentsTreeActivity.Active) ? AgentsTreeActivity.Active
				: activities.length > 0 && activities.every(activity => activity === AgentsTreeActivity.Ended) ? AgentsTreeActivity.Ended
					: AgentsTreeActivity.Idle;
		}
	}
}

/**
 * Returns the label that tells an element is turned off: closed, archived or ended.
 */
function getEndedLabel(element: AgentsTreeElement): string | undefined {
	if (getElementActivity(element) !== AgentsTreeActivity.Ended) {
		return undefined;
	}
	if (element.kind === 'chat' && element.closed === 'archived') {
		return localize('agentsTree.state.archived', "Archived");
	}
	if (element.kind === 'chat' && element.closed === 'closed') {
		return localize('agentsTree.state.closed', "Closed");
	}
	return localize('agentsTree.state.ended', "Ended");
}

function getElementIcon(element: AgentsTreeElement): ThemeIcon {
	switch (element.kind) {
		case 'chat': return getStatusIcon(element.status) ?? Codicon.commentDiscussion;
		case 'group': return Codicon.layers;
		case 'subagent': return getStatusIcon(element.node.status) ?? Codicon.hubot;
	}
}

function getElementId(element: AgentsTreeElement): string {
	return `${element.kind}:${element.id}`;
}

function countDescendants(element: AgentsTreeElement): number {
	return element.children.reduce((count, child) => count + 1 + countDescendants(child), 0);
}

function getAriaLabel(element: AgentsTreeElement): string {
	const label = getElementAriaLabel(element);
	const ended = getEndedLabel(element);
	return ended ? localize('agentsTree.ended.ariaLabel', "{0}, {1}", label, ended) : label;
}

function getElementAriaLabel(element: AgentsTreeElement): string {
	switch (element.kind) {
		case 'subagent': {
			const node = element.node;
			return localize('agentsTree.subagent.ariaLabel', "{0} {1}, {2} {3}", getSubagentLabel(node), node.description ?? '', getStatusLabel(node.status) ?? '', formatDuration(node.duration) ?? '');
		}
		case 'chat': {
			const status = getStatusLabel(element.status);
			return status ? localize('agentsTree.chat.ariaLabel', "{0}, {1}", element.label, status) : element.label;
		}
		case 'group':
			return localize('agentsTree.group.ariaLabel', "Session group {0}", element.label);
	}
}

/**
 * A rendered card of the Agents tree and the elements whose content changes with live updates.
 */
interface IRenderedAgentCard {
	readonly id: string;
	/** Id of the card this card is connected to, if any. */
	readonly parentId: string | undefined;
	element: AgentsTreeElement;
	readonly node: HTMLElement;
	readonly card: HTMLElement;
	readonly icon: HTMLElement;
	readonly label: HTMLElement;
	/** Pill that tells the agent is turned off. */
	readonly state: HTMLElement;
	readonly duration: HTMLElement;
	readonly description: HTMLElement;
	readonly model: HTMLElement;
	readonly hiddenCount: HTMLElement;
	readonly hover: IManagedHover;
}

/**
 * Renders the Agents tree as blocks: each chat, subagent or session group is a card, connected to
 * the cards of the subagents it started by lines, to any depth.
 */
class AgentsBlockTree extends Disposable {

	private readonly _domNode: HTMLElement;
	private readonly _renderStore = this._register(new DisposableStore());
	private readonly _collapsed = new Set<string>();
	private _roots: readonly AgentsTreeElement[] = [];
	/** The rendered cards in document order. */
	private _cards: IRenderedAgentCard[] = [];
	private _structureKey: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly _open: (element: AgentsTreeElement, preserveFocus: boolean) => void,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super();
		this._domNode = dom.append(container, dom.$('.agents-tree', { role: 'tree', 'aria-label': localize('agentsTree.ariaLabel', "Agents") }));
		this._register(dom.addDisposableListener(this._domNode, dom.EventType.KEY_DOWN, e => this._onKeyDown(new StandardKeyboardEvent(e))));
	}

	setRoots(roots: readonly AgentsTreeElement[]): void {
		this._roots = roots;
		this._render();
	}

	private _render(): void {
		// Live updates (status, durations) patch the cards in place, which keeps hovers and focus steady.
		const structureKey = this._getStructureKey(this._roots);
		if (structureKey === this._structureKey) {
			const elements = new Map<string, AgentsTreeElement>();
			const collect = (items: readonly AgentsTreeElement[]) => items.forEach(item => {
				elements.set(getElementId(item), item);
				collect(item.children);
			});
			collect(this._roots);
			for (const entry of this._cards) {
				const element = elements.get(entry.id);
				if (element) {
					this._updateCard(entry, element);
				}
			}
			return;
		}
		this._structureKey = structureKey;

		const active = dom.getActiveElement();
		const focusedId = dom.isHTMLElement(active) && this._domNode.contains(active) ? active.dataset.agentsTreeId : undefined;

		this._renderStore.clear();
		dom.clearNode(this._domNode);
		this._cards = [];
		if (this._roots.length === 0) {
			dom.append(this._domNode, dom.$('.agents-tree-empty', undefined, localize('agentsTree.empty', "Chats and the subagents they start appear here.")));
			return;
		}
		for (const root of this._roots) {
			this._renderElement(this._domNode, root, 1, undefined);
		}

		if (focusedId) {
			this._focus(focusedId);
		}
	}

	/**
	 * Identifies the rendered structure: which cards exist, how they nest and which are collapsed.
	 */
	private _getStructureKey(elements: readonly AgentsTreeElement[]): string {
		return elements.map(element => {
			const id = getElementId(element);
			const collapsed = this._collapsed.has(id);
			return `${JSON.stringify(id)}${collapsed ? '-' : '+'}[${collapsed ? element.children.length : this._getStructureKey(element.children)}]`;
		}).join(',');
	}

	private _renderElement(parent: HTMLElement, element: AgentsTreeElement, level: number, parentId: string | undefined): void {
		const id = getElementId(element);
		const hasChildren = element.children.length > 0;
		const collapsed = hasChildren && this._collapsed.has(id);

		const node = dom.append(parent, dom.$('.agents-tree-node'));
		node.dataset.kind = element.kind;

		const card = dom.append(node, dom.$('.agents-tree-card', { role: 'treeitem', tabIndex: 0 }));
		card.dataset.agentsTreeId = id;
		card.setAttribute('aria-level', String(level));
		if (hasChildren) {
			card.setAttribute('aria-expanded', String(!collapsed));
		}

		const header = dom.append(card, dom.$('.agents-tree-card-header'));
		const icon = dom.append(header, dom.$('.agents-tree-icon'));
		const label = dom.append(header, dom.$('.agents-tree-label'));
		const state = dom.append(header, dom.$('.agents-tree-state'));
		const duration = dom.append(header, dom.$('.agents-tree-duration'));
		if (hasChildren) {
			const twistie = dom.append(header, dom.$(`.agents-tree-twistie${ThemeIcon.asCSSSelector(collapsed ? Codicon.chevronRight : Codicon.chevronDown)}`));
			this._renderStore.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), twistie, collapsed ? localize('agentsTree.expand', "Expand") : localize('agentsTree.collapse', "Collapse")));
			this._renderStore.add(dom.addDisposableListener(twistie, dom.EventType.CLICK, e => {
				dom.EventHelper.stop(e, true);
				this._toggle(id);
			}));
		}
		const description = dom.append(card, dom.$('.agents-tree-description'));
		const footer = dom.append(card, dom.$('.agents-tree-card-footer'));
		const model = dom.append(footer, dom.$('.agents-tree-model'));
		const hiddenCount = dom.append(footer, dom.$('.agents-tree-hidden-count'));
		const hover = this._renderStore.add(this._hoverService.setupManagedHover(getDefaultHoverDelegate('mouse'), card, ''));

		const entry: IRenderedAgentCard = { id, parentId, element, node, card, icon, label, state, duration, description, model, hiddenCount, hover };
		this._cards.push(entry);
		this._updateCard(entry, element);
		this._renderStore.add(dom.addDisposableListener(card, dom.EventType.CLICK, () => this._open(entry.element, true)));

		if (hasChildren && !collapsed) {
			const children = dom.append(node, dom.$('.agents-tree-children', { role: 'group' }));
			for (const child of element.children) {
				this._renderElement(children, child, level + 1, id);
			}
		}
	}

	private _updateCard(entry: IRenderedAgentCard, element: AgentsTreeElement): void {
		entry.element = element;
		const status = getElementStatus(element);
		const endedLabel = getEndedLabel(element);
		entry.node.dataset.status = status ?? '';
		entry.node.dataset.activity = getElementActivity(element);
		entry.card.setAttribute('aria-label', getAriaLabel(element));
		entry.state.textContent = endedLabel ?? '';
		entry.icon.className = `agents-tree-icon ${ThemeIcon.asClassName(getElementIcon(element))}`;

		const label = getElementLabel(element);
		const duration = element.kind === 'subagent' ? formatDuration(element.node.duration) : undefined;
		const description = element.kind === 'subagent' ? element.node.description : undefined;
		const model = element.kind === 'subagent' ? element.node.modelName : undefined;
		const hiddenCount = entry.card.getAttribute('aria-expanded') === 'false' ? countDescendants(element) : 0;
		entry.label.textContent = label;
		entry.duration.textContent = duration ?? '';
		entry.description.textContent = description ?? '';
		entry.model.textContent = model ?? '';
		entry.hiddenCount.textContent = !hiddenCount ? '' : hiddenCount === 1 ? localize('agentsTree.hiddenOne', "1 more agent") : localize('agentsTree.hiddenMany', "{0} more agents", hiddenCount);

		const statusLabel = getStatusLabel(status);
		const hoverLines = [description ? localize('agentsTree.hover.description', "{0}: {1}", label, description) : label];
		if (model) {
			hoverLines.push(localize('agentsTree.hover.model', "Model: {0}", model));
		}
		if (statusLabel) {
			hoverLines.push(duration ? localize('agentsTree.hover.statusDuration', "{0} ({1})", statusLabel, duration) : statusLabel);
		}
		if (endedLabel) {
			hoverLines.push(element.kind === 'chat' && element.closed === 'archived'
				? localize('agentsTree.hover.archived', "Archived: this session is turned off")
				: element.kind === 'chat' && element.closed === 'closed'
					? localize('agentsTree.hover.closed', "Closed: this chat is turned off")
					: localize('agentsTree.hover.ended', "Ended: this agent is turned off"));
		}
		entry.hover.update(hoverLines.join('\n'));
	}

	private _focus(id: string | undefined): void {
		this._cards.find(entry => entry.id === id)?.card.focus();
	}

	private _toggle(id: string, expand?: boolean): void {
		const collapse = expand === undefined ? !this._collapsed.has(id) : !expand;
		if (collapse) {
			this._collapsed.add(id);
		} else {
			this._collapsed.delete(id);
		}
		this._render();
		this._focus(id);
	}

	private _findElement(id: string, elements: readonly AgentsTreeElement[] = this._roots): AgentsTreeElement | undefined {
		for (const element of elements) {
			if (getElementId(element) === id) {
				return element;
			}
			const found = this._findElement(id, element.children);
			if (found) {
				return found;
			}
		}
		return undefined;
	}

	private _onKeyDown(event: StandardKeyboardEvent): void {
		const index = this._cards.findIndex(entry => dom.isHTMLElement(event.target) && entry.card.contains(event.target));
		if (index === -1) {
			return;
		}
		const { id, card, parentId } = this._cards[index];
		const cards = this._cards.map(entry => entry.card);
		const expanded = card.getAttribute('aria-expanded');
		let handled = true;
		switch (event.keyCode) {
			case KeyCode.UpArrow: cards[Math.max(0, index - 1)].focus(); break;
			case KeyCode.DownArrow: cards[Math.min(cards.length - 1, index + 1)].focus(); break;
			case KeyCode.Home: cards[0].focus(); break;
			case KeyCode.End: cards[cards.length - 1].focus(); break;
			case KeyCode.RightArrow:
				if (expanded === 'false') {
					this._toggle(id, true);
				} else if (expanded === 'true') {
					cards[index + 1]?.focus();
				}
				break;
			case KeyCode.LeftArrow:
				if (expanded === 'true') {
					this._toggle(id, false);
				} else {
					this._focus(parentId);
				}
				break;
			case KeyCode.Enter:
			case KeyCode.Space: {
				const element = this._findElement(id);
				if (element) {
					this._open(element, false);
				}
				break;
			}
			default: handled = false;
		}
		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	}
}

/**
 * Finds the rendered subagent part of a response, including subagents nested in other subagents.
 */
function findRenderedSubagentPart(widget: IChatWidget, responseId: string, subAgentInvocationId: string): ChatSubagentContentPart | undefined {
	if (!(widget instanceof ChatWidget)) {
		return undefined;
	}
	for (const part of widget.getTemplateDataForRequestId(responseId)?.renderedParts ?? []) {
		if (part instanceof ChatSubagentContentPart) {
			const found = part.findSubagentPart(subAgentInvocationId);
			if (found) {
				return found;
			}
		}
	}
	return undefined;
}

/**
 * Base view of the live Agents tree. Subclasses supply the root elements and how to open them.
 */
export abstract class AgentsTreeViewPane extends ViewPane {

	private _tree: AgentsBlockTree | undefined;
	private _scrollContainer: HTMLElement | undefined;
	private readonly _refreshScheduler = this._register(new RunOnceScheduler(() => this._refresh(), 100));
	private readonly _tickScheduler = this._register(new RunOnceScheduler(() => this._refresh(), 1000));
	private readonly _pendingReveal = this._register(new MutableDisposable());
	private _isDirty = true;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IChatService protected readonly chatService: IChatService,
		@IChatWidgetService protected readonly chatWidgetService: IChatWidgetService,
		@ICommandService protected readonly commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(instantiationService.createInstance(ChatModelsActivityTracker, () => this.scheduleRefresh()));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible && this._isDirty) {
				this._refresh();
			}
		}));
	}

	/**
	 * Computes the root elements of the tree.
	 * @param now the current time, used for the elapsed duration of running subagents.
	 */
	protected abstract computeRoots(now: number): AgentsTreeElement[];

	/** Opens a chat (or session) element. */
	protected abstract openChat(element: IAgentsTreeChatElement, preserveFocus: boolean): Promise<void>;

	/** Opens the chat that started a subagent that does not run as its own chat. */
	protected async openSubagentParentChat(element: IAgentsTreeSubagentElement, preserveFocus: boolean): Promise<IChatWidget | undefined> {
		return this.chatWidgetService.openSession(element.sessionResource, undefined, { preserveFocus });
	}

	protected scheduleRefresh(): void {
		this._isDirty = true;
		if (this._tree && this.isBodyVisible()) {
			this._refreshScheduler.schedule();
		}
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('agents-tree-view');
		this._scrollContainer = dom.append(container, dom.$('.agents-tree-scroll'));
		this._tree = this._register(this.instantiationService.createInstance(AgentsBlockTree, this._scrollContainer, (element: AgentsTreeElement, preserveFocus: boolean) => void this._open(element, preserveFocus)));
		this._refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this._scrollContainer) {
			this._scrollContainer.style.height = `${height}px`;
		}
	}

	private _refresh(): void {
		this._refreshScheduler.cancel();
		this._tickScheduler.cancel();
		if (!this._tree || !this.isBodyVisible()) {
			return;
		}
		this._isDirty = false;
		const roots = this.computeRoots(Date.now());
		let hasRunning = false;
		const visit = (elements: readonly AgentsTreeElement[]): void => {
			for (const element of elements) {
				const status = getElementStatus(element);
				hasRunning ||= status === AgentsTreeStatus.Running || status === AgentsTreeStatus.WaitingForConfirmation;
				visit(element.children);
			}
		};
		visit(roots);
		this._tree.setRoots(roots);
		if (hasRunning) {
			// Keeps the elapsed durations of running subagents current.
			this._tickScheduler.schedule();
		}
	}

	private async _open(element: AgentsTreeElement, preserveFocus: boolean): Promise<void> {
		switch (element.kind) {
			case 'chat':
				return this.openChat(element, preserveFocus);
			case 'group':
				return;
			case 'subagent':
				return this._openSubagent(element, preserveFocus);
		}
	}

	private async _openSubagent(element: IAgentsTreeSubagentElement, preserveFocus: boolean): Promise<void> {
		const node = element.node;
		if (node.chatResource) {
			const context: IOpenSubagentChatContext = {
				chatResource: node.chatResource,
				parentSessionResource: element.sessionResource.toString(),
				title: node.description,
			};
			await this.commandService.executeCommand(CHAT_OPEN_AGENT_HOST_CHAT_COMMAND_ID, context);
			return;
		}

		const widget = await this.openSubagentParentChat(element, preserveFocus);
		const response = widget?.viewModel?.getItems().find(item => isResponseVM(item) && item.id === element.responseId);
		if (!widget || !response) {
			return;
		}
		// Bring the response into the rendered range first, then reveal the (possibly nested) subagent part.
		widget.reveal(response);
		this._pendingReveal.value = dom.scheduleAtNextAnimationFrame(dom.getWindow(widget.domNode), () => {
			const part = findRenderedSubagentPart(widget, element.responseId, node.id);
			if (part) {
				part.expandAncestors();
				part.domNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
			}
		});
	}
}

/**
 * Turns a closed chat from the chat history into a (childless) element of the Agents tree.
 */
export function toClosedChatElement(detail: IChatDetail): IAgentsTreeChatElement {
	return {
		kind: 'chat',
		id: detail.sessionResource.toString(),
		label: detail.title || localize('agentsTree.untitledChat', "New Chat"),
		status: getClosedChatStatus(detail.lastResponseState),
		resource: detail.sessionResource,
		closed: 'closed',
		children: [],
	};
}

/**
 * The Agents view of the editor window: the chats of the Chat view and chat editors, with their subagents,
 * and the most recently closed chats, shown as turned off.
 */
export class ChatAgentsTreeViewPane extends AgentsTreeViewPane {

	private _closedChats: readonly IChatDetail[] = [];
	private _isDisposed = false;
	private readonly _closedChatsScheduler = this._register(new RunOnceScheduler(() => void this._loadClosedChats(), 250));

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IChatService chatService: IChatService,
		@IChatWidgetService chatWidgetService: IChatWidgetService,
		@ICommandService commandService: ICommandService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService, chatService, chatWidgetService, commandService);
		// A chat that closes moves to the chat history; a deleted one leaves it.
		this._register(autorun(reader => {
			chatService.chatModels.read(reader);
			this._closedChatsScheduler.schedule();
		}));
		this._register(chatService.onDidDisposeSession(() => this._closedChatsScheduler.schedule()));
	}

	private async _loadClosedChats(): Promise<void> {
		let closedChats: IChatDetail[];
		try {
			closedChats = await this.chatService.getHistorySessionItems();
		} catch (error) {
			onUnexpectedError(error);
			return;
		}
		if (this._isDisposed) {
			return;
		}
		this._closedChats = closedChats;
		this.scheduleRefresh();
	}

	override dispose(): void {
		this._isDisposed = true;
		super.dispose();
	}

	protected computeRoots(now: number): AgentsTreeElement[] {
		const referencedChats = new Set<string>();
		const loadedChats = new Set<string>();
		const roots: { element: IAgentsTreeChatElement; lastActivity: number }[] = [];
		for (const model of this.chatService.chatModels.get()) {
			loadedChats.add(model.sessionResource.toString());
			if (model.initialLocation !== ChatAgentLocation.Chat || !model.hasRequests) {
				continue;
			}
			const children = buildChatModelSubagentElements(this.chatService, model, now, referencedChats);
			roots.push({
				lastActivity: model.lastMessageDate,
				element: {
					kind: 'chat',
					id: model.sessionResource.toString(),
					label: model.title || localize('agentsTree.untitledChat', "New Chat"),
					status: getChatModelStatus(model),
					resource: model.sessionResource,
					children,
				}
			});
		}
		for (const detail of this._closedChats) {
			if (!loadedChats.has(detail.sessionResource.toString())) {
				roots.push({ element: toClosedChatElement(detail), lastActivity: detail.lastMessageDate });
			}
		}
		// Subagents that run as their own chat are shown under the chat that started them.
		const visibleRoots = roots.filter(root => !referencedChats.has(root.element.id));
		return orderAgentsTreeRoots(visibleRoots, root => ({ status: root.element.status, closed: !!root.element.closed, lastActivity: root.lastActivity }))
			.map(root => root.element);
	}

	protected async openChat(element: IAgentsTreeChatElement, preserveFocus: boolean): Promise<void> {
		await this.chatWidgetService.openSession(element.resource, undefined, { preserveFocus });
	}
}
