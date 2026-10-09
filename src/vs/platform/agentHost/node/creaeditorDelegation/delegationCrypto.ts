/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: encrypts the accounts a delegated chat needs (Claude setup-tokens, gateway keys) for one
// CreaEditor Server, on top of the encrypted connection (WireGuard or HTTPS). The server keeps an
// X25519 key pair in its secret store and publishes the public key to paired devices. The laptop
// encrypts with a fresh X25519 key (ECIES): HKDF-SHA256 over the shared secret, AES-256-GCM, with the
// delegation id as additional data, so a payload cannot be replayed into another delegated chat. Only
// the server's private key opens it; proxies and logs only ever see ciphertext.

import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, KeyObject, randomBytes } from 'crypto';
import { IDelegationEnvelope } from '../../common/creaeditorDelegation.js';

const HKDF_INFO = 'creaeditor-delegation-accounts v1';
const IV_LENGTH = 12;

/** A server key pair, both halves as base64 DER (SPKI / PKCS#8). */
export interface IDelegationKeyPair {
	readonly publicKey: string;
	readonly privateKey: string;
}

export function generateDelegationKeyPair(): IDelegationKeyPair {
	const { publicKey, privateKey } = generateKeyPairSync('x25519');
	return {
		publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
		privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
	};
}

function importPublicKey(base64: string): KeyObject {
	const key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' });
	if (key.asymmetricKeyType !== 'x25519') {
		throw new Error('The server key is not an X25519 key.');
	}
	return key;
}

function deriveKey(shared: Buffer, ephemeralPublicKey: string, recipientPublicKey: string): Buffer {
	const salt = Buffer.concat([Buffer.from(ephemeralPublicKey, 'base64'), Buffer.from(recipientPublicKey, 'base64')]);
	return Buffer.from(hkdfSync('sha256', shared, salt, HKDF_INFO, 32));
}

/** Encrypts `plaintext` for the holder of `recipientPublicKey`, bound to `context` (the delegation id). */
export function sealDelegationPayload(plaintext: string, recipientPublicKey: string, context: string): IDelegationEnvelope {
	const recipient = importPublicKey(recipientPublicKey);
	const ephemeral = generateKeyPairSync('x25519');
	const ephemeralPublicKey = ephemeral.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	const key = deriveKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), ephemeralPublicKey, recipientPublicKey);
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(context, 'utf8'));
	const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return { version: 1, ephemeralPublicKey, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

/** Opens an envelope with the server's key pair; throws when it was not made for this key and `context`. */
export function openDelegationPayload(envelope: IDelegationEnvelope, keyPair: IDelegationKeyPair, context: string): string {
	if (envelope?.version !== 1 || typeof envelope.ephemeralPublicKey !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') {
		throw new Error('Not an encrypted delegation payload.');
	}
	const privateKey = createPrivateKey({ key: Buffer.from(keyPair.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
	const shared = diffieHellman({ privateKey, publicKey: importPublicKey(envelope.ephemeralPublicKey) });
	const key = deriveKey(shared, envelope.ephemeralPublicKey, keyPair.publicKey);
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
	decipher.setAAD(Buffer.from(context, 'utf8'));
	decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
	try {
		return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8');
	} catch {
		throw new Error('The accounts payload cannot be decrypted with this server\'s key.');
	}
}
