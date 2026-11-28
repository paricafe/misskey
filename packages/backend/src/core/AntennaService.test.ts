/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import type { MiAntenna } from '@/models/Antenna.js';
import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import { AntennaService } from './AntennaService.js';

function makeAntenna(overrides: Partial<MiAntenna> = {}): MiAntenna {
	return {
		id: 'antenna-1',
		userId: 'owner-1',
		name: 'Test',
		src: 'all',
		userListId: null,
		keywords: [['hello']],
		excludeKeywords: [],
		users: [],
		caseSensitive: false,
		localOnly: false,
		excludeBots: false,
		withReplies: true,
		withFile: false,
		hasUnreadNote: false,
		notify: false,
		lastUsedAt: new Date(),
		user: null,
		userList: null,
		...overrides,
	} as MiAntenna;
}

function makeNote(overrides: Partial<MiNote> = {}): MiNote {
	return {
		id: 'note-1',
		userId: 'author-1',
		userHost: null,
		visibility: 'public',
		text: 'Hello world',
		cw: null,
		replyId: null,
		renoteId: null,
		fileIds: [],
		localOnly: false,
		...overrides,
	} as MiNote;
}

function makeUser(overrides: Partial<MiUser> = {}): MiUser {
	return {
		id: 'author-1',
		username: 'alice',
		host: null,
		isBot: false,
		...overrides,
	} as MiUser;
}

function createService(antennas: MiAntenna[]) {
	const redisForSub = new EventEmitter();
	const exec = vi.fn().mockResolvedValue([]);
	const pipeline = vi.fn(() => ({ exec }));
	const antennasRepository = { findBy: vi.fn().mockResolvedValue(antennas) };
	const userListMembershipsRepository = {
		find: vi.fn().mockResolvedValue([]),
		findOneBy: vi.fn().mockResolvedValue(null),
	};
	const userFollowingsCache = { fetch: vi.fn().mockResolvedValue({}) };
	const fanoutTimelineService = { push: vi.fn() };
	const globalEventService = { publishAntennaStream: vi.fn(), publishMainStream: vi.fn() };
	const utilityService = { toPuny: (h: string) => h };

	const service = new AntennaService(
		{ pipeline } as never,
		redisForSub as never,
		antennasRepository as never,
		userListMembershipsRepository as never,
		{ userFollowingsCache } as never,
		utilityService as never,
		globalEventService as never,
		fanoutTimelineService as never,
	);

	return {
		service,
		exec,
		pipeline,
		userListMembershipsRepository,
		userFollowingsCache,
		fanoutTimelineService,
		globalEventService,
	};
}

describe('AntennaService', () => {
	test('batches list membership checks across 100 list antennas into a single SQL query', async () => {
		const antennas = Array.from({ length: 100 }, (_, i) => makeAntenna({
			id: `antenna-${i}`,
			src: 'list',
			userListId: i < 50 ? `list-${i}` : `list-${i - 50}`,
			keywords: [['hello']],
		}));
		const { service, userListMembershipsRepository, exec, fanoutTimelineService } = createService(antennas);
		userListMembershipsRepository.find.mockResolvedValue([
			{ userListId: 'list-3' },
			{ userListId: 'list-7' },
		]);

		const hit = await service.addNoteToAntennas(makeNote(), makeUser());

		expect(userListMembershipsRepository.find).toHaveBeenCalledTimes(1);
		expect(userListMembershipsRepository.findOneBy).not.toHaveBeenCalled();
		expect(hit.map(a => a.id).sort()).toEqual(['antenna-3', 'antenna-53', 'antenna-57', 'antenna-7']);
		expect(fanoutTimelineService.push).toHaveBeenCalledTimes(4);
		expect(exec).toHaveBeenCalledTimes(1);
	});

	test('skips DB queries and Redis pipeline execution when no antennas pass synchronous filters', async () => {
		const antennas = [
			makeAntenna({ id: 'a-list', src: 'list', userListId: 'list-1', keywords: [['nomatch']] }),
			makeAntenna({ id: 'a-excl', src: 'all', keywords: [['hello']], excludeKeywords: [['world']] }),
			makeAntenna({ id: 'a-file', src: 'all', keywords: [['hello']], withFile: true }),
		];
		const { service, userListMembershipsRepository, userFollowingsCache, pipeline, exec } = createService(antennas);

		const hit = await service.addNoteToAntennas(makeNote({ text: 'Hello world', fileIds: [] }), makeUser());

		expect(hit).toEqual([]);
		expect(userListMembershipsRepository.find).not.toHaveBeenCalled();
		expect(userFollowingsCache.fetch).not.toHaveBeenCalled();
		expect(pipeline).not.toHaveBeenCalled();
		expect(exec).not.toHaveBeenCalled();
	});

	test('deduplicates follower visibility checks per antenna owner across multiple antennas', async () => {
		const antennas = [
			makeAntenna({ id: 'a1', userId: 'owner-1', keywords: [['hello']] }),
			makeAntenna({ id: 'a2', userId: 'owner-1', keywords: [['world']] }),
			makeAntenna({ id: 'a3', userId: 'owner-2', keywords: [['hello']] }),
		];
		const { service, userFollowingsCache } = createService(antennas);
		userFollowingsCache.fetch.mockImplementation(async (userId: string) => (
			userId === 'owner-1' ? { 'author-1': true } : {}
		));

		const hit = await service.addNoteToAntennas(makeNote({ visibility: 'followers' }), makeUser());

		expect(hit.map(a => a.id)).toEqual(['a1', 'a2']);
		expect(userFollowingsCache.fetch).toHaveBeenCalledTimes(2);
	});
});
