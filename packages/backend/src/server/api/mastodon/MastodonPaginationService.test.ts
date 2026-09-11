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
		});
		expect(service.toMisskey({ limit: 2, min_id: '010', max_id: '030', since_id: '005' })).toEqual({ limit: 2, sinceId: '010' });
		expect(service.toMisskey({ limit: '-1' })).toEqual({ limit: 1 });
		expect(service.toMisskey({})).toEqual({ limit: 20 });
	});

	test('builds next and previous Link relations from returned IDs', () => {
		expect(service.linkHeader(
			'https://misskey.example/api/v1/timelines/home?limit=20',
			[{ id: '030' }, { id: '010' }, { id: '020' }],
		)).toBe('<https://misskey.example/api/v1/timelines/home?limit=20&max_id=010>; rel="next", <https://misskey.example/api/v1/timelines/home?limit=20&min_id=030>; rel="prev"');
	});

	test('distinguishes newest unseen results from immediately newer results', () => {
		const notes = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1).padStart(3, '0') }));
		const nativePage = (query: Parameters<typeof service.toMisskey>[0]) => {
			const { sinceId, untilId, limit } = service.toMisskey(query);
			const filtered = notes.filter(note => (sinceId == null || note.id > sinceId) && (untilId == null || note.id < untilId));
			return sinceId != null ? filtered.slice(0, limit) : filtered.slice(-limit).reverse();
		};
		const latest = { since_id: '010', limit: 3 };
		const adjacent = { min_id: '010', limit: 3 };
		expect(service.normalizePage(nativePage(latest), latest).map(note => note.id)).toEqual(['100', '099', '098']);
		expect(service.normalizePage(nativePage(adjacent), adjacent).map(note => note.id)).toEqual(['013', '012', '011']);
		const bounded = { min_id: '010', max_id: '013', limit: 3 };
		expect(service.normalizePage(nativePage(bounded), bounded).map(note => note.id)).toEqual(['012', '011']);
		const latestBounded = { since_id: '097', max_id: '100', limit: 3 };
		expect(service.normalizePage(nativePage(latestBounded), latestBounded).map(note => note.id)).toEqual(['099', '098']);
	});

	test('does not duplicate or skip results while following the newer Link cursor', () => {
		const notes = Array.from({ length: 7 }, (_, index) => ({ id: String(index + 1).padStart(3, '0') }));
		let minId = '000';
		const visited: string[] = [];
		for (let index = 0; index < 4; index++) {
			const query = { min_id: minId, limit: 2 };
			const page = service.normalizePage(notes.filter(note => note.id > minId).slice(0, 2), query);
			visited.push(...page.map(note => note.id));
			const header = service.linkHeader(`https://misskey.example/api/v1/timelines/home?min_id=${minId}&limit=2`, page)!;
			const previous = /<([^>]+)>; rel="prev"/u.exec(header)![1];
			minId = new URL(previous).searchParams.get('min_id')!;
		}
		expect(visited).toEqual(['002', '001', '004', '003', '006', '005', '007']);
		expect(service.normalizePage(notes, { since_id: '100' })).toEqual([]);
	});

	test('removes incompatible cursors while preserving other Link query parameters', () => {
		const header = service.linkHeader('https://misskey.example/api/v1/timelines/public?min_id=005&since_id=001&max_id=040&local=true', [{ id: '020' }, { id: '010' }]);
		expect(header).toBe('<https://misskey.example/api/v1/timelines/public?max_id=010&local=true>; rel="next", <https://misskey.example/api/v1/timelines/public?min_id=020&local=true>; rel="prev"');
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
