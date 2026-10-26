/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { computed, nextTick } from 'vue';
import type * as Misskey from 'misskey-js';

const mocks = vi.hoisted(() => ({
	cache: undefined as unknown,
	lastFetchedAt: 0,
	fetch: vi.fn(),
	set: vi.fn(),
}));

vi.mock('@/utility/idb-proxy.js', () => ({
	get: async (key: string) => key === 'emojis' ? mocks.cache : mocks.lastFetchedAt,
	set: mocks.set,
}));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: mocks.fetch, misskeyApiGet: mocks.fetch }));

function emoji(url: string): Misskey.entities.EmojiSimple {
	return { name: 'test', aliases: [], category: null, url };
}

beforeEach(() => {
	vi.resetModules();
	mocks.cache = undefined;
	mocks.lastFetchedAt = 0;
	mocks.fetch.mockReset();
	mocks.set.mockReset();
});

describe('custom emoji bootstrap', () => {
	test('renders cached emojis immediately and updates reactive lookups after refresh', async () => {
		mocks.cache = [emoji('https://example.com/old.png')];
		const response = Promise.withResolvers<{ emojis: Misskey.entities.EmojiSimple[] }>();
		mocks.fetch.mockReturnValue(response.promise);
		const { customEmojis, customEmojisMap, fetchCustomEmojisForBoot } = await import('@/custom-emojis.js');
		const url = computed(() => customEmojisMap.get('test')?.url);
		await fetchCustomEmojisForBoot();
		expect(mocks.fetch).toHaveBeenCalledOnce();
		expect(url.value).toBe('https://example.com/old.png');

		response.resolve({ emojis: [emoji('https://example.com/new.png')] });
		await response.promise;
		await nextTick();
		expect(url.value).toBe('https://example.com/new.png');
		expect(customEmojis.value).toEqual([emoji('https://example.com/new.png')]);
		expect(mocks.set).toHaveBeenCalledWith('emojis', customEmojis.value);
	});

	test('refreshing the catalog notifies only lookups of changed emojis', async () => {
		const other = (url: string) => ({ ...emoji(url), name: 'other' });
		const removed = { ...emoji('https://example.com/removed.png'), name: 'removed' };
		mocks.cache = [emoji('https://example.com/same.png'), other('https://example.com/old.png'), removed];
		const { customEmojis, customEmojisMap } = await import('@/custom-emojis.js');
		const reads = { test: 0, other: 0, removed: 0 };
		const lookups = (Object.keys(reads) as Array<keyof typeof reads>).map(name => computed(() => {
			reads[name]++;
			return customEmojisMap.has(name) ? customEmojisMap.get(name)!.url : null;
		}));
		lookups.forEach(lookup => lookup.value);

		customEmojis.value = [emoji('https://example.com/same.png'), other('https://example.com/new.png')];
		await nextTick();
		expect(lookups.map(lookup => lookup.value)).toEqual(['https://example.com/same.png', 'https://example.com/new.png', null]);
		expect(reads).toEqual({ test: 1, other: 2, removed: 2 });
	});

	test('treats an empty cached catalog as usable', async () => {
		mocks.cache = [];
		mocks.fetch.mockReturnValue(new Promise(() => {}));
		const { fetchCustomEmojisForBoot } = await import('@/custom-emojis.js');
		await expect(fetchCustomEmojisForBoot()).resolves.toBeUndefined();
	});

	test.each([undefined, {}])('waits for the initial catalog when cache is %s', async (cache) => {
		mocks.cache = cache;
		const response = Promise.withResolvers<{ emojis: Misskey.entities.EmojiSimple[] }>();
		mocks.fetch.mockReturnValue(response.promise);
		const { customEmojis, fetchCustomEmojisForBoot } = await import('@/custom-emojis.js');
		let ready = false;
		const boot = fetchCustomEmojisForBoot().then(() => { ready = true; });
		await nextTick();
		expect(ready).toBe(false);
		response.resolve({ emojis: [emoji('https://example.com/new.png')] });
		await boot;
		expect(ready).toBe(true);
		expect(customEmojis.value).toEqual([emoji('https://example.com/new.png')]);
	});

	test('allows startup when fetching the initial catalog fails', async () => {
		mocks.fetch.mockRejectedValue(new Error('offline'));
		const { fetchCustomEmojisForBoot } = await import('@/custom-emojis.js');
		await expect(fetchCustomEmojisForBoot()).resolves.toBeUndefined();
	});

	test('retains cached emojis when background refresh fails', async () => {
		mocks.cache = [emoji('https://example.com/old.png')];
		mocks.fetch.mockRejectedValue(new Error('offline'));
		const { customEmojis, fetchCustomEmojisForBoot } = await import('@/custom-emojis.js');
		await fetchCustomEmojisForBoot();
		await nextTick();
		expect(customEmojis.value).toEqual(mocks.cache);
	});
});
