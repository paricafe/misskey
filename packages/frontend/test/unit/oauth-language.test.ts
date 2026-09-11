/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe('OAuth page language', () => {
	afterEach(() => {
		document.head.querySelector('meta[name="misskey:oauth:lang"]')?.remove();
		localStorage.removeItem('lang');
		vi.resetModules();
	});

	test.each([undefined, 'ja-JP', 'invalid-language'])('uses only supported OAuth language metadata (%s) without changing the stored preference', async language => {
		localStorage.setItem('lang', 'en-US');
		if (language != null) {
			const element = document.createElement('meta');
			element.name = 'misskey:oauth:lang';
			element.content = language;
			document.head.appendChild(element);
		}
		vi.resetModules();
		const { lang } = await import('../../../frontend-shared/js/config.js');
		expect(lang).toBe(language === 'ja-JP' ? 'ja-JP' : 'en-US');
		expect(localStorage.getItem('lang')).toBe('en-US');
	});

	test('keeps the browser language preference after the bootloader handles an OAuth page', async () => {
		localStorage.setItem('lang', 'en-US');
		const bootloader = readFileSync(resolve(process.cwd(), 'public/loader/boot.js'), 'utf8');
		await runInNewContext(bootloader, {
			LANGS: ['en-US', 'ja-JP'],
			localStorage,
			navigator: { language: 'en-US' },
			URLSearchParams,
			window: { location: { search: '' }, addEventListener: vi.fn() },
			document: {
				querySelector: () => ({ content: 'ja-JP' }),
				readyState: 'loading',
				documentElement: { classList: { add: vi.fn() } },
			},
		});
		expect(localStorage.getItem('lang')).toBe('en-US');
	});
});
