/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { get } from 'idb-keyval';
import { readStoredAccounts } from '@@/js/stored-accounts.js';

export async function getAccounts() {
	return readStoredAccounts(get, globalThis.location.host);
}

export async function getAccountFromId(id: string) {
	return (await getAccounts()).find(account => account.id === id);
}
