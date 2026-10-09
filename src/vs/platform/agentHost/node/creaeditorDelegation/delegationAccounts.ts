/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: opens the accounts of a delegated chat in the agent host of a CreaEditor Server. The
// laptop sends them as an AHP `authenticate` call whose resource is
// `creaeditor-delegation-accounts:<delegationId>` and whose token is the sealed envelope; only this
// process (with the server's private key) can open it. Secrets are never logged.

import { join } from '../../../../base/common/path.js';
import { CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX, CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME, IDelegationAccountsPayload, IDelegationEnvelope, IDelegationGatewayKey, IDelegationGatewayModel, IDelegationWorkContext } from '../../common/creaeditorDelegation.js';
import { AGENT_HOST_SECRETS_DIR_ENV_VAR, FileSecretStore } from '../shared/fileSecretStore.js';
import { IDelegationKeyPair, openDelegationPayload } from './delegationCrypto.js';

/**
 * The secret store of the server's code receiver: its own folder (and master key) next to the agent
 * host's store, so the two processes never write the same file.
 */
export function getDelegationSecretsDir(secretsDir: string): string {
	return join(secretsDir, 'delegation');
}

/** The delegation id of an accounts resource, or undefined for other resources. */
export function parseDelegationAccountsResource(resource: string): string | undefined {
	if (!resource.startsWith(CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX)) {
		return undefined;
	}
	const id = resource.slice(CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX.length);
	return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
}

/** Reads the server's key pair (written by the code receiver at startup); undefined outside a server. */
export function readServerDelegationKeyPair(env: NodeJS.ProcessEnv = process.env): IDelegationKeyPair | undefined {
	const secretsDir = env[AGENT_HOST_SECRETS_DIR_ENV_VAR];
	if (!secretsDir) {
		return undefined;
	}
	// A fresh read each time: the code receiver may have created the key pair after this process started.
	const stored = new FileSecretStore(getDelegationSecretsDir(secretsDir)).get(CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME);
	return stored ? JSON.parse(stored) as IDelegationKeyPair : undefined;
}

/** Opens the accounts envelope sent for `delegationId`; throws when it is not for this server. */
export function openDelegationAccounts(delegationId: string, token: string, keyPair: IDelegationKeyPair): IDelegationAccountsPayload {
	const envelope = JSON.parse(token) as IDelegationEnvelope;
	const payload = JSON.parse(openDelegationPayload(envelope, keyPair, delegationId)) as IDelegationAccountsPayload;
	const claudeTokens = Array.isArray(payload.claudeTokens)
		? payload.claudeTokens.filter(entry => entry && typeof entry.accountId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(entry.accountId) && typeof entry.token === 'string' && typeof entry.label === 'string')
		: [];
	const gatewayKey = parseGatewayKey(payload.gatewayKey);
	const workContext = parseWorkContext(payload.workContext);
	return { claudeTokens, ...(gatewayKey ? { gatewayKey } : {}), ...(workContext ? { workContext } : {}) };
}

function optionalString(value: unknown, max: number): string | undefined {
	return typeof value === 'string' && value && value.length <= max ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A gateway key from an opened envelope, or undefined when it is not a usable one. */
function parseGatewayKey(value: IDelegationGatewayKey | undefined): IDelegationGatewayKey | undefined {
	if (!value || typeof value !== 'object' || (value.providerId !== 'openrouter' && value.providerId !== 'litellm')
		|| !optionalString(value.label, 200) || !optionalString(value.key, 4096)) {
		return undefined;
	}
	const baseUrl = optionalString(value.baseUrl, 2048);
	if (value.providerId === 'litellm' && !baseUrl) {
		return undefined;
	}
	const models: IDelegationGatewayModel[] = [];
	for (const model of Array.isArray(value.models) ? value.models : []) {
		const id = optionalString(model?.id, 300);
		if (!id) {
			continue;
		}
		const name = optionalString(model.name, 300);
		const maxInputTokens = optionalNumber(model.maxInputTokens);
		const maxOutputTokens = optionalNumber(model.maxOutputTokens);
		models.push({ id, ...(name ? { name } : {}), ...(maxInputTokens ? { maxInputTokens } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}), ...(model.supportsVision === true ? { supportsVision: true } : {}) });
	}
	return { providerId: value.providerId, label: value.label, key: value.key, models, ...(baseUrl ? { baseUrl } : {}) };
}

function parseWorkContext(value: IDelegationWorkContext | undefined): IDelegationWorkContext | undefined {
	const worktree = optionalString(value?.worktree, 4096);
	if (!value || !worktree) {
		return undefined;
	}
	const title = optionalString(value.title, 512);
	const repo = optionalString(value.repo, 512);
	const branch = optionalString(value.branch, 512);
	return { worktree, ...(title ? { title } : {}), ...(repo ? { repo } : {}), ...(branch ? { branch } : {}) };
}

/**
 * Opens the accounts of an AHP `authenticate` call when it is a delegated chat's (on a CreaEditor
 * Server): undefined for other resources, and when this is not a server or the envelope is not for it.
 */
export function tryOpenServerDelegationAccounts(resource: string, token: string, log?: (message: string) => void): { readonly delegationId: string; readonly payload: IDelegationAccountsPayload } | undefined {
	const delegationId = parseDelegationAccountsResource(resource);
	const keyPair = delegationId !== undefined && token ? readServerDelegationKeyPair() : undefined;
	if (delegationId === undefined || !keyPair) {
		return undefined;
	}
	try {
		return { delegationId, payload: openDelegationAccounts(delegationId, token, keyPair) };
	} catch (error) {
		log?.(`The accounts of delegated chat ${delegationId} cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}
