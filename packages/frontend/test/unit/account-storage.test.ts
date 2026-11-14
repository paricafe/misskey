/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ACCOUNT_DEVICE_STATE_KEY, readStoredAccounts } from '@@/js/stored-accounts.js';
import { initializeAccountStorage, removeAccount, login, switchAccount, refreshCurrentAccount } from '@/accounts.js';
import { getAccountFromId } from '@/utility/get-account-from-id.js';

const mocks = vi.hoisted(() => ({
	db: new Map<string, unknown>(),
	state: { accountHost: '', accountTokens: {} as Record<string, string>, accountInfos: {} as Record<string, unknown> },
	accounts: [] as [string, { id: string; username: string }][],
	currentAccount: null as { id: string; token: string } | null,
	signout: vi.fn(),
}));

vi.mock('@@/js/config.js', () => ({ host: 'local.example', apiUrl: 'https://local.example/api' }));
vi.mock('@/utility/idb-proxy.js', () => ({
	get: async (key: string) => mocks.db.get(key),
	del: async (key: string) => { mocks.db.delete(key); },
}));
vi.mock('@/store.js', () => ({ store: {
	ready: Promise.resolve(),
	s: mocks.state,
	set: async (key: keyof typeof mocks.state, value: never) => {
		mocks.state[key] = value;
		mocks.db.set('pizzax::base', { ...mocks.db.get('pizzax::base') as object, [key]: value });
	},
} }));
vi.mock('@/preferences.js', () => ({ prefer: {
	s: { get accounts() { return mocks.accounts; } },
	commit: (_key: string, value: typeof mocks.accounts) => { mocks.accounts = value; },
} }));
vi.mock('@/local-storage.js', () => ({ miLocalStorage: { setItem: vi.fn() } }));
vi.mock('@/i.js', () => ({ get $i() { return mocks.currentAccount; } }));
vi.mock('@/signout.js', () => ({ signout: mocks.signout }));
vi.mock('@/i18n.js', () => ({ i18n: { ts: {} } }));
vi.mock('@/os.js', () => ({ popup: vi.fn(() => ({ dispose: vi.fn() })), popupMenu: vi.fn(), success: vi.fn(), alert: vi.fn(), waiting: vi.fn() }));
vi.mock('@/utility/show-suspended-dialog.js', () => ({ showSuspendedDialog: vi.fn() }));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: vi.fn(), reloadChannel: { postMessage: vi.fn() } }));

beforeEach(() => {
	mocks.db.clear();
	mocks.state.accountHost = '';
	mocks.state.accountTokens = {};
	mocks.state.accountInfos = {};
	mocks.accounts = [];
	mocks.currentAccount = null;
	mocks.signout.mockClear();
});

const read = async (key: string) => mocks.db.get(key);

test('fresh device and unknown loginId return no account', async () => {
	expect(await getAccountFromId('missing')).toBeUndefined();
	await initializeAccountStorage();
	expect(await readStoredAccounts(read, 'local.example')).toEqual([]);
});

test('page and worker contract selects only current-host credentials', async () => {
	mocks.db.set(ACCOUNT_DEVICE_STATE_KEY, { accountTokens: {
		'local.example/alice': 'local-token',
		'remote.example/alice': 'remote-token',
		'local.example.evil/alice': 'evil-token',
	} });
	expect(await getAccountFromId('alice')).toEqual({ id: 'alice', token: 'local-token' });
	expect(await readStoredAccounts(read, 'remote.example')).toEqual([{ id: 'alice', token: 'remote-token' }]);
});

test('upgrades legacy credentials once and removes the legacy key', async () => {
	mocks.db.set('accounts', [{ id: 'alice', token: 'legacy' }, { id: 'bob', token: 'foreign', host: 'remote.example' }]);
	expect(await getAccountFromId('alice')).toEqual({ id: 'alice', token: 'legacy' });
	await initializeAccountStorage();
	expect(mocks.state.accountTokens).toEqual({ 'local.example/alice': 'legacy' });
	expect(mocks.db.has('accounts')).toBe(false);
	expect(await getAccountFromId('bob')).toBeUndefined();
});

test('new storage wins over stale legacy token and removal stays removed', async () => {
	mocks.db.set('accounts', [{ id: 'alice', token: 'stale' }]);
	mocks.state.accountTokens = { 'local.example/alice': 'rotated', 'remote.example/alice': 'remote' };
	mocks.db.set(ACCOUNT_DEVICE_STATE_KEY, { accountTokens: mocks.state.accountTokens });
	mocks.accounts = [['local.example', { id: 'alice', username: 'alice' }]];
	expect(await getAccountFromId('alice')).toEqual({ id: 'alice', token: 'rotated' });
	await removeAccount('local.example', 'alice');
	expect(await getAccountFromId('alice')).toBeUndefined();
	expect(await readStoredAccounts(read, 'remote.example')).toEqual([{ id: 'alice', token: 'remote' }]);
	await initializeAccountStorage();
	expect(mocks.db.has('accounts')).toBe(false);
	expect(await getAccountFromId('alice')).toBeUndefined();
});

afterEach(() => vi.unstubAllGlobals());

test.each(['old-token', undefined])('reauthentication replaces saved credential %s without duplicating the account', async (oldToken) => {
	mocks.accounts = [['local.example', { id: 'alice', username: 'alice' }]];
	if (oldToken) mocks.state.accountTokens = { 'local.example/alice': oldToken };
	vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, json: async () => ({ id: 'alice', username: 'alice', name: 'Updated' }) }));
	await login('new-token');
	expect(mocks.accounts).toHaveLength(1);
	expect(await getAccountFromId('alice')).toEqual({ id: 'alice', token: 'new-token' });
	expect(mocks.state.accountInfos['local.example/alice']).toMatchObject({ name: 'Updated' });
});

test('switching a foreign-host account never submits its credential locally', async () => {
	mocks.state.accountTokens = { 'remote.example/alice': 'remote-secret' };
	const fetch = vi.fn();
	vi.stubGlobal('fetch', fetch);
	await expect(switchAccount('remote.example', 'alice')).rejects.toThrow('another host');
	expect(fetch).not.toHaveBeenCalled();
});

test('revoked current account never falls back to credentials from another host', async () => {
	mocks.currentAccount = { id: 'alice', token: 'revoked' };
	mocks.state.accountTokens = { 'local.example/alice': 'revoked', 'remote.example/bob': 'remote-secret' };
	const fetch = vi.fn().mockResolvedValue({ status: 403, json: async () => ({ error: { id: 'b0a7f5f8-dc2f-4171-b91f-de88ad238e14' } }) });
	vi.stubGlobal('fetch', fetch);
	await refreshCurrentAccount();
	expect(fetch).toHaveBeenCalledOnce();
	expect(mocks.signout).toHaveBeenCalledOnce();
});

test('worker reads only the persisted canonical host when served from an alias', async () => {
	mocks.db.set(ACCOUNT_DEVICE_STATE_KEY, {
		accountHost: 'local.example',
		accountTokens: {
			'local.example/alice': 'canonical-token',
			'alias.example/alice': 'alias-token',
			'remote.example/alice': 'foreign-token',
		},
	});
	expect(await readStoredAccounts(read, 'alias.example')).toEqual([{ id: 'alice', token: 'canonical-token' }]);
	expect(await getAccountFromId('alice')).toEqual({ id: 'alice', token: 'canonical-token' });
});

test('initialization records the page canonical host for a worker on an alias', async () => {
	mocks.state.accountTokens = { 'local.example/alice': 'canonical-token', 'alias.example/alice': 'alias-token' };
	mocks.db.set(ACCOUNT_DEVICE_STATE_KEY, { accountTokens: mocks.state.accountTokens });
	await initializeAccountStorage();
	expect(mocks.state.accountHost).toBe('local.example');
	expect(await readStoredAccounts(read, 'alias.example')).toEqual([{ id: 'alice', token: 'canonical-token' }]);
});
