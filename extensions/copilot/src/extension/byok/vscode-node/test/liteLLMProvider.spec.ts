/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest';
import { LiteLLMLMProvider, LiteLLMProviderConfig } from '../liteLLMProvider';

describe('LiteLLMLMProvider (CreaEditor)', () => {
	class TestProvider extends LiteLLMLMProvider {
		public listModels(configuration: LiteLLMProviderConfig) {
			return this.getAllModels(true, configuration.apiKey, configuration);
		}
	}

	function createProvider(fetch: ReturnType<typeof vi.fn>, present = vi.fn()): TestProvider {
		const logService = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		return new TestProvider(
			{ getAPIKey: vi.fn().mockResolvedValue(undefined), storeAPIKey: vi.fn(), deleteAPIKey: vi.fn() } as any,
			{ present } as any,
			{ fetch } as any,
			logService as any,
			{ createInstance: vi.fn().mockReturnValue({}) } as any,
			{ isConfigured: vi.fn().mockReturnValue(false), getConfig: vi.fn(), setConfig: vi.fn() } as any,
			{} as any,
		);
	}

	it('discovers the models of the key with capabilities from /model/info', async () => {
		const fetch = vi.fn(async (url: string) => ({
			ok: true,
			status: 200,
			json: async () => url.endsWith('/model/info')
				? { data: [{ model_name: 'claude-sonnet', model_info: { max_input_tokens: 200_000, max_output_tokens: 64_000, supports_function_calling: true, supports_vision: true, supports_reasoning: true } }] }
				: { data: [{ id: 'claude-sonnet' }, { id: 'local-llama' }, { id: 'secret-model' }] },
		}));
		const models = await createProvider(fetch).listModels({
			url: 'http://litellm.tailnet.ts.net:4000/v1/',
			apiKey: 'sk-test',
			hiddenModels: ['secret-model'],
			models: [{ id: 'local-llama', name: 'Llama (local)', toolCalling: false }],
		});
		expect({
			urls: fetch.mock.calls.map(call => call[0]),
			models: models.map(m => ({ id: m.id, name: m.name, url: m.url, input: m.maxInputTokens, output: m.maxOutputTokens, tools: !!m.capabilities?.toolCalling, vision: !!m.capabilities?.imageInput })),
		}).toEqual({
			urls: ['http://litellm.tailnet.ts.net:4000/v1/model/info', 'http://litellm.tailnet.ts.net:4000/v1/models'],
			models: [
				{ id: 'claude-sonnet', name: 'claude-sonnet', url: 'http://litellm.tailnet.ts.net:4000/v1', input: 136_000, output: 64_000, tools: true, vision: true },
				{ id: 'local-llama', name: 'Llama (local)', url: 'http://litellm.tailnet.ts.net:4000/v1', input: 112_000, output: 16_000, tools: false, vision: false },
			],
		});
	});

	it('shows the status of the key and reuses the models when only the status changed', async () => {
		const fetch = vi.fn(async (url: string) => ({
			ok: true,
			status: 200,
			json: async () => url.endsWith('/model/info') ? { data: [] } : { data: [{ id: 'claude-sonnet' }] },
		}));
		const present = vi.fn().mockReturnValueOnce(undefined).mockReturnValue({ detail: '$12.40 left of $50', info: 'Work: $12.40 left of $50' });
		const provider = createProvider(fetch, present);
		const configuration = { url: 'http://localhost:4111', apiKey: 'sk-test' };
		const list = async () => (await provider.provideLanguageModelChatInformation({ silent: true, configuration, group: 'Work' } as any, {} as any))
			.map(m => ({ id: m.id, detail: (m as { providerGroupDetail?: string }).providerGroupDetail, info: m.infoText?.creaeditorKeyStatus }));
		const before = await list();
		let changed = 0;
		provider.onDidChangeLanguageModelChatInformation(() => changed++);
		provider.refreshProviderGroupStatus();
		const after = await list();
		expect({ before, after, changed, modelRequests: fetch.mock.calls.filter(call => call[0].endsWith('/v1/models')).length, present: present.mock.calls[0] }).toEqual({
			before: [{ id: 'claude-sonnet', detail: undefined, info: undefined }],
			after: [{ id: 'claude-sonnet', detail: '$12.40 left of $50', info: 'Work: $12.40 left of $50' }],
			changed: 1,
			modelRequests: 1,
			present: ['litellm', 'Work', 'sk-test', 'http://localhost:4111'],
		});
	});

	it('lists nothing without a proxy URL', async () => {
		const fetch = vi.fn();
		expect(await createProvider(fetch).listModels({ apiKey: 'sk-test' })).toEqual([]);
		expect(fetch).not.toHaveBeenCalled();
	});
});
