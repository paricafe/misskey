/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const ACCOUNT_DEVICE_STATE_KEY = 'pizzax::base';

export type StoredAccount = {
	id: string;
	token: string;
};

export async function readStoredAccounts(read: (key: string) => Promise<unknown>, host: string): Promise<StoredAccount[]> {
	const state = await read(ACCOUNT_DEVICE_STATE_KEY) as { accountTokens?: Record<string, string>; accountHost?: string } | undefined;
	if (state?.accountTokens != null) {
		const accountHost = typeof state.accountHost === 'string' && state.accountHost.length > 0 ? state.accountHost : host;
		const prefix = accountHost + '/';
		return Object.entries(state.accountTokens)
			.filter(([key, token]) => key.startsWith(prefix) && key.length > prefix.length && typeof token === 'string' && token.length > 0)
			.map(([key, token]) => ({ id: key.slice(prefix.length), token }));
	}

	const legacy = await read('accounts');
	if (!Array.isArray(legacy)) return [];
	return legacy.filter((account): account is StoredAccount => account != null
		&& typeof account.id === 'string'
		&& typeof account.token === 'string'
		&& account.token.length > 0
		&& (account.host == null || account.host === host))
		.map(({ id, token }) => ({ id, token }));
}
