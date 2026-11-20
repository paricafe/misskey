/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { get } from 'idb-keyval';
import { LOCAL_ACCOUNT_STORAGE_MARKER, readStoredAccounts, readStoredAccountState } from '@@/js/stored-accounts.js';

export async function getAccounts() {
	return readStoredAccounts(get, globalThis.location.host);
}

export async function getAccountFromId(id: string) {
	return (await getAccounts()).find(account => account.id === id);
}

function withPushDeadline<T>(promise: Promise<T>): Promise<T | null> {
	let timeout: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 1500); }),
	]).finally(() => clearTimeout(timeout));
}

export async function confirmPushAccount(id: string): Promise<{ token?: string } | false | null> {
	try {
		if (!await caches.has(LOCAL_ACCOUNT_STORAGE_MARKER)) {
			const readState = () => readStoredAccountState(get, globalThis.location.host);
			const accounts = await withPushDeadline(readState().catch(readState));
			if (accounts) return accounts.find(account => account.id === id) ?? false;
		}
	} catch {
		// The foreground page can still access its own account store.
	}

	const [client] = await globalThis.clients.matchAll({ type: 'window' });
	if (!client) return null;
	const channel = new MessageChannel();
	try {
		const confirmed = await withPushDeadline(new Promise<boolean | null>(resolve => {
			channel.port1.onmessage = ev => resolve(typeof ev.data === 'boolean' ? ev.data : null);
			client.postMessage({ type: 'confirm-push-account', userId: id }, [channel.port2]);
		}));
		return confirmed === true ? {} : confirmed;
	} catch {
		return null;
	} finally {
		channel.port1.close();
	}
}
