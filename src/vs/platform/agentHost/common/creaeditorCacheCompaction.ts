/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: compact idle Claude chats shortly before their prompt cache expires. Anthropic keeps a
// chat's context cached for 5 minutes (or 1 hour with 1h caching) after each request; a message sent
// later writes the whole context again at full price. Compacting just before the cache expires reads
// the context from the cache (cheap) and the next message starts from the small summary.
//
// - The Claude mapper (`node/claude/claudeMapSessionEvents.ts`) puts the context size of a turn's last
//   request and the cache lifetime on the turn's usage, under {@link PROMPT_CACHE_USAGE_META_KEY}.
// - The agent host's `compactBeforeCacheExpires` chat contribution schedules the compaction when a
//   turn ends and runs it as a `/compact` turn marked with {@link AUTO_COMPACT_MESSAGE_META_KEY}, which
//   notifications and unread state skip.
// - The settings below are mirrored into every connected agent host's root config (same key as the
//   setting id), so a CreaEditor Server follows the laptop's settings.
// - The Claude mappers (live and replay) mark the "conversation compacted" notification with the id
//   of its `compact_boundary` record ({@link COMPACT_BOUNDARY_PART_META_KEY}). The contribution keeps
//   the ids of the automatic compactions in the chat's database
//   ({@link AUTO_COMPACT_BOUNDARIES_METADATA_KEY}), so a reloaded chat still says why it was compacted.

import { localize } from '../../../nls.js';
import { ResponsePartKind, type ChatState, type Message, type ResponsePart, type Turn, type UsageInfo } from './state/sessionState.js';

/** Root config keys (and setting ids). */
export const enum CompactBeforeCacheExpiresRootKey {
	Enabled = 'creaeditor.claude.compactBeforeCacheExpires',
	MinTokens = 'creaeditor.claude.compactBeforeCacheExpiresMinTokens',
}

/** The default of {@link CompactBeforeCacheExpiresRootKey.MinTokens}. */
export const COMPACT_BEFORE_CACHE_EXPIRES_DEFAULT_MIN_TOKENS = 60_000;

/** The effective settings of an agent host. */
export interface ICompactBeforeCacheExpiresConfig {
	readonly enabled: boolean;
	readonly minTokens: number;
}

/** Reads the settings from an agent host's root config values; missing values take the defaults. */
export function readCompactBeforeCacheExpiresConfig(values: Readonly<Record<string, unknown>> | undefined): ICompactBeforeCacheExpiresConfig {
	const minTokens = values?.[CompactBeforeCacheExpiresRootKey.MinTokens];
	return {
		enabled: values?.[CompactBeforeCacheExpiresRootKey.Enabled] !== false,
		minTokens: typeof minTokens === 'number' && Number.isFinite(minTokens) && minTokens >= 0 ? minTokens : COMPACT_BEFORE_CACHE_EXPIRES_DEFAULT_MIN_TOKENS,
	};
}

/** Key in {@link UsageInfo._meta} of {@link IPromptCacheUsage}. */
export const PROMPT_CACHE_USAGE_META_KEY = 'creaeditor.promptCache';

/** What the prompt cache holds after a turn. */
export interface IPromptCacheUsage {
	/** Input + cache read + cache creation tokens of the turn's last request: the context the next one re-reads. */
	readonly contextTokens: number;
	/** How long the cache lives after the last request: 5 minutes, or 1 hour with 1h caching. */
	readonly ttlSeconds: 300 | 3600;
}

/** Reads {@link IPromptCacheUsage} from a turn's usage. */
export function readPromptCacheUsage(usage: UsageInfo | undefined): IPromptCacheUsage | undefined {
	const value = usage?._meta?.[PROMPT_CACHE_USAGE_META_KEY] as Partial<IPromptCacheUsage> | undefined;
	if (!value || typeof value !== 'object' || typeof value.contextTokens !== 'number' || !Number.isFinite(value.contextTokens)) {
		return undefined;
	}
	return { contextTokens: value.contextTokens, ttlSeconds: value.ttlSeconds === 3600 ? 3600 : 300 };
}

/**
 * How long after a turn ends the chat is compacted: the cache lifetime minus a margin (45 seconds of
 * 5 minutes, 3 minutes of an hour) so the compaction request still reads from the cache.
 */
export function getCompactDelayMs(ttlSeconds: 300 | 3600): number {
	return ttlSeconds === 3600 ? (3600 - 180) * 1000 : (300 - 45) * 1000;
}

/** Key in {@link Message._meta} that marks the automatic `/compact` turn. */
export const AUTO_COMPACT_MESSAGE_META_KEY = 'creaeditor.autoCompact';

/** The text the automatic compaction sends: the Claude CLI's own `/compact` command. */
export const COMPACT_COMMAND_TEXT = '/compact';

/** Whether `message` started an automatic compaction. */
export function isAutoCompactMessage(message: Message | undefined): boolean {
	return message?._meta?.[AUTO_COMPACT_MESSAGE_META_KEY] === true;
}

/** Whether `message` compacts the chat: the automatic compaction or a `/compact` the user sent. */
export function isCompactMessage(message: Message | undefined): boolean {
	if (!message) {
		return false;
	}
	const text = message.text.trim();
	return isAutoCompactMessage(message) || text === COMPACT_COMMAND_TEXT || text.startsWith(`${COMPACT_COMMAND_TEXT} `);
}

/** Whether the turn `turnId` of `chat` (running or ended) is an automatic compaction. */
export function isAutoCompactTurn(chat: ChatState | undefined, turnId: string | undefined): boolean {
	if (!chat || turnId === undefined) {
		return false;
	}
	if (chat.activeTurn?.id === turnId) {
		return isAutoCompactMessage(chat.activeTurn.message);
	}
	for (let i = chat.turns.length - 1; i >= 0; i--) {
		if (chat.turns[i].id === turnId) {
			return isAutoCompactMessage(chat.turns[i].message);
		}
	}
	return false;
}

/** Key in a compaction notification's `_meta`: the id (`uuid`) of the transcript's `compact_boundary` record. */
export const COMPACT_BOUNDARY_PART_META_KEY = 'creaeditor.compactBoundary';

/** Chat database metadata key: a JSON array of the `compact_boundary` ids of the automatic compactions. */
export const AUTO_COMPACT_BOUNDARIES_METADATA_KEY = 'creaeditor.autoCompactBoundaries';

/** The notification of a compaction: a `/compact` the user sent, or the Claude CLI's own when the context is full. */
export function getCompactNotice(): string {
	return localize('creaeditor.compactNotice', "Conversation compacted: older messages were summarized.");
}

/** The notification of an automatic compaction before the prompt cache expires, live and after a reload. */
export function getAutoCompactNotice(): string {
	return localize('creaeditor.autoCompactNotice', "Compacted to save cost: the prompt cache was about to expire, so the conversation was summarized while reading it was still cheap.");
}

/** The compaction notification part for the `compact_boundary` record `boundaryId`. */
export function createCompactNoticePart(boundaryId: string | undefined): ResponsePart {
	return {
		kind: ResponsePartKind.SystemNotification,
		content: getCompactNotice(),
		...(boundaryId ? { _meta: { [COMPACT_BOUNDARY_PART_META_KEY]: boundaryId } } : {}),
	};
}

/** The `compact_boundary` id of a compaction notification part. */
export function readCompactBoundaryId(part: ResponsePart): string | undefined {
	if (part.kind !== ResponsePartKind.SystemNotification) {
		return undefined;
	}
	const id = part._meta?.[COMPACT_BOUNDARY_PART_META_KEY];
	return typeof id === 'string' && id ? id : undefined;
}

/** Parses {@link AUTO_COMPACT_BOUNDARIES_METADATA_KEY}; anything malformed reads as none. */
export function parseAutoCompactBoundaries(raw: string | undefined): string[] {
	if (!raw) {
		return [];
	}
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

/** Gives the notifications of the automatic compactions {@link boundaryIds} their own text. */
export function applyAutoCompactNotices(turns: readonly Turn[], boundaryIds: ReadonlySet<string>): readonly Turn[] {
	if (boundaryIds.size === 0) {
		return turns;
	}
	return turns.map(turn => {
		if (!turn.responseParts.some(part => isAutoCompactNoticePart(part, boundaryIds))) {
			return turn;
		}
		return {
			...turn,
			responseParts: turn.responseParts.map(part => isAutoCompactNoticePart(part, boundaryIds) ? { ...part, content: getAutoCompactNotice() } : part),
		};
	});
}

function isAutoCompactNoticePart(part: ResponsePart, boundaryIds: ReadonlySet<string>): boolean {
	const id = readCompactBoundaryId(part);
	return id !== undefined && boundaryIds.has(id);
}
