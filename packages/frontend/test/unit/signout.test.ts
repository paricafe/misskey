/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { signout } from '@/signout.js';

const mocks = vi.hoisted(() => ({
	backup: vi.fn(),
	clear: vi.fn(),
	reload: vi.fn(),
	state: { enablePreferencesAutoCloudBackup: true },
}));
vi.mock('@@/js/config.js', () => ({ apiUrl: 'https://local.example/api' }));
vi.mock('@/preferences/utility.js', () => ({ cloudBackup: mocks.backup }));
vi.mock('@/store.js', () => ({ store: { s: mocks.state } }));
vi.mock('@/os.js', () => ({ waiting: vi.fn() }));
vi.mock('@/utility/unison-reload.js', () => ({ unisonReload: mocks.reload }));
vi.mock('@/utility/idb-proxy.js', () => ({ clear: mocks.clear }));
vi.mock('@/i.js', () => ({ $i: { id: 'alice', token: 'secret' } }));

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.backup.mockReset().mockResolvedValue(undefined);
	mocks.clear.mockResolvedValue(undefined);
	mocks.state.enablePreferencesAutoCloudBackup = true;
	localStorage.setItem('account', 'secret');
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.stubGlobal('indexedDB', { deleteDatabase: vi.fn(() => {
		const request = { onsuccess: () => {} };
		Promise.resolve().then(() => request.onsuccess());
		return request;
	}) });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

test('backup failure still clears credentials and reloads signed out', async () => {
	mocks.backup.mockRejectedValue(new Error('offline'));
	await signout();
	expect(localStorage.getItem('account')).toBeNull();
	expect(mocks.clear).toHaveBeenCalledOnce();
	expect(mocks.reload).toHaveBeenCalledWith('/');
	expect(vi.getTimerCount()).toBe(0);
});

test('aborts a stalled backup and finishes signing out', async () => {
	mocks.backup.mockImplementation((signal: AbortSignal) => new Promise((resolve, reject) => {
		signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	}));
	const signingOut = signout();
	await vi.advanceTimersByTimeAsync(5000);
	await signingOut;
	expect(localStorage.getItem('account')).toBeNull();
	expect(mocks.clear).toHaveBeenCalledOnce();
	expect(mocks.reload).toHaveBeenCalledWith('/');
	expect(vi.getTimerCount()).toBe(0);
});

test('disabled backup does not prevent local cleanup', async () => {
	mocks.state.enablePreferencesAutoCloudBackup = false;
	await signout();
	expect(mocks.backup).not.toHaveBeenCalled();
	expect(localStorage.getItem('account')).toBeNull();
	expect(mocks.reload).toHaveBeenCalledWith('/');
});
