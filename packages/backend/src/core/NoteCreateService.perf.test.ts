/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiNote } from '@/models/Note.js';
import { NoteCreateService } from './NoteCreateService.js';

describe('NoteCreateService performance regressions', () => {
	test('insertNote skips userProfilesRepository for local-only mentions and queries only remote IDs for mixed mentions', async () => {
		const userProfilesRepository = {
			findBy: vi.fn().mockResolvedValue([{ userId: 'remote-1', url: 'https://remote.example/@bob' }]),
		};
		const notesRepository = { insert: vi.fn().mockResolvedValue(undefined) };
		const service = Object.create(NoteCreateService.prototype) as NoteCreateService;
		Object.assign(service, {
			idService: { gen: () => 'note-1' },
			notesRepository,
			userProfilesRepository,
			userEntityService: {
				isRemoteUser: (u: { host: string | null }) => u.host != null,
			},
		});

		const localNote = await service['insertNote'](
			{ id: 'author', host: null },
			{ visibility: 'public', localOnly: false },
			[],
			[],
			[{ id: 'local-1', username: 'alice', host: null, uri: null } as never],
		);

		expect(userProfilesRepository.findBy).not.toHaveBeenCalled();
		expect(localNote.mentions).toEqual(['local-1']);
		expect(localNote.mentionedRemoteUsers).toBe('[]');

		const mixedNote = await service['insertNote'](
			{ id: 'author', host: null },
			{ visibility: 'public', localOnly: false },
			[],
			[],
			[
				{ id: 'local-1', username: 'alice', host: null, uri: null } as never,
				{ id: 'remote-1', username: 'bob', host: 'remote.example', uri: 'https://remote.example/users/bob' } as never,
			],
		);

		expect(userProfilesRepository.findBy).toHaveBeenCalledTimes(1);
		expect(userProfilesRepository.findBy.mock.calls[0][0].userId.value).toEqual(['remote-1']);
		expect(JSON.parse(mixedNote.mentionedRemoteUsers)).toEqual([{
			uri: 'https://remote.example/users/bob',
			url: 'https://remote.example/@bob',
			username: 'bob',
			host: 'remote.example',
		}]);
	});

	test('postNoteCreated combines channel notesCount/lastNotedAt into one update and checks first post with take: 2', async () => {
		const execute = vi.fn().mockResolvedValue(undefined);
		const where = vi.fn(() => ({ execute }));
		const set = vi.fn(() => ({ where }));
		const update = vi.fn(() => ({ set }));
		const channelsRepository = {
			createQueryBuilder: vi.fn(() => ({ update })),
			increment: vi.fn().mockResolvedValue(undefined),
			update: vi.fn(),
		};
		const notesRepository = {
			find: vi.fn().mockResolvedValue([{ id: 'note-1' }]),
			countBy: vi.fn(),
		};
		const service = Object.create(NoteCreateService.prototype) as NoteCreateService;
		Object.assign(service, {
			meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false },
			notesChart: { update: vi.fn() },
			perUserNotesChart: { update: vi.fn() },
			hashtagService: { updateHashtags: vi.fn() },
			antennaService: { addNoteToAntennas: vi.fn() },
			followingsRepository: { findBy: vi.fn().mockResolvedValue([]) },
			userEntityService: { isLocalUser: () => true },
			channelsRepository,
			notesRepository,
		});
		for (const method of ['incNotesCountOfUser', 'pushToTl', 'index']) {
			Object.defineProperty(service, method, { value: vi.fn() });
		}
		Object.defineProperty(service, 'deliverNote', { value: vi.fn().mockResolvedValue(undefined) });

		const note = { id: 'note-1', userId: 'author', visibility: 'public', channelId: 'ch-1' } as MiNote;
		await service['postNoteCreated'](
			note,
			{ id: 'author', username: 'author', host: null, isBot: false },
			{ text: 'hi', visibility: 'public', channel: { id: 'ch-1' } as never },
			true,
			[],
			[],
		);

		await vi.waitFor(() => expect(channelsRepository.increment).toHaveBeenCalledWith({ id: 'ch-1' }, 'usersCount', 1));
		expect(channelsRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
		expect(channelsRepository.update).not.toHaveBeenCalled();
		expect(notesRepository.countBy).not.toHaveBeenCalled();
		expect(notesRepository.find).toHaveBeenCalledWith({
			where: { userId: 'author', channelId: 'ch-1' },
			select: { id: true },
			take: 2,
		});
	});
});
