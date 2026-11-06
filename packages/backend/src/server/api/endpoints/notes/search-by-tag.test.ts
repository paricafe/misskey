/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { describe, expect, test, vi } from 'vitest';
import SearchByTagEndpoint from './search-by-tag.js';

describe('notes/search-by-tag query groups', () => {
	test('binds every AND and OR tag independently in the PostgreSQL query', async () => {
		const query = new DataSource({ type: 'postgres' }).createQueryBuilder().select('note.*').from('note', 'note');
		// The relations and visibility policies are independent of tag binding.
		vi.spyOn(query, 'innerJoinAndSelect').mockReturnValue(query);
		vi.spyOn(query, 'leftJoinAndSelect').mockReturnValue(query);
		vi.spyOn(query, 'getMany').mockResolvedValue([]);
		const endpoint = new SearchByTagEndpoint(
			{ createQueryBuilder: () => query } as never,
			{ packMany: vi.fn().mockResolvedValue([]) } as never,
			{
				makePaginationQuery: () => query,
				generateVisibilityQuery: vi.fn(),
				generateUgcVisibilityQueryForVisitor: vi.fn(),
				generateBaseNoteFilteringQuery: vi.fn(),
			} as never,
		);
		await endpoint.exec({ query: [['Alpha', 'Ｂｅｔａ'], ['Gamma']], limit: 10 }, null, null);
		const [sql, parameters] = query.getQueryAndParameters();
		expect(parameters).toEqual([['alpha'], ['beta'], ['gamma']]);
		expect(sql).toContain('($1 <@ note.tags AND $2 <@ note.tags) OR ($3 <@ note.tags)');
	});
});
