/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CreaEditor: the Codex (ChatGPT subscription) accounts pooled behind the one Codex model picker entry.
// The Codex agent runs one app-server at a time; this pool knows which account it runs on, the status
// and usage of every account, and which account takes over when one is used up.

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { equals } from '../../../../base/common/objects.js';
import { localize } from '../../../../nls.js';
import type { ISubscriptionAccount, ISubscriptionLimitErrorMeta, ISubscriptionUsageWindow, SubscriptionAccountStatus } from '../../common/meta/subscriptionAccounts.js';
import type { IStoredSubscriptionAccount } from '../shared/subscriptionAccountsService.js';
import { codexLimitedUntil, codexLimitErrorMeta, isCodexAccountAvailable, selectCodexAccount } from './codexSubscriptionAccounts.js';

/** The account in the CODEX_HOME the Codex CLI uses by itself. */
export const CODEX_DEFAULT_ACCOUNT_ID = 'codex-default';

/** What the agent learned about an account; everything the user did not name. */
export interface ICodexAccountRuntime {
	readonly status?: SubscriptionAccountStatus;
	readonly email?: string;
	readonly planType?: string;
	readonly usage?: readonly ISubscriptionUsageWindow[];
	readonly usageUpdatedAt?: number;
	readonly limitedUntil?: number;
	readonly error?: string;
	readonly authUrl?: string;
}

/** What to do with a chat whose account just hit its limit. */
export type CodexLimitDecision =
	| { readonly kind: 'switch'; readonly account: ISubscriptionAccount; readonly next: ISubscriptionAccount }
	| { readonly kind: 'ask'; readonly account: ISubscriptionAccount; readonly meta: ISubscriptionLimitErrorMeta };

export class CodexAccountPool extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _stored: readonly IStoredSubscriptionAccount[] = [];
	private readonly _runtime = new Map<string, ICodexAccountRuntime>();
	private _activeAccountId = CODEX_DEFAULT_ACCOUNT_ID;

	/** The account the Codex app-server runs (or will next run) on. */
	get activeAccountId(): string {
		return this._activeAccountId;
	}

	/** Whether the user added accounts besides the default one. */
	get hasAddedAccounts(): boolean {
		return this._stored.length > 0;
	}

	setActiveAccount(accountId: string): void {
		this._activeAccountId = accountId;
	}

	/** The user-added accounts, in order. Only `login` accounts belong to Codex. */
	getStoredAccounts(): readonly IStoredSubscriptionAccount[] {
		return this._stored;
	}

	setStoredAccounts(stored: readonly IStoredSubscriptionAccount[]): void {
		const accounts = stored.filter(account => account.kind === 'login' && account.id !== CODEX_DEFAULT_ACCOUNT_ID);
		if (equals(accounts, this._stored)) {
			return;
		}
		this._stored = accounts;
		for (const id of [...this._runtime.keys()]) {
			if (id !== CODEX_DEFAULT_ACCOUNT_ID && !accounts.some(account => account.id === id)) {
				this._runtime.delete(id);
			}
		}
		this._onDidChange.fire();
	}

	getRuntime(accountId: string): ICodexAccountRuntime {
		return this._runtime.get(accountId) ?? {};
	}

	/** Replaces what is known about `accountId` by `runtime` merged over the current value. */
	update(accountId: string, runtime: ICodexAccountRuntime): void {
		const previous = this._runtime.get(accountId) ?? {};
		const next: ICodexAccountRuntime = { ...previous, ...runtime };
		if (equals(previous, next)) {
			return;
		}
		this._runtime.set(accountId, next);
		this._onDidChange.fire();
	}

	/**
	 * Records a usage reading. A full window makes the account used up until it resets; a reading
	 * without one only ends an earlier limit once that limit is over.
	 */
	applyUsage(accountId: string, usage: readonly ISubscriptionUsageWindow[], now: number, readAt = now): void {
		const previous = this.getRuntime(accountId);
		const full = usage.some(window => window.usedPercent >= 100);
		const limitedUntil = full ? codexLimitedUntil(usage, now) : previous.limitedUntil !== undefined && previous.limitedUntil > now ? previous.limitedUntil : undefined;
		this.update(accountId, { usage, usageUpdatedAt: readAt, limitedUntil, status: limitedUntil !== undefined ? 'limited' : 'signedIn', error: undefined, authUrl: undefined });
	}

	/** Marks the account used up after Codex refused a turn. */
	markLimited(accountId: string, now: number): void {
		this.update(accountId, { status: 'limited', limitedUntil: codexLimitedUntil(this.getRuntime(accountId).usage, now) });
	}

	/** The accounts in the order they are tried: the default one first, when it is a ChatGPT login. */
	getAccounts(now: number): ISubscriptionAccount[] {
		const accounts: ISubscriptionAccount[] = [];
		const defaultRuntime = this._runtime.get(CODEX_DEFAULT_ACCOUNT_ID);
		if (defaultRuntime?.status) {
			accounts.push(this._toAccount(CODEX_DEFAULT_ACCOUNT_ID, localize('codexAccounts.defaultLabel', "Codex Default"), 'default', defaultRuntime, now));
		}
		for (const stored of this._stored) {
			accounts.push(this._toAccount(stored.id, stored.label, 'login', this._runtime.get(stored.id) ?? {}, now));
		}
		return accounts;
	}

	/**
	 * The account new work starts on: the active account while it can take work, otherwise the first
	 * account in order that can, otherwise the active account so the user sees why it fails.
	 */
	pickAccountForNewWork(now: number): string {
		const accounts = this.getAccounts(now);
		const active = accounts.find(account => account.id === this._activeAccountId);
		if (active && isCodexAccountAvailable(active, now)) {
			return active.id;
		}
		if (!active && this._activeAccountId === CODEX_DEFAULT_ACCOUNT_ID && !accounts.some(account => account.kind === 'login' && isCodexAccountAvailable(account, now))) {
			// The default home without a ChatGPT login (an API key, another provider): leave it alone.
			return this._activeAccountId;
		}
		return selectCodexAccount(accounts, now)?.id ?? this._activeAccountId;
	}

	/** After `accountId` hit its limit: move on to the next account, or ask the user first. */
	decideOnLimit(accountId: string, autoSwitch: boolean, now: number): CodexLimitDecision | undefined {
		const accounts = this.getAccounts(now);
		const account = accounts.find(candidate => candidate.id === accountId);
		if (!account) {
			return undefined;
		}
		const next = selectCodexAccount(accounts, now, accountId);
		if (autoSwitch && next) {
			return { kind: 'switch', account, next };
		}
		return { kind: 'ask', account, meta: codexLimitErrorMeta(account, next) };
	}

	private _toAccount(id: string, label: string, kind: ISubscriptionAccount['kind'], runtime: ICodexAccountRuntime, now: number): ISubscriptionAccount {
		const limited = runtime.limitedUntil !== undefined && runtime.limitedUntil > now;
		let status: SubscriptionAccountStatus = runtime.status ?? 'signedOut';
		if (limited && (status === 'signedIn' || status === 'limited')) {
			status = 'limited';
		} else if (status === 'limited') {
			status = 'signedIn';
		}
		return {
			id,
			provider: 'codex',
			label,
			kind,
			status,
			...(runtime.email ? { email: runtime.email } : {}),
			...(runtime.planType ? { planType: runtime.planType } : {}),
			...(runtime.usage ? { usage: runtime.usage } : {}),
			...(runtime.usageUpdatedAt !== undefined ? { usageUpdatedAt: runtime.usageUpdatedAt } : {}),
			...(limited ? { limitedUntil: runtime.limitedUntil } : {}),
			// A signed-in account keeps its note too, such as why its usage could not be read.
			...(runtime.error ? { error: runtime.error } : {}),
			...(runtime.authUrl && status === 'signingIn' ? { authUrl: runtime.authUrl } : {}),
		};
	}
}
