/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { In } from 'typeorm';
import { describe, expect, test, vi } from 'vitest';
import type { MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import { NoteEntityService } from './NoteEntityService.js';
import { UserEntityService } from './UserEntityService.js';

function createQuery(rows: Record<string, string>[] = []) {
	return {
		select: vi.fn().mockReturnThis(),
		where: vi.fn().mockReturnThis(),
		andWhere: vi.fn().mockReturnThis(),
		innerJoinAndSelect: vi.fn().mockReturnThis(),
		getRawMany: vi.fn().mockResolvedValue(rows),
		getMany: vi.fn().mockResolvedValue([]),
	};
}

function createService() {
	const followed = createQuery([{ f_followerId: 'follower' }]);
	const requestsFromYou = createQuery([{ f_followeeId: 'request-to' }]);
	const requestsToYou = createQuery([{ f_followerId: 'request-from' }]);
	const blocking = createQuery([{ b_blockeeId: 'blocked-by-me' }]);
	const blocked = createQuery([{ b_blockerId: 'blocking-me' }]);
	const muted = createQuery([{ m_muteeId: 'muted' }]);
	const renoteMuted = createQuery([{ m_muteeId: 'renote-muted' }]);
	const pinQuery = createQuery();
	const following = { followerId: 'me', followeeId: 'followee', notify: 'normal', withReplies: true };
	const users = { findBy: vi.fn().mockResolvedValue([]) };
	const followings = {
		findBy: vi.fn().mockResolvedValue([following]),
		createQueryBuilder: vi.fn().mockReturnValue(followed),
	};
	const followRequests = {
		createQueryBuilder: vi.fn().mockReturnValueOnce(requestsFromYou).mockReturnValueOnce(requestsToYou),
	};
	const blockings = {
		createQueryBuilder: vi.fn().mockReturnValueOnce(blocking).mockReturnValueOnce(blocked),
	};
	const mutings = { createQueryBuilder: vi.fn().mockReturnValue(muted) };
	const renoteMutings = { createQueryBuilder: vi.fn().mockReturnValue(renoteMuted) };
	const pins = { createQueryBuilder: vi.fn().mockReturnValue(pinQuery) };
	const profiles = { findBy: vi.fn().mockResolvedValue([]), findOneByOrFail: vi.fn() };
	const memos = { findBy: vi.fn().mockResolvedValue([]), findOneBy: vi.fn() };
	const notePacking = { packMany: vi.fn().mockResolvedValue([]) };
	const services: Record<string, unknown> = {
		RoleService: {
			isModerator: vi.fn().mockResolvedValue(false),
			getUserBadgeRoles: vi.fn().mockResolvedValue([]),
			getUserPolicies: vi.fn().mockResolvedValue({ canPublicNote: true, chatAvailability: 'available' }),
			getUserRoles: vi.fn().mockResolvedValue([]),
		},
		CustomEmojiService: { populateEmojis: vi.fn().mockResolvedValue({}), prefetchEmojis: vi.fn().mockResolvedValue(undefined) },
		IdService: { parse: vi.fn().mockReturnValue({ date: new Date('2026-01-01T00:00:00Z') }) },
		NoteEntityService: notePacking,
	};
	const service = new UserEntityService(
		{ get: (name: string) => services[name] } as never,
		{ url: 'https://example.com', host: 'example.com' } as never,
		{} as never,
		{} as never,
		users as never,
		{} as never,
		followings as never,
		followRequests as never,
		blockings as never,
		mutings as never,
		renoteMutings as never,
		pins as never,
		profiles as never,
		memos as never,
	);
	service.onModuleInit();

	return {
		service, users, followings, followRequests, blockings, mutings, renoteMutings, pins, profiles, memos, following, pinQuery, notePacking, services,
		queries: { followed, requestsFromYou, requestsToYou, blocking, blocked, muted, renoteMuted },
	};
}

const user = {
	id: 'target',
	username: 'alice',
	name: 'Alice',
	host: null,
	avatarId: null,
	avatarDecorations: [],
	emojis: [],
	requireSigninToViewContents: false,
	followingCount: 2,
	followersCount: 4,
} as unknown as MiUser;

describe(UserEntityService, () => {
	describe('UserLite packing', () => {
		test.each([undefined, {}, { schema: undefined }, { schema: 'UserLite' as const }])('defaults to lightweight output without detail queries: %j', async options => {
			const { service, profiles, memos, pins, followings, followRequests, blockings, mutings, renoteMutings } = createService();
			const me = { id: 'me' };

			const expected = await service.pack(user, me, { schema: 'UserLite' });
			await expect(service.pack(user, me, options)).resolves.toEqual(expected);
			await expect(service.packMany([user], me, options)).resolves.toEqual([expected]);

			expect(profiles.findBy).not.toHaveBeenCalled();
			expect(profiles.findOneByOrFail).not.toHaveBeenCalled();
			expect(memos.findBy).not.toHaveBeenCalled();
			expect(memos.findOneBy).not.toHaveBeenCalled();
			expect(pins.createQueryBuilder).not.toHaveBeenCalled();
			expect(followings.findBy).not.toHaveBeenCalled();
			for (const repository of [followings, followRequests, blockings, mutings, renoteMutings]) {
				expect(repository.createQueryBuilder).not.toHaveBeenCalled();
			}
		});

		test('anonymous batches do not fetch profiles', async () => {
			const { service, profiles } = createService();

			await expect(service.packMany([user])).resolves.toEqual([await service.pack(user)]);
			expect(profiles.findBy).not.toHaveBeenCalled();
		});

		test('empty batches perform no database reads even for detailed output', async () => {
			const { service, users, profiles, memos, pins, followings } = createService();

			await expect(service.packMany([], { id: 'me' }, { schema: 'UserDetailed' })).resolves.toEqual([]);
			expect(users.findBy).not.toHaveBeenCalled();
			expect(profiles.findBy).not.toHaveBeenCalled();
			expect(memos.findBy).not.toHaveBeenCalled();
			expect(pins.createQueryBuilder).not.toHaveBeenCalled();
			expect(followings.findBy).not.toHaveBeenCalled();
		});
	});

	test('detailed packing keeps profile and memo output while fetching only target memos', async () => {
		const { service, profiles, memos } = createService();
		profiles.findBy.mockResolvedValue([{
			userId: user.id,
			description: 'About Alice',
			followingVisibility: 'public',
			followersVisibility: 'public',
		}]);
		memos.findBy.mockResolvedValue([{ targetUserId: user.id, memo: 'Remember Alice' }]);

		const result = await service.packMany([user], { id: 'me' }, { schema: 'UserDetailed' });

		expect(result[0]).toMatchObject({ id: user.id, description: 'About Alice', memo: 'Remember Alice', followingCount: 2, followersCount: 4 });
		expect(profiles.findBy).toHaveBeenCalledWith({ userId: In([user.id]) });
		expect(memos.findBy).toHaveBeenCalledWith({ userId: 'me', targetUserId: In([user.id]) });
		expect(profiles.findOneByOrFail).not.toHaveBeenCalled();
		expect(memos.findOneBy).not.toHaveBeenCalled();
	});

	test.each([null, { id: 'me' }])('batches and sorts detailed users\' pinned notes for viewer %j', async me => {
		const { service, profiles, pins, pinQuery, notePacking } = createService();
		const otherUser = { ...user, id: 'other' };
		profiles.findBy.mockResolvedValue([user, otherUser].map(u => ({ userId: u.id })));
		const older = { id: 'older-note' };
		const newer = { id: 'newer-note' };
		const other = { id: 'other-note' };
		pinQuery.getMany.mockResolvedValue([
			{ id: '01', userId: user.id, noteId: older.id, note: older },
			{ id: '02', userId: otherUser.id, noteId: other.id, note: other },
			{ id: '03', userId: user.id, noteId: newer.id, note: newer },
		]);
		notePacking.packMany.mockImplementation(async notes => notes);

		const packed = await service.packMany([user, otherUser], me, { schema: 'UserDetailed' });

		expect(packed.map(u => u.pinnedNoteIds)).toEqual([[newer.id, older.id], [other.id]]);
		expect(packed.map(u => u.pinnedNotes)).toEqual([[newer, older], [other]]);
		expect(pins.createQueryBuilder).toHaveBeenCalledExactlyOnceWith('pin');
		expect(pinQuery.where).toHaveBeenCalledExactlyOnceWith('pin.userId IN (:...userIds)', { userIds: [user.id, otherUser.id] });
		expect(pinQuery.innerJoinAndSelect).toHaveBeenCalledExactlyOnceWith('pin.note', 'note');
		expect(notePacking.packMany).toHaveBeenCalledWith([newer, older], me, { detail: true });
		expect(notePacking.packMany).toHaveBeenCalledWith([other], me, { detail: true });
	});

	test('anonymous detailed packing still hides followers-only pinned note contents', async () => {
		const { service, services, users, profiles, pinQuery } = createService();
		profiles.findBy.mockResolvedValue([{ userId: user.id }]);
		users.findBy.mockResolvedValue([user]);
		const publicNote = {
			id: 'public-note', userId: user.id, userHost: null, visibility: 'public', text: 'Public content',
			fileIds: [], tags: [], mentions: [], emojis: [], reactions: {}, reactionAndUserPairCache: [],
		} as unknown as MiNote;
		const privateNote = { ...publicNote, id: 'private-note', visibility: 'followers', text: 'Private content' } as MiNote;
		pinQuery.getMany.mockResolvedValue([
			{ id: '01', userId: user.id, noteId: publicNote.id, note: publicNote },
			{ id: '02', userId: user.id, noteId: privateNote.id, note: privateNote },
		]);
		services.UserEntityService = service;
		services.ReactionService = { convertLegacyReactions: (reactions: Record<string, number>) => reactions };
		services.ReactionsBufferingService = { mergeReactions: (reactions: Record<string, number>) => reactions };
		const noteService = new NoteEntityService(
			{ get: (name: string) => services[name] } as never,
			{ enableReactionsBuffering: false } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		);
		services.NoteEntityService = noteService;
		noteService.onModuleInit();
		service.onModuleInit();

		const [packed] = await service.packMany([user], null, { schema: 'UserDetailed' });

		expect(packed.pinnedNoteIds).toEqual([privateNote.id, publicNote.id]);
		expect(packed.pinnedNotes[0]).toMatchObject({ id: privateNote.id, text: null, isHidden: true, files: [] });
		expect(packed.pinnedNotes[1]).toMatchObject({ id: publicNote.id, text: 'Public content' });
	});

	describe('getRelations', () => {
		test('scopes all queries to targets and preserves relationship directions, order, and self results', async () => {
			const { service, followings, following, queries } = createService();
			const targets = ['followee', 'follower', 'request-to', 'request-from', 'blocked-by-me', 'blocking-me', 'muted', 'renote-muted', 'stranger', 'me', 'followee'];

			const result = await service.getRelations('me', targets);

			expect([...result.keys()]).toEqual([...new Set(targets)]);
			const expectedFlags = new Map([
				['followee', 'isFollowing'],
				['follower', 'isFollowed'],
				['request-to', 'hasPendingFollowRequestFromYou'],
				['request-from', 'hasPendingFollowRequestToYou'],
				['blocked-by-me', 'isBlocking'],
				['blocking-me', 'isBlocked'],
				['muted', 'isMuted'],
				['renote-muted', 'isRenoteMuted'],
			]);
			for (const target of new Set(targets)) {
				const expected = {
					id: target,
					following: target === 'followee' ? following : null,
					isFollowing: false,
					isFollowed: false,
					hasPendingFollowRequestFromYou: false,
					hasPendingFollowRequestToYou: false,
					isBlocking: false,
					isBlocked: false,
					isMuted: false,
					isRenoteMuted: false,
				};
				const trueFlag = expectedFlags.get(target);
				expect(result.get(target)).toEqual({ ...expected, ...(trueFlag ? { [trueFlag]: true } : {}) });
			}
			expect(followings.findBy).toHaveBeenCalledWith({ followerId: 'me', followeeId: In(targets) });
			for (const [query, targetColumn] of [
				[queries.followed, 'f.followerId'],
				[queries.requestsFromYou, 'f.followeeId'],
				[queries.requestsToYou, 'f.followerId'],
				[queries.blocking, 'b.blockeeId'],
				[queries.blocked, 'b.blockerId'],
				[queries.muted, 'm.muteeId'],
				[queries.renoteMuted, 'm.muteeId'],
			] as const) {
				expect(query.andWhere).toHaveBeenCalledWith(`${targetColumn} IN (:...targets)`, { targets });
			}
		});

		test('returns an empty map without querying when there are no targets', async () => {
			const { service, followings, followRequests, blockings, mutings, renoteMutings } = createService();

			await expect(service.getRelations('me', [])).resolves.toEqual(new Map());
			expect(followings.findBy).not.toHaveBeenCalled();
			for (const repository of [followings, followRequests, blockings, mutings, renoteMutings]) {
				expect(repository.createQueryBuilder).not.toHaveBeenCalled();
			}
		});
	});
});
