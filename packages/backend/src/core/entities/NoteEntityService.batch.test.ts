/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiChannel } from '@/models/Channel.js';
import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import { NoteEntityService } from './NoteEntityService.js';

function makeNote(overrides: Partial<MiNote> = {}): MiNote {
	return {
		id: 'note-1',
		userId: 'author-1',
		userHost: null,
		user: null,
		text: 'hello',
		cw: null,
		visibility: 'public',
		localOnly: false,
		reactionAcceptance: null,
		renoteCount: 0,
		repliesCount: 0,
		clippedCount: 0,
		pageCount: 0,
		reactions: {},
		reactionAndUserPairCache: [],
		lastReactionsBufferId: null,
		emojis: [],
		tags: [],
		fileIds: [],
		attachedFileTypes: [],
		visibleUserIds: [],
		mentions: [],
		mentionedRemoteUsers: '[]',
		hasPoll: false,
		replyId: null,
		reply: null,
		replyUserId: null,
		replyUserHost: null,
		renoteId: null,
		renote: null,
		renoteUserId: null,
		renoteUserHost: null,
		renoteChannelId: null,
		channelId: null,
		channel: null,
		threadId: null,
		uri: null,
		url: null,
		name: null,
		updatedAt: null,
		history: null,
		...overrides,
	} as MiNote;
}

function createService(overrides: {
	usersRepository?: Record<string, unknown>;
	followingsRepository?: Record<string, unknown>;
	noteReactionsRepository?: Record<string, unknown>;
	channelsRepository?: Record<string, unknown>;
	userEntityService?: Record<string, unknown>;
	customEmojiService?: Record<string, unknown>;
	cacheService?: Record<string, unknown>;
} = {}) {
	const services: Record<string, unknown> = {
		UserEntityService: overrides.userEntityService ?? { packMany: vi.fn().mockResolvedValue([]) },
		DriveFileEntityService: { packManyByIdsMap: vi.fn().mockResolvedValue(new Map()) },
		CacheService: overrides.cacheService ?? {
			userBlockingCache: { fetch: vi.fn() },
			userBlockedCache: { fetch: vi.fn().mockResolvedValue(new Set()) },
		},
		CustomEmojiService: overrides.customEmojiService ?? {
			prefetchEmojis: vi.fn().mockResolvedValue(new Set()),
			parseEmojiStr: vi.fn().mockReturnValue({ name: null, host: null }),
		},
		ReactionService: {
			convertLegacyReaction: (r: string) => r,
			decodeReaction: vi.fn().mockReturnValue({}),
		},
		ReactionsBufferingService: {
			getMany: vi.fn().mockResolvedValue(new Map()),
			getDeltas: vi.fn(),
			mergeReactions: (r: Record<string, number>) => r,
			getPairs: (note: MiNote) => note.reactionAndUserPairCache,
		},
		IdService: {
			gen: () => 'old-id',
			parse: () => ({ date: new Date(Date.now() - 60_000) }),
		},
	};
	const moduleRef = { get: (name: string) => services[name] };

	const service = new NoteEntityService(
		moduleRef as never,
		{ enableReactionsBuffering: false } as never,
		(overrides.usersRepository ?? { findOneByOrFail: vi.fn().mockResolvedValue({ id: 'viewer' }) }) as never,
		{} as never,
		(overrides.followingsRepository ?? { exists: vi.fn().mockResolvedValue(true), count: vi.fn() }) as never,
		{ findBy: vi.fn().mockResolvedValue([]) } as never,
		{ findBy: vi.fn().mockResolvedValue([]) } as never,
		(overrides.noteReactionsRepository ?? { findOneBy: vi.fn(), findBy: vi.fn().mockResolvedValue([]) }) as never,
		(overrides.channelsRepository ?? { findBy: vi.fn().mockResolvedValue([]), findOneBy: vi.fn() }) as never,
	);
	service.onModuleInit();
	return service;
}

describe('NoteEntityService batching and visibility optimizations', () => {
	test('coalesces concurrent DB-fallback populateMyReaction calls for the same note into one findBy query', async () => {
		const noteReactionsRepository = {
			findOneBy: vi.fn(),
			findBy: vi.fn().mockResolvedValue([
				{ noteId: 'renote-1', userId: 'u1', reaction: '👍' },
				{ noteId: 'renote-1', userId: 'u25', reaction: '❤' },
			]),
		};
		const service = createService({ noteReactionsRepository });

		const renote = {
			id: 'renote-1',
			reactions: { '👍': 20, '❤': 10 },
		};
		const results = await Promise.all(
			Array.from({ length: 50 }, (_, i) => service.populateMyReaction(renote, `u${i}`)),
		);

		expect(noteReactionsRepository.findBy).toHaveBeenCalledTimes(1);
		expect(noteReactionsRepository.findOneBy).not.toHaveBeenCalled();
		expect(results[0]).toBeUndefined();
		expect(results[1]).toBe('👍');
		expect(results[25]).toBe('❤');
		expect(results[49]).toBeUndefined();
	});

	test('packMany reuses loaded reply/renote users, batches channels without fallback, and passes intra-batch missingEmojiKeys', async () => {
		const author = { id: 'u-author', host: null, emojis: [] } as unknown as MiUser;
		const replyUser = { id: 'u-reply', host: null, emojis: [] } as unknown as MiUser;
		const renoteUser = { id: 'u-renote', host: null, emojis: [] } as unknown as MiUser;
		const channelA = { id: 'ch-1', name: 'Channel A', color: '#000', isSensitive: false, allowRenoteToExternal: true, userId: 'u-author' } as unknown as MiChannel;

		const replyNote = makeNote({ id: 'n-reply', userId: 'u-reply', user: replyUser, channelId: 'ch-missing' });
		const renoteNote = makeNote({ id: 'n-renote', userId: 'u-renote', user: renoteUser, channelId: 'ch-1' });
		const topNote = makeNote({
			id: 'n-top',
			userId: 'u-author',
			user: author,
			replyId: 'n-reply',
			reply: replyNote,
			replyUserId: 'u-reply',
			renoteId: 'n-renote',
			renote: renoteNote,
			renoteUserId: 'u-renote',
			channelId: 'ch-1',
		});

		const channelsRepository = {
			findBy: vi.fn().mockResolvedValue([channelA]),
			findOneBy: vi.fn(),
		};
		const userEntityService = {
			packMany: vi.fn().mockResolvedValue([
				{ id: 'u-author' },
				{ id: 'u-reply' },
				{ id: 'u-renote' },
			]),
		};
		const missingSet = new Set(['missing remote.example']);
		const customEmojiService = {
			prefetchEmojis: vi.fn().mockResolvedValue(missingSet),
			parseEmojiStr: vi.fn().mockReturnValue({ name: null, host: null }),
		};

		const service = createService({ channelsRepository, userEntityService, customEmojiService });
		const packSpy = vi.fn().mockResolvedValue({ id: 'packed' });
		Object.defineProperty(service, 'pack', { value: packSpy });

		await service.packMany([replyNote, topNote], { id: 'viewer' });

		expect(channelsRepository.findBy).toHaveBeenCalledTimes(1);
		expect(channelsRepository.findOneBy).not.toHaveBeenCalled();

		const packedUsersArg = userEntityService.packMany.mock.calls[0][0] as Array<MiUser | string>;
		expect(packedUsersArg).toEqual(expect.arrayContaining([author, replyUser, renoteUser]));
		expect(packedUsersArg.every(u => typeof u === 'object')).toBe(true);

		const hint = packSpy.mock.calls[0][2]._hint_;
		expect(hint.channels.has('ch-missing')).toBe(true);
		expect(hint.channels.get('ch-missing')).toBeNull();
		expect(hint.channels.get('ch-1')).toBe(channelA);
		expect(hint.missingEmojiKeys).toBe(missingSet);
	});

	test('isVisibleForMe skips dead userBlockingCache lookup and uses followingsRepository.exists', async () => {
		const userBlockingCache = { fetch: vi.fn() };
		const userBlockedCache = { fetch: vi.fn().mockResolvedValue(new Set()) };
		const followingsRepository = {
			exists: vi.fn().mockResolvedValue(true),
			count: vi.fn(),
		};
		const service = createService({
			cacheService: { userBlockingCache, userBlockedCache },
			followingsRepository,
		});

		const visible = await service.isVisibleForMe(makeNote({ visibility: 'followers' }), 'viewer');

		expect(visible).toBe(true);
		expect(userBlockingCache.fetch).not.toHaveBeenCalled();
		expect(followingsRepository.exists).toHaveBeenCalledTimes(1);
		expect(followingsRepository.count).not.toHaveBeenCalled();
	});
});
