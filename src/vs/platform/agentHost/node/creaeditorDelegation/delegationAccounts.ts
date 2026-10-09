/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: opens the accounts of a delegated chat in the agent host of a CreaEditor Server. The
// laptop sends them as an AHP `authenticate` call whose resource is
// `creaeditor-delegation-accounts:<delegationId>` and whose token is the sealed envelope; only this
// process (with the server's private key) can open it. Secrets are never logged.

import { join } from '../../../../base/common/path.js';
import { CREAEDITOR_DELEGATION_ACCOUNTS_RESOURCE_PREFIX, CREAEDITOR_DELEGATION_KEY_PAIR_SECRET_NAME, IDelegationAccountsPayload, IDelegationEnvelope } from '../../common/creaeditorDelegation.js';
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
	return { claudeTokens, ...(payload.gatewayKey && typeof payload.gatewayKey.key === 'string' ? { gatewayKey: payload.gatewayKey } : {}) };
}
