/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { applyRequestMetadataToBody, expandRequestMetadata, resolveRequestMetadata } from '../requestMetadata';

describe('requestMetadata', () => {
	const group = {
		apiKey: 'secret',
		requestMetadata: {
			headers: { 'X-Title': 'CreaEditor', 'X-Team': 'core' },
			body: { user: '${user}', metadata: { team: 'creacoon', env: 'prod' } },
			models: {
				'@preset/programmer-agent': { headers: { 'X-Team': 'agents' }, body: { metadata: { agent: 'programmer' } } },
			},
		},
		models: [
			{ id: '@preset/programmer-agent', requestMetadata: { body: { metadata: { env: null }, session_id: '${sessionId}' } } },
		],
	};

	it('returns undefined without metadata', () => {
		expect(resolveRequestMetadata({ apiKey: 'x' }, 'm')).toBeUndefined();
		expect(resolveRequestMetadata(undefined, 'm')).toBeUndefined();
	});

	it('uses the group metadata for models without overrides', () => {
		expect(resolveRequestMetadata(group, 'openai/gpt-5')).toEqual({
			headers: { 'X-Title': 'CreaEditor', 'X-Team': 'core' },
			body: { user: '${user}', metadata: { team: 'creacoon', env: 'prod' } },
		});
	});

	it('layers group, per-model map and model entry overrides', () => {
		expect(resolveRequestMetadata(group, '@preset/programmer-agent')).toEqual({
			headers: { 'X-Title': 'CreaEditor', 'X-Team': 'agents' },
			body: { user: '${user}', session_id: '${sessionId}', metadata: { team: 'creacoon', agent: 'programmer' } },
		});
	});

	it('expands known variables and keeps unknown ones for a later pass', () => {
		const metadata = resolveRequestMetadata(group, '@preset/programmer-agent')!;
		const first = expandRequestMetadata(metadata, { user: 'jibbe' });
		expect(first.body).toMatchObject({ user: 'jibbe', session_id: '${sessionId}' });
		const second = expandRequestMetadata(first, { sessionId: 'abc' });
		expect(second.body).toMatchObject({ user: 'jibbe', session_id: 'abc' });
	});

	it('expands environment variables', () => {
		expect(expandRequestMetadata({ headers: { a: '${env:FOO}-${env:MISSING}' } }, {}, { FOO: 'bar' }).headers).toEqual({ a: 'bar-' });
	});

	it('never overrides the prompt payload', () => {
		const body = { model: 'x', messages: [{ role: 'user' }], temperature: 0.1, metadata: { a: 1 } };
		applyRequestMetadataToBody(body, { model: 'evil', messages: [], temperature: null, metadata: { b: 2 }, user: 'u' });
		expect(body).toEqual({ model: 'x', messages: [{ role: 'user' }], metadata: { a: 1, b: 2 }, user: 'u' });
	});
});
