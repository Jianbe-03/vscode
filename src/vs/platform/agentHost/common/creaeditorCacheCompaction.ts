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

import type { ChatState, Message, UsageInfo } from './state/sessionState.js';

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
