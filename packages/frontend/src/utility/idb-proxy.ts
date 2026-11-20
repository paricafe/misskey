/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
	get as iget,
	set as iset,
	update as iupdate,
	del as idel,
	clear as iclear,
} from 'idb-keyval';
import { LOCAL_ACCOUNT_STORAGE_MARKER } from '@@/js/stored-accounts.js';
import { miLocalStorage } from '@/local-storage.js';

const PREFIX = 'idbfallback::';

let idbAvailable = typeof window !== 'undefined' ? !!(window.indexedDB && typeof window.indexedDB.open === 'function') : true;

if (idbAvailable) {
	await iset('idb-test', 'test')
		.catch(err => {
			console.error('idb error', err);
			console.error('indexedDB is unavailable. It will use localStorage.');
			idbAvailable = false;
		});
} else {
	console.error('indexedDB is unavailable. It will use localStorage.');
}

if (!idbAvailable && 'caches' in window) {
	// A worker must confirm accounts with the page when its IndexedDB may be stale.
	await window.caches.open(LOCAL_ACCOUNT_STORAGE_MARKER).catch(() => {});
}

export async function get(key: string) {
	if (idbAvailable) return iget(key);
	return miLocalStorage.getItemAsJson(`${PREFIX}${key}`);
}

export async function set(key: string, val: any) {
	if (idbAvailable) return iset(key, val);
	return miLocalStorage.setItemAsJson(`${PREFIX}${key}`, val);
}

export async function update<T>(key: string, updater: (previous: T | undefined) => T) {
	if (idbAvailable) return iupdate<T>(key, updater);
	const persist = () => miLocalStorage.setItemAsJson(`${PREFIX}${key}`, updater(miLocalStorage.getItemAsJson(`${PREFIX}${key}`)));
	if (navigator.locks) return navigator.locks.request(PREFIX + key, persist);
	persist();
}

export async function del(key: string) {
	if (idbAvailable) return idel(key);
	return miLocalStorage.removeItem(`${PREFIX}${key}`);
}

export async function clear() {
	if (idbAvailable) return iclear();
}
