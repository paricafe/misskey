/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ACCOUNT_DEVICE_STATE_KEY, IDB_ACCOUNT_STORAGE_MARKER, LOCAL_ACCOUNT_STORAGE_MARKER, readStoredAccounts } from '@@/js/stored-accounts.js';
import { host } from '@@/js/config.js';
import { get, usesAccountFallback } from '@/utility/idb-proxy.js';
import { miLocalStorage } from '@/local-storage.js';
import { store } from '@/store.js';

const fallbackKey = `idbfallback::${ACCOUNT_DEVICE_STATE_KEY}` as const;
type FallbackState = Partial<Pick<typeof store.s, 'accountTokens' | 'accountInfos' | 'accountHost' | 'removedAccountTokens'>> & {
	partialAccountState?: boolean;
};

async function markFallbackAccounts() {
	if (!('caches' in window)) return;
	await window.caches.delete(IDB_ACCOUNT_STORAGE_MARKER).catch(() => {});
	await window.caches.open(LOCAL_ACCOUNT_STORAGE_MARKER).catch(() => {});
}

async function trustIndexedDB() {
	if (!('caches' in window)) return true;
	try {
		await window.caches.delete(LOCAL_ACCOUNT_STORAGE_MARKER);
		await window.caches.open(IDB_ACCOUNT_STORAGE_MARKER);
		return true;
	} catch {
		return false;
	}
}

async function synchronizeAccounts(initializing: boolean) {
	const fallback: FallbackState = miLocalStorage.getItemAsJson(fallbackKey) ?? {};
	if (usesAccountFallback()) {
		if (fallback.partialAccountState == null && !fallback.accountTokens) {
			miLocalStorage.setItemAsJson(fallbackKey, { ...fallback, partialAccountState: true });
		}
		await markFallbackAccounts();
		return;
	}

	if (!fallback.accountTokens && !fallback.removedAccountTokens && fallback.partialAccountState == null) {
		if (!initializing) return;
		const legacyFallback = 'caches' in window && await window.caches.has(LOCAL_ACCOUNT_STORAGE_MARKER).catch(() => false);
		if (!legacyFallback) {
			await trustIndexedDB();
			return;
		}
	}

	const legacyAccounts = await readStoredAccounts(get, host);
	await store.updateDevice(current => {
		const base = current.accountTokens ?? Object.fromEntries(legacyAccounts.map(account => [host + '/' + account.id, account.token]));
		const accountTokens = { ...(fallback.partialAccountState ? base : {}), ...fallback.accountTokens };
		const accountInfos = { ...(fallback.partialAccountState ? current.accountInfos : {}), ...fallback.accountInfos };
		if (fallback.partialAccountState == null && current.accountTokens != null) {
			// Older snapshots have no edit history. Retain only corroborated credentials.
			const active = miLocalStorage.getItemAsJson('account');
			for (const [key, token] of Object.entries(accountTokens)) {
				if (base[key] === token || (key === host + '/' + active?.id && active?.token === token)) continue;
				delete accountTokens[key];
				delete accountInfos[key];
			}
		}
		for (const [key, expected] of Object.entries(fallback.removedAccountTokens ?? {})) {
			if (expected != null && accountTokens[key] && accountTokens[key] !== expected) continue;
			delete accountTokens[key];
			delete accountInfos[key];
		}
		return { accountTokens, accountInfos, accountHost: host };
	});
	// Drop the worker barrier only after the authoritative IndexedDB write has committed.
	const trusted = await trustIndexedDB();
	const rest: FallbackState = miLocalStorage.getItemAsJson(fallbackKey) ?? {};
	delete rest.accountTokens;
	delete rest.accountInfos;
	delete rest.accountHost;
	if (trusted) delete rest.partialAccountState;
	else rest.partialAccountState = true;
	delete rest.removedAccountTokens;
	miLocalStorage.setItemAsJson(fallbackKey, rest);
}

function lockAccounts<T>(operation: () => Promise<T>): Promise<T> {
	return navigator.locks ? navigator.locks.request('misskey:accounts', operation) : operation();
}

export function withAccountLock<T>(operation: () => Promise<T>, initializing = false): Promise<T> {
	return lockAccounts(async () => {
		await synchronizeAccounts(initializing);
		return operation();
	});
}

export function clearAccountStorage(clearDatabases: () => Promise<void>) {
	return lockAccounts(async () => {
		await markFallbackAccounts();
		localStorage.clear();
		miLocalStorage.setItemAsJson(fallbackKey, { accountTokens: {}, accountInfos: {}, partialAccountState: false });
		await clearDatabases();
	});
}
