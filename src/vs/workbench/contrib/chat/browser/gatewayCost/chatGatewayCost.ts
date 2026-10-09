/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: a live counter of the OpenRouter and LiteLLM cost of a chat in the chat header. The
// Copilot extension keeps the cost ledger; it answers `creaeditor.aiCosts.getChatCosts` with the cost
// per chat and calls `_creaeditor.chatGatewayCosts.didChange` when the cost of chats changed.

import './media/chatGatewayCost.css';
import * as dom from '../../../../../base/browser/dom.js';
import { ActionViewItem, IActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IAction } from '../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable, ISettableObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, MenuItemAction, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ActiveEditorContext } from '../../../../common/contextkeys.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { isChatViewTitleActionContext } from '../../common/actions/chatActions.js';
import { LocalChatSessionUri } from '../../common/model/chatUri.js';
import { IChatWidgetService } from '../chat.js';
import { ChatEditorInput } from '../widgetHosts/editor/chatEditorInput.js';
import { CHAT_CATEGORY } from '../actions/chatActions.js';

/** Command of the Copilot extension returning the cost per chat for a list of chat ids. */
const GET_CHAT_COSTS_COMMAND_ID = 'creaeditor.aiCosts.getChatCosts';
/** Command of the Copilot extension that opens the AI Costs page, optionally filtered to `{ chatId }`. */
const SHOW_AI_COSTS_COMMAND_ID = 'creaeditor.showAiCosts';
/** Called by the Copilot extension with the ids of the chats whose cost changed, or without when any may have. */
const DID_CHANGE_CHAT_COSTS_COMMAND_ID = '_creaeditor.chatGatewayCosts.didChange';
/** Maximizes the editor area of the Agents window over the chat (see the sessions editor contribution). */
const MAXIMIZE_MAIN_EDITOR_PART_COMMAND_ID = 'workbench.action.agentSessions.maximizeMainEditorPart';

/** The action behind the counter; its menu items get a {@link ChatGatewayCostActionViewItem}. */
export const SHOW_CHAT_GATEWAY_COST_ACTION_ID = 'workbench.action.chat.showGatewayCost';
/** Opens the AI Costs page in any window: in the Agents window it covers the chat. */
export const SHOW_AI_COSTS_ACTION_ID = 'workbench.action.chat.showAiCosts';

/** Gateway cost of a chat, the requests of its subagents included. */
export interface IChatGatewayCost {
	/** USD. */
	readonly cost: number;
	readonly requests: number;
	/** Requests with a known cost. */
	readonly costed: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly cachedTokens: number;
}

export const IChatGatewayCostService = createDecorator<IChatGatewayCostService>('chatGatewayCostService');

export interface IChatGatewayCostService {
	readonly _serviceBrand: undefined;

	/** The gateway cost of a chat; `undefined` while unknown or when the chat made no gateway requests. */
	getCost(sessionResource: URI): IObservable<IChatGatewayCost | undefined>;

	/** Reads the cost of these chats again (by ledger chat id), or of all chats shown so far. */
	invalidate(chatIds: readonly string[] | undefined): void;
}

/**
 * The id the Copilot extension records a chat's requests with: the session id of a local chat,
 * otherwise the session resource (as for Copilot CLI and agent host sessions).
 */
export function getChatCostId(sessionResource: URI): string {
	return LocalChatSessionUri.parseLocalSessionId(sessionResource) ?? sessionResource.toString();
}

function isChatGatewayCost(value: unknown): value is IChatGatewayCost {
	return !!value && typeof value === 'object' && typeof (value as IChatGatewayCost).cost === 'number' && typeof (value as IChatGatewayCost).requests === 'number';
}

export class ChatGatewayCostService extends Disposable implements IChatGatewayCostService {

	declare readonly _serviceBrand: undefined;

	private readonly _costs = new Map<string, ISettableObservable<IChatGatewayCost | undefined>>();
	private readonly _pending = new Set<string>();
	private readonly _fetchScheduler = this._register(new RunOnceScheduler(() => this._fetch(), 100));

	constructor(
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
	}

	getCost(sessionResource: URI): IObservable<IChatGatewayCost | undefined> {
		const chatId = getChatCostId(sessionResource);
		let cost = this._costs.get(chatId);
		if (!cost) {
			cost = observableValue<IChatGatewayCost | undefined>(this, undefined);
			this._costs.set(chatId, cost);
			this._request(chatId);
		}
		return cost;
	}

	invalidate(chatIds: readonly string[] | undefined): void {
		for (const chatId of chatIds ?? [...this._costs.keys()]) {
			if (this._costs.has(chatId)) {
				this._request(chatId);
			}
		}
	}

	private _request(chatId: string): void {
		this._pending.add(chatId);
		if (!this._fetchScheduler.isScheduled()) {
			this._fetchScheduler.schedule();
		}
	}

	private async _fetch(): Promise<void> {
		const chatIds = [...this._pending];
		this._pending.clear();
		let result: Record<string, unknown> | undefined;
		try {
			result = await this._commandService.executeCommand<Record<string, unknown>>(GET_CHAT_COSTS_COMMAND_ID, chatIds);
		} catch {
			// The Copilot extension is not running (yet); it calls the change command once it is.
			return;
		}
		for (const chatId of chatIds) {
			const cost = result?.[chatId];
			this._costs.get(chatId)?.set(isChatGatewayCost(cost) ? cost : undefined, undefined);
		}
	}
}

registerSingleton(IChatGatewayCostService, ChatGatewayCostService, InstantiationType.Delayed);

CommandsRegistry.registerCommand(DID_CHANGE_CHAT_COSTS_COMMAND_ID, (accessor, chatIds: unknown) => {
	accessor.get(IChatGatewayCostService).invalidate(Array.isArray(chatIds) ? chatIds.filter((chatId): chatId is string => typeof chatId === 'string') : undefined);
});

/** E.g. "$0.42", or "$0.0042" below a cent. */
function formatCost(cost: number): string {
	const digits = cost > 0 && cost < 0.01 ? 4 : 2;
	return cost.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatCostDetails(cost: IChatGatewayCost): string {
	const lines = [
		localize('chatGatewayCost.hoverCost', "OpenRouter and LiteLLM cost of this chat, subagents included: {0}", formatCost(cost.cost)),
		cost.requests === 1
			? localize('chatGatewayCost.hoverOneRequest', "1 request · {0} prompt, {1} completion, {2} cached tokens", cost.promptTokens.toLocaleString(), cost.completionTokens.toLocaleString(), cost.cachedTokens.toLocaleString())
			: localize('chatGatewayCost.hoverRequests', "{0} requests · {1} prompt, {2} completion, {3} cached tokens", cost.requests.toLocaleString(), cost.promptTokens.toLocaleString(), cost.completionTokens.toLocaleString(), cost.cachedTokens.toLocaleString()),
	];
	if (cost.requests > cost.costed) {
		lines.push(localize('chatGatewayCost.hoverWithoutCost', "{0} without a cost yet", (cost.requests - cost.costed).toLocaleString()));
	}
	lines.push(localize('chatGatewayCost.hoverClick', "Click to open AI Costs for this chat."));
	return lines.join('\n');
}

/**
 * The counter, e.g. "$0.42". Hidden while the chat has no gateway cost. The chat comes from
 * `sessionResource`, or else from the toolbar context (the chat view title).
 */
export class ChatGatewayCostActionViewItem extends ActionViewItem {

	private readonly _contextResource = observableValue<URI | undefined>(this, undefined);
	private readonly _resource: IObservable<URI | undefined>;
	private readonly _cost: IObservable<IChatGatewayCost | undefined>;

	constructor(
		action: IAction,
		options: IActionViewItemOptions | undefined,
		sessionResource: IObservable<URI | undefined> | undefined,
		@IChatGatewayCostService chatGatewayCostService: IChatGatewayCostService,
	) {
		super(undefined, action, { ...options, icon: false, label: true });
		this._resource = sessionResource ?? this._contextResource;
		this._cost = derived(this, reader => {
			const resource = this._resource.read(reader);
			return resource ? chatGatewayCostService.getCost(resource).read(reader) : undefined;
		});
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-gateway-cost-item');
		this.label?.classList.add('chat-gateway-cost-label');
		this._register(autorun(reader => {
			const cost = this._cost.read(reader);
			dom.setVisibility(!!cost, container);
			this.updateLabel();
			this.updateTooltip();
			this.updateAriaLabel();
		}));
	}

	override setActionContext(newContext: unknown): void {
		super.setActionContext(newContext);
		if (isChatViewTitleActionContext(newContext)) {
			this._contextResource.set(newContext.sessionResource, undefined);
		}
	}

	override onClick(event: dom.EventLike): void {
		dom.EventHelper.stop(event, true);
		const sessionResource = this._resource.get();
		this.actionRunner.run(this.action, sessionResource ? { sessionResource } : undefined);
	}

	protected override updateLabel(): void {
		if (this.label) {
			const cost = this._cost?.get();
			this.label.textContent = cost ? formatCost(cost.cost) : '';
		}
	}

	protected override getTooltip(): string | undefined {
		const cost = this._cost?.get();
		return cost ? formatCostDetails(cost) : undefined;
	}

	protected override updateAriaLabel(): void {
		const cost = this._cost?.get();
		this.label?.setAttribute('aria-label', cost
			? localize('chatGatewayCost.ariaLabel', "Chat cost {0}, open AI Costs for this chat", formatCost(cost.cost))
			: this.action.label);
	}
}

/** Shows the cost of a chat on the AI Costs page. In the Agents window the page covers the chat. */
registerAction2(class ShowChatGatewayCostAction extends Action2 {
	constructor() {
		super({
			id: SHOW_CHAT_GATEWAY_COST_ACTION_ID,
			title: localize2('showChatGatewayCost', "Show AI Costs of This Chat"),
			icon: Codicon.creditCard,
			f1: false,
			menu: [
				// Rendered by the view item registered below.
				{ id: MenuId.ChatViewSessionTitleToolbar, group: 'navigation', order: 0 },
				// Rendered by the chat editor, see `ChatEditor.getActionViewItem`.
				{ id: MenuId.EditorTitle, group: 'navigation', order: 0, when: ActiveEditorContext.isEqualTo(ChatEditorInput.EditorID) },
			],
		});
	}

	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const isSessionsWindow = accessor.get(IWorkbenchEnvironmentService).isSessionsWindow;
		const contextResource = (context as { sessionResource?: unknown } | undefined)?.sessionResource;
		const sessionResource = URI.isUri(contextResource) ? contextResource : accessor.get(IChatWidgetService).lastFocusedWidget?.viewModel?.sessionResource;
		await commandService.executeCommand(SHOW_AI_COSTS_COMMAND_ID, sessionResource ? { chatId: getChatCostId(sessionResource) } : undefined);
		if (isSessionsWindow) {
			await commandService.executeCommand(MAXIMIZE_MAIN_EDITOR_PART_COMMAND_ID);
		}
	}
});

/**
 * "Chat: Show AI Costs" in the Command Palette of both windows (the command of the Copilot extension
 * itself stays out of it): opens the AI Costs page, and in the Agents window maximizes it over the chat.
 */
registerAction2(class ShowAiCostsAction extends Action2 {
	constructor() {
		super({
			id: SHOW_AI_COSTS_ACTION_ID,
			title: localize2('showAiCosts', "Show AI Costs"),
			category: CHAT_CATEGORY,
			icon: Codicon.creditCard,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const commandService = accessor.get(ICommandService);
		const isSessionsWindow = accessor.get(IWorkbenchEnvironmentService).isSessionsWindow;
		await commandService.executeCommand(SHOW_AI_COSTS_COMMAND_ID);
		if (isSessionsWindow) {
			await commandService.executeCommand(MAXIMIZE_MAIN_EDITOR_PART_COMMAND_ID);
		}
	}
});

/** Renders the counter in the title of the chat view. */
class ChatGatewayCostViewItemContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.chatGatewayCostViewItem';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(actionViewItemService.register(MenuId.ChatViewSessionTitleToolbar, SHOW_CHAT_GATEWAY_COST_ACTION_ID, (action, options) => {
			return action instanceof MenuItemAction ? instantiationService.createInstance(ChatGatewayCostActionViewItem, action, options, undefined) : undefined;
		}));
	}
}

registerWorkbenchContribution2(ChatGatewayCostViewItemContribution.ID, ChatGatewayCostViewItemContribution, WorkbenchPhase.BlockStartup);
