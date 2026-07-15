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

	test('builds only a next offset Link relation for the first page with more results', () => {
		expect(service.offsetLinkHeader(
			'https://misskey.example/api/v1/trends/tags?limit=10',
			0,
			10,
			true,
		)).toBe('<https://misskey.example/api/v1/trends/tags?limit=10&offset=10>; rel="next"');
	});

	test('builds next and previous offset Link relations for a middle page with more results', () => {
		expect(service.offsetLinkHeader(
			'https://misskey.example/api/v1/trends/tags?limit=10&offset=10',
			10,
			10,
			true,
		)).toBe('<https://misskey.example/api/v1/trends/tags?limit=10&offset=20>; rel="next", <https://misskey.example/api/v1/trends/tags?limit=10>; rel="prev"');
	});

	test('builds only a previous offset Link relation for a final non-first page', () => {
		expect(service.offsetLinkHeader(
			'https://misskey.example/api/v1/trends/tags?limit=10&offset=20',
			20,
			10,
			false,
		)).toBe('<https://misskey.example/api/v1/trends/tags?limit=10&offset=10>; rel="prev"');
	});

	test('omits offset Link relations for a first and final page', () => {
		expect(service.offsetLinkHeader(
			'https://misskey.example/api/v1/trends/tags?limit=10',
			0,
			10,
			false,
		)).toBeNull();
	});

	test('preserves unrelated query parameters in offset Link relations', () => {
		const header = service.offsetLinkHeader(
			'https://misskey.example/api/v1/trends/tags?limit=10&offset=10&language=ja&local=true',
			10,
			10,
			true,
		);

		expect(header).toContain('<https://misskey.example/api/v1/trends/tags?limit=10&offset=20&language=ja&local=true>; rel="next"');
		expect(header).toContain('<https://misskey.example/api/v1/trends/tags?limit=10&language=ja&local=true>; rel="prev"');
	});
});
