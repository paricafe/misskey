/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import type { MutingsRepository, NotesRepository, PollsRepository, PollVotesRepository } from '@/models/_.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import PollRecommendationEndpoint from '@/server/api/endpoints/notes/polls/recommendation.js';

describe('notes/polls/recommendation', () => {
	test('passes the selected polls to note packing for reuse', async () => {
		const polls = [{ noteId: 'poll' }];
		const notes = [{ id: 'poll', hasPoll: true }];
		const query = {
			where: vi.fn().mockReturnThis(),
			andWhere: vi.fn().mockReturnThis(),
			select: vi.fn().mockReturnThis(),
			setParameters: vi.fn().mockReturnThis(),
			getQuery: vi.fn().mockReturnValue('SELECT noteId'),
			getParameters: vi.fn().mockReturnValue({}),
			orderBy: vi.fn().mockReturnThis(),
			limit: vi.fn().mockReturnThis(),
			offset: vi.fn().mockReturnThis(),
			getMany: vi.fn().mockResolvedValue(polls),
		};
		const repository = { createQueryBuilder: () => query };
		const packMany = vi.fn().mockResolvedValue([{ id: 'poll', poll: { choices: [] } }]);
		const endpoint = new PollRecommendationEndpoint(
			{ find: vi.fn().mockResolvedValue(notes) } as unknown as NotesRepository,
			repository as unknown as PollsRepository,
			repository as unknown as PollVotesRepository,
			repository as unknown as MutingsRepository,
			{ packMany } as unknown as NoteEntityService,
		);
		const me = { id: 'viewer' } as MiLocalUser;
		const result = await endpoint.exec({ limit: 10, offset: 0, excludeChannels: false }, me, null);

		expect(packMany).toHaveBeenCalledExactlyOnceWith(notes, me, { detail: true, polls });
		expect(result).toEqual(await packMany.mock.results[0].value);
	});
});
