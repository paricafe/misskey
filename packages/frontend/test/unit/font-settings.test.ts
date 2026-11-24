/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, expect, test, vi } from 'vitest';
import { nextTick } from 'vue';

const mocks = vi.hoisted(() => ({
	loadFontStyle: vi.fn().mockResolvedValue(undefined),
	storage: new Map<string, string>(),
}));

vi.mock('@/utility/load-font.js', () => ({ loadFontStyle: mocks.loadFontStyle }));
vi.mock('@/local-storage.js', () => ({
	miLocalStorage: {
		getItem: (key: string) => mocks.storage.get(key) ?? null,
		setItem: (key: string, value: string) => mocks.storage.set(key, value),
	},
}));
vi.mock('@/i18n.js', () => ({ i18n: { ts: { useSystemFont: 'System UI' } } }));

beforeEach(() => {
	mocks.storage.clear();
	mocks.loadFontStyle.mockClear();
	document.documentElement.className = '';
});

test('reapplies a multi-option font after switching to a single-option font and back', async () => {
	const { getDefaultFontSettings } = await import('@/utility/font-settings.js');
	const settings = getDefaultFontSettings();

	settings.value.fontFace = 'chillroundgothic';
	await nextTick();
	expect(document.documentElement.classList.contains('default-font-chillroundgothic_N')).toBe(true);
	expect(mocks.storage.get('defaultFontFace')).toBe('chillroundgothic_N');

	settings.value.fontFace = 'lxgw-wenkai';
	await nextTick();
	expect(document.documentElement.classList.contains('default-font-lxgw-wenkai')).toBe(true);
	expect(settings.value.fontFaceType).toBe('');

	settings.value.fontFace = 'chillroundgothic';
	await nextTick();
	expect(document.documentElement.classList.contains('default-font-chillroundgothic_N')).toBe(true);
	expect(mocks.storage.get('defaultFontFace')).toBe('chillroundgothic_N');
});
