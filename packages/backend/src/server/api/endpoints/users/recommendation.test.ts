/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import RecommendationEndpoint from './recommendation.js';

const me = { id: 'user-id' } as never;

function createEndpoint() {
	const query = {
		where: vi.fn(),
		andWhere: vi.fn(),
		orderBy: vi.fn(),
		setParameters: vi.fn(),
		limit: vi.fn(),
		offset: vi.fn(),
		getMany: vi.fn().mockResolvedValue([]),
	};
	query.where.mockReturnValue(query);
	query.andWhere.mockReturnValue(query);
	query.orderBy.mockReturnValue(query);
	query.setParameters.mockReturnValue(query);
	query.limit.mockReturnValue(query);
	query.offset.mockReturnValue(query);

	const followingQuery = {
		select: vi.fn(),
		where: vi.fn(),
		getQuery: vi.fn().mockReturnValue('SELECT "following"."followeeId" FROM "following"'),
		getParameters: vi.fn().mockReturnValue({ followerId: me.id }),
	};
	followingQuery.select.mockReturnValue(followingQuery);
	followingQuery.where.mockReturnValue(followingQuery);

	const queryService = {
		generateMutedUserQueryForUsers: vi.fn(),
		generateBlockQueryForUsers: vi.fn(),
		generateBlockedUserQueryForNotes: vi.fn(),
	};
	const endpoint = new RecommendationEndpoint(
		{ createQueryBuilder: vi.fn().mockReturnValue(query) } as never,
		{ createQueryBuilder: vi.fn().mockReturnValue(followingQuery) } as never,
		{ packMany: vi.fn().mockResolvedValue([]) } as never,
		queryService as never,
	);

	return { endpoint, query, queryService };
}

describe('api:users/recommendation', () => {
	test('does not apply note-only filters to the user query', async () => {
		const { endpoint, query, queryService } = createEndpoint();

		await endpoint.exec({ limit: 20, offset: 0 }, me, null);

		expect(queryService.generateMutedUserQueryForUsers).toHaveBeenCalledWith(query, me);
		expect(queryService.generateBlockQueryForUsers).toHaveBeenCalledWith(query, me);
		expect(queryService.generateBlockedUserQueryForNotes).not.toHaveBeenCalled();
	});
});
