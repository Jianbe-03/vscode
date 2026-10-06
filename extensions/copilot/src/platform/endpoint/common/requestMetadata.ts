/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extra metadata a user attaches to BYOK requests: HTTP headers and JSON body fields
 * (e.g. OpenRouter's `user`, `session_id`, `metadata`, `provider` routing, `X-Title`).
 *
 * String values may contain `${variable}` placeholders, see {@link expandRequestMetadataVariables}.
 */
export interface IRequestMetadata {
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: Readonly<Record<string, unknown>>;
}

/**
 * Shape of the `requestMetadata` property on a provider group in `chatLanguageModels.json`.
 * Group-level values apply to every model of the group (i.e. of that API key); `models`
 * holds per-model overrides keyed by model id.
 */
export interface IRequestMetadataConfiguration extends IRequestMetadata {
	readonly models?: Readonly<Record<string, IRequestMetadata>>;
}

/**
 * Body fields that make up the actual prompt/tool payload. Metadata must never replace them.
 */
const PROTECTED_BODY_KEYS = new Set(['messages', 'input', 'tools', 'model', 'stream', 'system', 'contents']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep merges `source` into a copy of `target`. Objects merge recursively; any other value
 * (including arrays) replaces. A `null` value in `source` removes the key.
 */
export function deepMergeRecords(target: Readonly<Record<string, unknown>> | undefined, source: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
	const result: Record<string, unknown> = { ...target };
	if (!source) {
		return result;
	}
	for (const [key, value] of Object.entries(source)) {
		if (value === null) {
			delete result[key];
		} else if (isPlainObject(value) && isPlainObject(result[key])) {
			result[key] = deepMergeRecords(result[key] as Record<string, unknown>, value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function mergeMetadata(base: IRequestMetadata | undefined, override: IRequestMetadata | undefined): IRequestMetadata | undefined {
	if (!base) {
		return override;
	}
	if (!override) {
		return base;
	}
	return {
		headers: { ...base.headers, ...override.headers },
		body: deepMergeRecords(base.body, override.body),
	};
}

function sanitizeMetadata(value: unknown): IRequestMetadata | undefined {
	if (!isPlainObject(value)) {
		return undefined;
	}
	const headers: Record<string, string> = {};
	if (isPlainObject(value.headers)) {
		for (const [key, headerValue] of Object.entries(value.headers)) {
			if (typeof headerValue === 'string' || typeof headerValue === 'number' || typeof headerValue === 'boolean') {
				headers[key] = String(headerValue);
			}
		}
	}
	const body = isPlainObject(value.body) ? value.body : undefined;
	if (!Object.keys(headers).length && !body) {
		return undefined;
	}
	return { headers, body };
}

/**
 * Resolves the metadata for one model from a provider group configuration.
 *
 * Precedence (later wins): group `requestMetadata` → group `requestMetadata.models[modelId]`
 * → `requestMetadata` on the model's own entry in the group's `models` array (Custom Endpoint,
 * OpenRouter presets, Azure).
 */
export function resolveRequestMetadata(groupConfiguration: unknown, modelId: string): IRequestMetadata | undefined {
	if (!isPlainObject(groupConfiguration)) {
		return undefined;
	}
	const groupMetadata = isPlainObject(groupConfiguration.requestMetadata) ? groupConfiguration.requestMetadata : undefined;
	let result = sanitizeMetadata(groupMetadata);
	if (groupMetadata && isPlainObject(groupMetadata.models)) {
		result = mergeMetadata(result, sanitizeMetadata(groupMetadata.models[modelId]));
	}
	if (Array.isArray(groupConfiguration.models)) {
		const entry = groupConfiguration.models.find(m => isPlainObject(m) && m.id === modelId);
		if (isPlainObject(entry)) {
			result = mergeMetadata(result, sanitizeMetadata(entry.requestMetadata));
		}
	}
	return result;
}

const VARIABLE_PATTERN = /\$\{([A-Za-z][\w.:-]*)\}/g;

/**
 * Replaces `${name}` placeholders in every string of `value`. Unknown variables are left
 * untouched so a later expansion pass (e.g. per-request variables) can fill them in.
 * `${env:NAME}` reads an environment variable when `env` is given.
 */
export function expandRequestMetadataVariables<T>(value: T, variables: Readonly<Record<string, string | undefined>>, env?: Readonly<Record<string, string | undefined>>): T {
	if (typeof value === 'string') {
		return value.replace(VARIABLE_PATTERN, (match, name: string) => {
			if (name.startsWith('env:')) {
				return env?.[name.slice(4)] ?? (env ? '' : match);
			}
			const replacement = variables[name];
			return replacement !== undefined ? replacement : match;
		}) as T;
	}
	if (Array.isArray(value)) {
		return value.map(v => expandRequestMetadataVariables(v, variables, env)) as T;
	}
	if (isPlainObject(value)) {
		const result: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value)) {
			result[key] = expandRequestMetadataVariables(v, variables, env);
		}
		return result as T;
	}
	return value;
}

export function expandRequestMetadata(metadata: IRequestMetadata, variables: Readonly<Record<string, string | undefined>>, env?: Readonly<Record<string, string | undefined>>): IRequestMetadata {
	return {
		headers: metadata.headers && expandRequestMetadataVariables(metadata.headers, variables, env),
		body: metadata.body && expandRequestMetadataVariables(metadata.body, variables, env),
	};
}

/**
 * Merges metadata body fields into a request body, leaving the prompt payload untouched.
 */
export function applyRequestMetadataToBody<T extends object>(body: T, metadataBody: Readonly<Record<string, unknown>> | undefined): T {
	if (!metadataBody) {
		return body;
	}
	const allowed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadataBody)) {
		if (!PROTECTED_BODY_KEYS.has(key)) {
			allowed[key] = value;
		}
	}
	const merged = deepMergeRecords(body as Record<string, unknown>, allowed);
	for (const key of Object.keys(body)) {
		if (!(key in merged)) {
			delete (body as Record<string, unknown>)[key];
		}
	}
	return Object.assign(body, merged);
}
