/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { MastodonPaginationService } from './MastodonPaginationService.js';

describe(MastodonPaginationService, () => {
	const service = new MastodonPaginationService();

	test('clamps limits and translates Mastodon cursors', () => {
		expect(service.toMisskey({ limit: '999', max_id: 'older', since_id: 'newer' })).toEqual({
			limit: 40,
			untilId: 'older',
			sinceId: 'newer',
		});
		expect(service.toMisskey({ limit: '-1' })).toEqual({ limit: 1 });
		expect(service.toMisskey({})).toEqual({ limit: 20 });
	});

	test('builds next and previous Link relations from returned IDs', () => {
		expect(service.linkHeader(
			'https://misskey.example/api/v1/timelines/home?limit=20',
			[{ id: 'newest' }, { id: 'oldest' }],
		)).toBe('<https://misskey.example/api/v1/timelines/home?limit=20&max_id=oldest>; rel="next", <https://misskey.example/api/v1/timelines/home?limit=20&since_id=newest>; rel="prev"');
	});

	test('omits Link relations for an empty page', () => {
		expect(service.linkHeader('https://misskey.example/api/v1/timelines/home', [])).toBeNull();
	});
});
