/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, assert, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { nextTick } from 'vue';
import { searchEmoji } from '@/utility/search-emoji.js';

const { apiMock, customEmojisRef } = vi.hoisted(() => ({
	apiMock: vi.fn(),
	customEmojisRef: { value: [] as { name: string; aliases: string[]; category: string | null; url: string }[] },
}));

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: apiMock }));
vi.mock('@/os.js', () => ({ claimZIndex: () => 100, selectUser: vi.fn() }));
vi.mock('@/custom-emojis.js', async () => {
	const { shallowRef } = await import('vue');
	const customEmojis = shallowRef(customEmojisRef.value);
	return { customEmojis };
});
vi.mock('@/store.js', () => ({
	store: { s: { additionalUnicodeEmojiIndexes: {}, recentlyUsedEmojis: [] }, set: vi.fn() },
}));
vi.mock('@/preferences.js', async () => {
	const { ref } = await import('vue');
	return { prefer: { r: { emojiStyle: ref('twemoji') }, s: {} } };
});

describe('emoji autocomplete', () => {
	test('名前の完全一致は名前の前方一致より優先される', async () => {
		const result = searchEmoji('foooo', [{ emoji: ':foooo:', name: 'foooo' }, { emoji: ':foooobaaar:', name: 'foooobaaar' }]);
		assert.equal(result[0].emoji, ':foooo:');
	});

	test('名前の前方一致は名前の部分一致より優先される', async () => {
		const result = searchEmoji('baaa', [{ emoji: ':baaar:', name: 'baaar' }, { emoji: ':foooobaaar:', name: 'foooobaaar' }]);
		assert.equal(result[0].emoji, ':baaar:');
	});

	test('名前の完全一致はタグの完全一致より優先される', async () => {
		const result = searchEmoji('foooo', [{ emoji: ':foooo:', name: 'foooo' }, { emoji: ':baaar:', name: 'foooo', aliasOf: 'baaar' }]);
		assert.equal(result[0].emoji, ':foooo:');
	});

	test('名前の前方一致はタグの前方一致より優先される', async () => {
		const result = searchEmoji('foo', [{ emoji: ':foooo:', name: 'foooo' }, { emoji: ':baaar:', name: 'foooo', aliasOf: 'baaar' }]);
		assert.equal(result[0].emoji, ':foooo:');
	});

	test('名前の部分一致はタグの部分一致より優先される', async () => {
		const result = searchEmoji('oooo', [{ emoji: ':foooo:', name: 'foooo' }, { emoji: ':baaar:', name: 'foooo', aliasOf: 'baaar' }]);
		assert.equal(result[0].emoji, ':foooo:');
	});
});

describe('MkAutocomplete component', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		sessionStorage.clear();
		apiMock.mockReset();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	test('highlights first literal emoji match without HTML parsing', async () => {
		const { customEmojis } = await import('@/custom-emojis.js');
		customEmojis.value = [
			{ name: 'a<b>$$c$$', aliases: [], category: null, url: 'https://example.com/1.png' },
			{ name: 'aaaa', aliases: [], category: null, url: 'https://example.com/2.png' },
		];
		const { default: MkAutocomplete } = await import('@/components/MkAutocomplete.vue');
		const textarea = document.createElement('textarea');
		const result = render(MkAutocomplete, {
			props: { type: 'emoji', q: '<b>$$', textarea, close: vi.fn(), x: 0, y: 0 },
			global: { stubs: { MkCustomEmoji: true, MkEmoji: true, MkUserName: true } },
		});
		await nextTick();
		await nextTick();
		const bolds = result.container.querySelector('li')!.querySelectorAll('b');
		expect(bolds).toHaveLength(1);
		expect(bolds[0].textContent).toBe('<b>$$');
		expect(result.container.querySelector('li')?.textContent).toBe('a<b>$$c$$');
		await result.rerender({ type: 'emoji', q: 'aa', textarea, close: vi.fn(), x: 0, y: 0 });
		await nextTick();
		await nextTick();
		const firstItem = result.container.querySelector('li')!;
		const bolds2 = firstItem.querySelectorAll('b');
		expect(bolds2).toHaveLength(1);
		expect(bolds2[0].textContent).toBe('aa');
		expect(firstItem.textContent).toBe('aaaa');
	});

	test('debounces remote user queries and ignores out-of-order stale responses', async () => {
		const first = Promise.withResolvers<unknown[]>();
		const second = Promise.withResolvers<unknown[]>();
		apiMock
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { default: MkAutocomplete } = await import('@/components/MkAutocomplete.vue');
		const textarea = document.createElement('textarea');
		const result = render(MkAutocomplete, {
			props: { type: 'user', q: 'a', textarea, close: vi.fn(), x: 0, y: 0 },
			global: { stubs: { MkCustomEmoji: true, MkEmoji: true, MkUserName: true } },
		});
		await nextTick();
		await result.rerender({ type: 'user', q: 'al', textarea, close: vi.fn(), x: 0, y: 0 });
		await nextTick();
		await vi.advanceTimersByTimeAsync(150);
		expect(apiMock).toHaveBeenCalledTimes(1);
		expect(apiMock).toHaveBeenCalledWith('users/search-by-username-and-host', expect.objectContaining({ username: 'al' }));

		await result.rerender({ type: 'user', q: 'alice', textarea, close: vi.fn(), x: 0, y: 0 });
		await nextTick();
		await vi.advanceTimersByTimeAsync(150);
		expect(apiMock).toHaveBeenCalledTimes(2);

		second.resolve([{ id: '2', username: 'alice', host: null, avatarUrl: '' }]);
		await second.promise;
		await nextTick();
		expect(result.container.textContent).toContain('@alice');

		first.resolve([{ id: '1', username: 'alex', host: null, avatarUrl: '' }]);
		await first.promise;
		await nextTick();
		expect(result.container.textContent).toContain('@alice');
		expect(result.container.textContent).not.toContain('@alex');
	});

	test('returns cached hashtags immediately without remote fetch', async () => {
		sessionStorage.setItem('autocomplete:hashtag:miss', JSON.stringify(['misskey', 'misskey_dev']));
		const { default: MkAutocomplete } = await import('@/components/MkAutocomplete.vue');
		const textarea = document.createElement('textarea');
		const result = render(MkAutocomplete, {
			props: { type: 'hashtag', q: 'miss', textarea, close: vi.fn(), x: 0, y: 0 },
			global: { stubs: { MkCustomEmoji: true, MkEmoji: true, MkUserName: true } },
		});
		await nextTick();
		await nextTick();
		expect(apiMock).not.toHaveBeenCalled();
		expect(result.container.textContent).toContain('misskey');
		expect(result.container.textContent).toContain('misskey_dev');
	});
});
