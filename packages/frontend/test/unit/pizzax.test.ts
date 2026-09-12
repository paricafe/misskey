/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Pizzax } from '@/lib/pizzax.js';

type Message = { where: 'device' | 'deviceAccount'; key: string; value: unknown; userId?: string };
const mocks = vi.hoisted(() => ({
	account: { id: 'account-A' } as { id: string } | null,
	listeners: [] as ((message: Message) => void)[],
}));

vi.mock('broadcast-channel', () => ({
	BroadcastChannel: class {
		addEventListener(_event: string, listener: (message: Message) => void) {
			mocks.listeners.push(listener);
		}
	},
}));
vi.mock('@/i.js', () => ({ get $i() { return mocks.account; } }));
vi.mock('@/store.js', () => ({ store: { ready: Promise.resolve() } }));
vi.mock('@/utility/idb-proxy.js', () => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn().mockResolvedValue({}) }));

async function createStore() {
	const state = new Pizzax('test', {
		visibility: { where: 'deviceAccount', default: 'public' },
		darkMode: { where: 'device', default: false },
	});
	await state.ready;
	await vi.runAllTimersAsync();
	await state.loaded;
	return state;
}

beforeEach(() => {
	vi.useFakeTimers();
	mocks.account = { id: 'account-A' };
	mocks.listeners.length = 0;
});

afterEach(() => vi.useRealTimers());

describe('Pizzax cross-tab synchronization', () => {
	test('accepts device-account updates from the same account', async () => {
		const state = await createStore();
		mocks.listeners[0]({ where: 'deviceAccount', key: 'visibility', value: 'followers', userId: 'account-A' });
		expect(state.s.visibility).toBe('followers');
		expect(state.r.visibility.value).toBe('followers');
	});

	test.each(['account-B', undefined])('ignores device-account updates from %s', async (userId) => {
		const state = await createStore();
		mocks.listeners[0]({ where: 'deviceAccount', key: 'visibility', value: 'specified', userId });
		expect(state.s.visibility).toBe('public');
		expect(state.r.visibility.value).toBe('public');
	});

	test('ignores device-account updates when signed out', async () => {
		mocks.account = null;
		const state = await createStore();
		mocks.listeners[0]({ where: 'deviceAccount', key: 'visibility', value: 'specified', userId: 'account-A' });
		expect(state.s.visibility).toBe('public');
	});

	test('continues to synchronize device-wide state', async () => {
		const state = await createStore();
		mocks.listeners[0]({ where: 'device', key: 'darkMode', value: true });
		expect(state.s.darkMode).toBe(true);
		expect(state.r.darkMode.value).toBe(true);
	});
});
