/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { describe, expect, test, vi } from 'vitest';
import UserReactionsEndpoint from './reactions.js';

describe('users/reactions', () => {
	test('filters reactions by heart variants when type is a heart', async () => {
		const query = new DataSource({ type: 'postgres' }).createQueryBuilder().select('reaction.*').from('note_reaction', 'reaction');
		vi.spyOn(query, 'leftJoinAndSelect').mockReturnValue(query);
		vi.spyOn(query, 'getMany').mockResolvedValue([]);
		const endpoint = new UserReactionsEndpoint(
			{ findOneByOrFail: vi.fn().mockResolvedValue({ publicReactions: true }) } as never,
			{ createQueryBuilder: () => query } as never,
			{
				userBlockedCache: { fetch: vi.fn().mockResolvedValue(new Set()) },
				userMutingsCache: { fetch: vi.fn().mockResolvedValue(new Set()) },
				findUserById: vi.fn().mockResolvedValue({ id: '9x00000001', host: null }),
			} as never,
			{ isRemoteUser: vi.fn().mockReturnValue(false) } as never,
			{ packManyWithNote: vi.fn().mockResolvedValue([]) } as never,
			{
				makePaginationQuery: () => query,
				generateVisibilityQuery: vi.fn(),
				generateBlockedHostQueryForNote: vi.fn(),
				generateSuspendedUserQueryForNote: vi.fn(),
			} as never,
			{ isModerator: vi.fn().mockResolvedValue(false) } as never,
		);

		await endpoint.exec({ userId: '9x00000001', type: '❤', limit: 10 }, { id: '9x00000001' } as never, null);
		const [sql, params] = query.getQueryAndParameters();
		expect(sql).toContain('reaction.reaction IN');
		expect(params).toContain('❤');
		expect(params).toContain('❤️');
	});
});
