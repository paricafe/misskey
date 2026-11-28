/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
	get as iget,
	set as iset,
	del as idel,
	clear as iclear,
} from 'idb-keyval';
import { miLocalStorage } from '@/local-storage.js';

const PREFIX = 'idbfallback::';

let idbAvailable = typeof window !== 'undefined' ? !!(window.indexedDB && typeof window.indexedDB.open === 'function') : true;
let idbReadyPromise: Promise<boolean> | null = null;

if (!idbAvailable) {
	console.error('indexedDB is unavailable. It will use localStorage.');
}

function ensureIdbReady(): Promise<boolean> {
	if (!idbAvailable) return Promise.resolve(false);
	return idbReadyPromise ??= iset('idb-test', 'test')
		.then(() => true)
		.catch(err => {
			console.error('idb error', err);
			console.error('indexedDB is unavailable. It will use localStorage.');
			idbAvailable = false;
			return false;
		});
}

export async function get(key: string) {
	if (await ensureIdbReady()) return iget(key);
	return miLocalStorage.getItemAsJson(`${PREFIX}${key}`);
}

export async function set(key: string, val: any) {
	if (await ensureIdbReady()) return iset(key, val);
	return miLocalStorage.setItemAsJson(`${PREFIX}${key}`, val);
}

export async function del(key: string) {
	if (await ensureIdbReady()) return idel(key);
	return miLocalStorage.removeItem(`${PREFIX}${key}`);
}

export async function clear() {
	if (await ensureIdbReady()) return iclear();
}
