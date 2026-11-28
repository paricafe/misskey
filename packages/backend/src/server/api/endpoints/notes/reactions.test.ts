/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { describe, expect, test, vi } from 'vitest';
import NoteReactionsEndpoint from './reactions.js';

describe('notes/reactions', () => {
	test('matches both heart variants when filtering by heart reaction', async () => {
		const query = new DataSource({ type: 'postgres' }).createQueryBuilder().select('reaction.*').from('note_reaction', 'reaction');
		vi.spyOn(query, 'leftJoinAndSelect').mockReturnValue(query);
		vi.spyOn(query, 'getMany').mockResolvedValue([]);
		const endpoint = new NoteReactionsEndpoint(
			{ createQueryBuilder: () => query } as never,
			{ packMany: vi.fn().mockResolvedValue([]) } as never,
			{ isVisibleForMe: vi.fn().mockResolvedValue(true) } as never,
			{ makePaginationQuery: () => query } as never,
			{ getNote: vi.fn().mockResolvedValue({ id: '9x00000001' }) } as never,
		);

		await endpoint.exec({ noteId: '9x00000001', type: '❤', limit: 10 }, null, null);
		const [sql, params] = query.getQueryAndParameters();
		expect(sql).toContain('reaction.reaction IN');
		expect(params).toContain('❤');
		expect(params).toContain('❤️');
	});
});
