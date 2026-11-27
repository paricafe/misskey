/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const ACCOUNT_DEVICE_STATE_KEY = 'pizzax::base';

export type StoredAccount = {
	id: string;
	token: string;
};

export async function readLegacyStoredAccounts(read: (key: string) => Promise<unknown>, host: string): Promise<StoredAccount[]> {
	const legacy = await read('accounts');
	if (!Array.isArray(legacy)) return [];
	return legacy.filter((account): account is StoredAccount => account != null
		&& typeof account.id === 'string'
		&& typeof account.token === 'string'
		&& account.token.length > 0
		&& (account.host == null || account.host === host))
		.map(({ id, token }) => ({ id, token }));
}

export async function readStoredAccounts(read: (key: string) => Promise<unknown>, host: string): Promise<StoredAccount[]> {
	const state = await read(ACCOUNT_DEVICE_STATE_KEY) as {
		accountTokens?: Record<string, string>;
		accountInfos?: Record<string, unknown>;
		accountHost?: string;
	} | undefined;
	if (state?.accountTokens != null) {
		const accountHost = typeof state.accountHost === 'string' && state.accountHost.length > 0 ? state.accountHost : host;
		const prefix = accountHost + '/';
		const stored = Object.entries(state.accountTokens)
			.filter(([key, token]) => key.startsWith(prefix) && key.length > prefix.length && typeof token === 'string' && token.length > 0)
			.map(([key, token]) => ({ id: key.slice(prefix.length), token }));
		if (state.accountInfos != null) {
			const storedIds = new Set(stored.map(account => account.id));
			const legacyAccounts = await readLegacyStoredAccounts(read, accountHost);
			for (const legacy of legacyAccounts) {
				if (!storedIds.has(legacy.id) && Object.hasOwn(state.accountInfos, prefix + legacy.id)) {
					stored.push(legacy);
					storedIds.add(legacy.id);
				}
			}
		}
		return stored;
	}

	return readLegacyStoredAccounts(read, host);
}
