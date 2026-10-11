/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: restores the history before a compaction on replay.
//
// The Claude CLI writes a compaction (`/compact`, typed or sent by the compact before the prompt
// cache expires contribution) into the transcript as a `compact_boundary` system record whose
// `parentUuid` is `null` and whose `logicalParentUuid` points at the last record before it, followed
// by the summary as a `user` record with `isCompactSummary: true`. The SDK's `getSessionMessages`
// walks `parentUuid` from the leaf, so it stops at the last boundary: the turns before it are not
// returned, and the boundary itself comes back without its `subtype` (the SDK only copies
// `message`, which a system record does not have). {@link expandCompactedHistory} puts the earlier
// turns back in front, from the raw transcript, and gives every system record its `subtype`, so the
// replay mapper shows the old turns, then the compaction notice.

import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/** The fields of a raw transcript record (`<sessionId>.jsonl` line) used here. */
interface IClaudeTranscriptRecord {
	readonly type?: unknown;
	readonly subtype?: unknown;
	readonly uuid?: unknown;
	readonly parentUuid?: unknown;
	readonly logicalParentUuid?: unknown;
	readonly sessionId?: unknown;
	readonly timestamp?: unknown;
	readonly message?: unknown;
	readonly content?: unknown;
	readonly attachment?: unknown;
	readonly isMeta?: unknown;
	readonly isSidechain?: unknown;
	readonly teamName?: unknown;
	readonly isCompactSummary?: unknown;
	readonly isVisibleInTranscriptOnly?: unknown;
}

/** A replay message with the transcript flags the replay mapper reads besides {@link SessionMessage}. */
type ReplaySessionMessage = SessionMessage & { readonly timestamp?: string; readonly isCompactSummary?: boolean; readonly is_meta?: boolean };

/** Stops a malformed transcript (a `parentUuid` cycle, a boundary pointing forward) from looping. */
const MAX_COMPACTIONS = 1000;

/** Parses the lines of a `<sessionId>.jsonl` transcript, skipping lines that are not JSON objects. */
export function parseClaudeTranscript(text: string): IClaudeTranscriptRecord[] {
	const records: IClaudeTranscriptRecord[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const record: unknown = JSON.parse(line);
			if (record !== null && typeof record === 'object' && !Array.isArray(record)) {
				records.push(record as IClaudeTranscriptRecord);
			}
		} catch {
			// A partly written last line.
		}
	}
	return records;
}

/**
 * True when the SDK's messages of a chat start at a compaction, so {@link expandCompactedHistory}
 * has earlier turns to restore. The SDK's chain always starts at the last boundary (its
 * `parentUuid` is `null`), as a `system` message.
 */
export function startsAtCompaction(messages: readonly SessionMessage[]): boolean {
	return messages[0]?.type === 'system';
}

/**
 * Returns {@link messages} (the SDK's `getSessionMessages` result) with the turns before each
 * compaction put back in front, read from the raw transcript {@link records}, and with the
 * `subtype` of every system record set on its `message` (`{ subtype, text }`).
 */
export function expandCompactedHistory(messages: readonly SessionMessage[], records: readonly IClaudeTranscriptRecord[]): SessionMessage[] {
	const byUuid = new Map<string, IClaudeTranscriptRecord>();
	for (const record of records) {
		if (typeof record.uuid === 'string') {
			byUuid.set(record.uuid, record);
		}
	}
	let result = messages.map(message => withSystemSubtype(message, byUuid.get(message.uuid)));
	// The records restored so far, so a malformed transcript (a cycle) cannot loop. Not the SDK's
	// messages: the SDK also returns the last message before a boundary (the record its
	// `logicalParentUuid` points at) after the summary, and that must not stop the walk.
	const walked = new Set<string>();
	let first = messages[0] ? byUuid.get(messages[0].uuid) : undefined;
	for (let i = 0; i < MAX_COMPACTIONS && first && isCompactBoundary(first) && typeof first.logicalParentUuid === 'string'; i++) {
		const chain = walkChain(first.logicalParentUuid, byUuid, walked);
		if (chain.length === 0) {
			break;
		}
		// Restored in their place before the boundary, so drop the SDK's copies after it.
		const restored = new Set(chain.map(record => record.uuid));
		result = [
			...chain.map(toSessionMessage).filter((message): message is ReplaySessionMessage => message !== undefined),
			...result.filter(message => !restored.has(message.uuid)),
		];
		first = chain[0];
	}
	return result;
}

function isCompactBoundary(record: IClaudeTranscriptRecord): boolean {
	return record.type === 'system' && record.subtype === 'compact_boundary';
}

/** The records from the root of the chain ending at {@link leafUuid}, oldest first. */
function walkChain(leafUuid: string, byUuid: ReadonlyMap<string, IClaudeTranscriptRecord>, seen: Set<string>): IClaudeTranscriptRecord[] {
	const chain: IClaudeTranscriptRecord[] = [];
	let uuid: unknown = leafUuid;
	while (typeof uuid === 'string' && !seen.has(uuid)) {
		const record = byUuid.get(uuid);
		if (!record) {
			break;
		}
		seen.add(uuid);
		chain.push(record);
		uuid = record.parentUuid;
	}
	return chain.reverse();
}

function withSystemSubtype(message: SessionMessage, record: IClaudeTranscriptRecord | undefined): SessionMessage {
	if (message.type !== 'system' || !record || typeof record.subtype !== 'string' || hasSubtype(message.message)) {
		return message;
	}
	return { ...message, message: systemMessage(record) };
}

function hasSubtype(message: unknown): boolean {
	return message !== null && typeof message === 'object' && typeof (message as { subtype?: unknown }).subtype === 'string';
}

function systemMessage(record: IClaudeTranscriptRecord): { subtype: unknown; text?: string } {
	return { subtype: record.subtype, ...(typeof record.content === 'string' ? { text: record.content } : {}) };
}

/** Mirrors the SDK's filter and envelope for one raw record (`queued_command` attachments become user messages). */
function toSessionMessage(record: IClaudeTranscriptRecord): ReplaySessionMessage | undefined {
	if (typeof record.uuid !== 'string' || record.isMeta === true || record.isSidechain === true || record.teamName) {
		return undefined;
	}
	let type: SessionMessage['type'];
	let message: unknown;
	if (record.type === 'user' || record.type === 'assistant') {
		type = record.type;
		message = record.message;
	} else if (record.type === 'system') {
		type = 'system';
		message = systemMessage(record);
	} else if (record.type === 'attachment' && isQueuedPrompt(record.attachment)) {
		type = 'user';
		message = { role: 'user', content: record.attachment.prompt };
	} else {
		return undefined;
	}
	return {
		type,
		uuid: record.uuid,
		session_id: typeof record.sessionId === 'string' ? record.sessionId : '',
		message,
		parent_tool_use_id: null,
		parent_agent_id: null,
		...(typeof record.timestamp === 'string' ? { timestamp: record.timestamp } : {}),
		...(record.isCompactSummary === true ? { isCompactSummary: true } : {}),
		...(record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true ? { is_meta: true } : {}),
	};
}

function isQueuedPrompt(attachment: unknown): attachment is { readonly prompt: string | readonly unknown[] } {
	if (attachment === null || typeof attachment !== 'object') {
		return false;
	}
	const a = attachment as { type?: unknown; prompt?: unknown; isMeta?: unknown };
	return a.type === 'queued_command' && a.isMeta !== true && (typeof a.prompt === 'string' || Array.isArray(a.prompt));
}
