/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GatewayKind, gatewayKindFromUrl, LITELLM_PROBE_PATHS, normalizeGatewayRoot } from '../../../platform/endpoint/common/gatewayTracking';
import { IFetcherService } from '../../../platform/networking/common/fetcherService';
import { raceTimeout } from '../../../util/vs/base/common/async';

const PROBE_TIMEOUT_MS = 4000;
const detected = new Map<string, Promise<GatewayKind | undefined>>();

/**
 * CreaEditor: detects whether a base URL is an OpenRouter or LiteLLM gateway. OpenRouter is known by its
 * host; a LiteLLM proxy (which can run on any host, e.g. behind Tailscale) answers its health endpoints.
 * Results are cached per gateway root for the session.
 */
export function detectGatewayKind(url: string, fetcherService: IFetcherService): Promise<GatewayKind | undefined> {
	const known = gatewayKindFromUrl(url);
	if (known) {
		return Promise.resolve(known);
	}
	let root: string;
	try {
		root = normalizeGatewayRoot(new URL(url).toString());
	} catch {
		return Promise.resolve(undefined);
	}
	let result = detected.get(root);
	if (!result) {
		result = probeLiteLLM(root, fetcherService);
		detected.set(root, result);
		// Let a failed probe (e.g. Tailscale not connected yet) be retried later.
		void result.then(kind => {
			if (!kind) {
				setTimeout(() => detected.delete(root), 60_000);
			}
		});
	}
	return result;
}

async function probeLiteLLM(root: string, fetcherService: IFetcherService): Promise<GatewayKind | undefined> {
	for (const path of LITELLM_PROBE_PATHS) {
		try {
			const response = await raceTimeout(fetcherService.fetch(`${root}${path}`, { method: 'GET', callSite: 'creaeditor-gateway-detection' }), PROBE_TIMEOUT_MS);
			if (!response?.ok) {
				continue;
			}
			const text = (await response.text()).toLowerCase();
			if (text.includes('alive') || text.includes('litellm') || text.includes('"status"')) {
				return 'litellm';
			}
		} catch {
			// Not reachable or not a LiteLLM proxy.
		}
	}
	return undefined;
}
