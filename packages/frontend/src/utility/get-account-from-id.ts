/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { host } from '@@/js/config.js';
import { readStoredAccounts } from '@@/js/stored-accounts.js';
import { get } from '@/utility/idb-proxy.js';

export async function getAccountFromId(id: string) {
	const accounts = await readStoredAccounts(get, host);
	return accounts.find(account => account.id === id);
}
