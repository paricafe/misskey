/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { CustomEmojiService } from './CustomEmojiService.js';

describe('CustomEmojiService intra-batch missingKeys', () => {
	test('suppresses duplicate DB lookups for missing remote emojis within one batch without caching negatives across batches', async () => {
		const emojisRepository = {
			find: vi.fn().mockResolvedValue([
				{ name: 'known', host: 'remote.example', originalUrl: 'https://remote.example/known.png', publicUrl: 'https://remote.example/known.png' },
			]),
			findOneBy: vi.fn().mockResolvedValue(null),
		};

		const service = new CustomEmojiService(
			{} as never,
			emojisRepository as never,
			{ isSelfHost: () => false, toPunyNullable: (h: string | null) => h } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		);

		const missingKeys = await service.prefetchEmojis([
			{ name: 'known', host: 'remote.example' },
			{ name: 'missing', host: 'remote.example' },
			{ name: 'missing', host: 'remote.example' },
		]);

		expect(emojisRepository.find).toHaveBeenCalledTimes(1);
		expect(missingKeys).toEqual(new Set(['missing remote.example']));

		const resolved = await service.populateEmojis(
			['known@remote.example', 'missing@remote.example', 'missing@remote.example'],
			null,
			missingKeys,
		);
		expect(resolved).toEqual({ 'known@remote.example': 'https://remote.example/known.png' });
		expect(emojisRepository.findOneBy).not.toHaveBeenCalled();

		emojisRepository.findOneBy.mockResolvedValueOnce({
			name: 'missing',
			host: 'remote.example',
			originalUrl: 'https://remote.example/missing.png',
			publicUrl: 'https://remote.example/missing.png',
		});
		const laterUrl = await service.populateEmoji('missing@remote.example', null);
		expect(laterUrl).toBe('https://remote.example/missing.png');
		expect(emojisRepository.findOneBy).toHaveBeenCalledTimes(1);

		service.dispose();
	});
});
