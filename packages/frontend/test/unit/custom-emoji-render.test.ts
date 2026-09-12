/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import MkCustomEmoji from '@/components/global/MkCustomEmoji.vue';
import { customEmojisMap } from '@/custom-emojis.js';

vi.mock('@/custom-emojis.js', async () => {
	const { shallowReactive } = await import('vue');
	return { customEmojisMap: shallowReactive(new Map()) };
});
vi.mock('@/components/MkCustomEmojiDetailedDialog.vue', () => ({ default: {} }));
vi.mock('@/os.js', () => ({}));
vi.mock('@/utility/emoji-palette.js', () => ({ addToEmojiPalette: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/utility/media-proxy.js', () => ({
	getProxiedImageUrl: (url: string) => url,
	getStaticImageUrl: (url: string) => url,
}));

const apps: ReturnType<typeof createApp>[] = [];

function mountEmoji() {
	const root = document.createElement('div');
	const app = createApp({ render: () => h(MkCustomEmoji, { name: 'test' }) });
	app.mount(root);
	apps.push(app);
	return root;
}

function updateEmoji(url: string) {
	customEmojisMap.set('test', { name: 'test', aliases: [], category: null, url });
}

beforeEach(() => customEmojisMap.clear());
afterEach(() => {
	for (const app of apps.splice(0)) app.unmount();
});

describe('custom emoji catalog refresh', () => {
	test('renders an initially missing emoji when its URL becomes available', async () => {
		const root = mountEmoji();
		expect(root.textContent).toBe(':test:');
		updateEmoji('https://example.com/new.png');
		await nextTick();
		expect(root.querySelector('img')?.getAttribute('src')).toBe('https://example.com/new.png');
	});

	test('recovers from a failed cached URL when the catalog changes', async () => {
		updateEmoji('https://example.com/old.png');
		const root = mountEmoji();
		root.querySelector('img')!.dispatchEvent(new Event('error'));
		await nextTick();
		expect(root.textContent).toBe(':test:');
		updateEmoji('https://example.com/new.png');
		await nextTick();
		expect(root.querySelector('img')?.getAttribute('src')).toBe('https://example.com/new.png');
	});
});
