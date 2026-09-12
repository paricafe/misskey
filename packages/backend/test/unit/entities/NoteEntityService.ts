/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { EntityNotFoundError, In } from 'typeorm';
import type { ModuleRef } from '@nestjs/core';
import type { ChannelsRepository, FollowingsRepository, MiMeta, MiNote, MiPoll, MiPollVote, NoteReactionsRepository, NotesRepository, PollsRepository, PollVotesRepository, UsersRepository } from '@/models/_.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { ReactionsBufferingService } from '@/core/ReactionsBufferingService.js';
import type { BufferedReactions } from '@/core/ReactionsBufferingService.js';

function note(id: string, data: Partial<MiNote> = {}): MiNote {
	return {
		id,
		userId: 'author',
		userHost: null,
		text: id,
		cw: null,
		visibility: 'public',
		fileIds: [],
		mentions: [],
		tags: [],
		emojis: [],
		reactions: {},
		reactionAndUserPairCache: [],
		hasPoll: true,
		...data,
	} as MiNote;
}

function poll(noteId: string, data: Partial<MiPoll> = {}): MiPoll {
	return { noteId, choices: ['one', 'two', 'three'], votes: [1, 3, 2], multiple: false, expiresAt: null, ...data } as MiPoll;
}

function vote(noteId: string, choice: number): MiPollVote {
	return { noteId, choice, userId: 'viewer' } as MiPollVote;
}

function setup(polls: MiPoll[] = [], votes: MiPollVote[] = [], buffers?: Map<string, BufferedReactions>) {
	const pollsRepository = {
		findBy: vi.fn(async ({ noteId }: { noteId: { value: string[] } }) => polls.filter(p => noteId.value.includes(p.noteId))),
		findOneByOrFail: vi.fn(async ({ noteId }: { noteId: string }) => {
			const found = polls.find(p => p.noteId === noteId);
			if (found == null) throw new EntityNotFoundError('MiPoll', { noteId });
			return found;
		}),
	};
	const pollVotesRepository = {
		findBy: vi.fn(async ({ noteId, userId }: { noteId: string | { value: string[] }; userId: string }) =>
			votes.filter(v => v.userId === userId && (typeof noteId === 'string' ? v.noteId === noteId : noteId.value.includes(v.noteId)))),
		findOneBy: vi.fn(async ({ noteId, userId }: { noteId: string; userId: string }) => votes.find(v => v.noteId === noteId && v.userId === userId) ?? null),
	};
	const notesRepository = { findOneOrFail: vi.fn(), find: vi.fn() };
	const buffering = Object.create(ReactionsBufferingService.prototype) as ReactionsBufferingService;
	Object.defineProperties(buffering, {
		get: { value: vi.fn(async (id: string) => buffers!.get(id)!) },
		getMany: { value: vi.fn(async () => buffers!) },
	});
	const services: Record<string, unknown> = {
		UserEntityService: {
			pack: vi.fn(async (id: string) => ({ id })),
			packMany: vi.fn(async (ids: string[]) => ids.map(id => ({ id }))),
		},
		DriveFileEntityService: { packManyByIds: vi.fn(async () => []) },
		CacheService: {},
		CustomEmojiService: {
			prefetchEmojis: vi.fn(async () => undefined),
			populateEmojis: vi.fn(async () => ({})),
		},
		ReactionService: {
			convertLegacyReactions: (reactions: Record<string, number>) => reactions,
			convertLegacyReaction: (reaction: string) => reaction,
			decodeReaction: (reaction: string) => ({ reaction }),
		},
		ReactionsBufferingService: buffering,
		IdService: { parse: () => ({ date: new Date(0) }), gen: () => 'zzz' },
	};
	const service = new NoteEntityService(
		{ get: (name: string) => services[name] } as ModuleRef,
		{ enableReactionsBuffering: buffers !== undefined } as MiMeta,
		{} as UsersRepository,
		notesRepository as unknown as NotesRepository,
		{} as FollowingsRepository,
		pollsRepository as unknown as PollsRepository,
		pollVotesRepository as unknown as PollVotesRepository,
		{} as NoteReactionsRepository,
		{} as ChannelsRepository,
	);
	service.onModuleInit();
	return { service, pollsRepository, pollVotesRepository, notesRepository };
}

const me = { id: 'viewer' };

describe('NoteEntityService poll packing', () => {
	test('batches polls and viewer votes, preserving single, multiple and unvoted choices', async () => {
		const fixtures = [poll('single'), poll('multiple', { multiple: true }), poll('unvoted')];
		const { service, pollsRepository, pollVotesRepository } = setup(fixtures, [vote('single', 1), vote('multiple', 0), vote('multiple', 2)]);
		const notes = fixtures.map(p => note(p.noteId));
		const packed = await service.packMany(notes, me);

		expect(packed.map(n => n.poll?.choices.map(c => c.isVoted))).toEqual([[false, true, false], [true, false, true], [false, false, false]]);
		expect(packed.map(n => n.poll?.choices.map(c => c.votes))).toEqual([[1, 3, 2], [1, 3, 2], [1, 3, 2]]);
		expect(pollsRepository.findBy).toHaveBeenCalledExactlyOnceWith({ noteId: In(['single', 'multiple', 'unvoted']) });
		expect(pollVotesRepository.findBy).toHaveBeenCalledExactlyOnceWith({ userId: me.id, noteId: In(['single', 'multiple', 'unvoted']) });
		expect(pollsRepository.findOneByOrFail).not.toHaveBeenCalled();
		expect(pollVotesRepository.findOneBy).not.toHaveBeenCalled();
		expect(packed).toEqual(await Promise.all(notes.map(n => service.pack(n, me))));
	});

	test('anonymous packing reads polls without reading any viewer votes', async () => {
		const { service, pollVotesRepository } = setup([poll('single')], [vote('single', 1)]);
		const [packed] = await service.packMany([note('single')]);

		expect(packed.poll?.choices.every(c => !c.isVoted)).toBe(true);
		expect(pollVotesRepository.findBy).not.toHaveBeenCalled();
		expect(pollVotesRepository.findOneBy).not.toHaveBeenCalled();
	});

	test('detail: false does not fetch or expose polls', async () => {
		const { service, pollsRepository, pollVotesRepository } = setup([poll('single')]);
		const [packed] = await service.packMany([note('single')], me, { detail: false });

		expect(packed.poll).toBeUndefined();
		expect(pollsRepository.findBy).not.toHaveBeenCalled();
		expect(pollsRepository.findOneByOrFail).not.toHaveBeenCalled();
		expect(pollVotesRepository.findBy).not.toHaveBeenCalled();
	});

	test('deduplicates loaded renote polls and leaves reply polls out of the batch', async () => {
		const inner = note('inner');
		const outer = note('outer', { hasPoll: false, renoteId: inner.id, renote: inner });
		const reply = note('reply');
		const root = note('root', { hasPoll: false, renoteId: outer.id, renote: outer, replyId: reply.id, reply });
		const { service, pollsRepository } = setup([poll(inner.id), poll(reply.id)]);
		const [packed] = await service.packMany([root, inner], me);

		expect(packed.renote?.renote?.poll?.choices).toHaveLength(3);
		expect(packed.reply?.hasPoll).toBe(true);
		expect(packed.reply?.poll).toBeUndefined();
		expect(pollsRepository.findBy).toHaveBeenCalledExactlyOnceWith({ noteId: In([inner.id]) });
		expect(pollsRepository.findOneByOrFail).not.toHaveBeenCalled();
	});

	test('an unloaded renote still fetches its poll and viewer vote', async () => {
		const inner = note('inner');
		const { service, pollsRepository, pollVotesRepository, notesRepository } = setup([poll(inner.id)], [vote(inner.id, 2)]);
		notesRepository.findOneOrFail.mockResolvedValue(inner);
		const [packed] = await service.packMany([note('root', { hasPoll: false, renoteId: inner.id })], me);

		expect(packed.renote?.poll?.choices[2].isVoted).toBe(true);
		expect(pollsRepository.findOneByOrFail).toHaveBeenCalledExactlyOnceWith({ noteId: inner.id });
		expect(pollVotesRepository.findOneBy).toHaveBeenCalledExactlyOnceWith({ noteId: inner.id, userId: me.id });
	});

	test('a missing poll keeps the existing entity-not-found failure', async () => {
		const { service, pollsRepository } = setup();
		await expect(service.packMany([note('missing')], me)).rejects.toBeInstanceOf(EntityNotFoundError);
		expect(pollsRepository.findOneByOrFail).toHaveBeenCalledExactlyOnceWith({ noteId: 'missing' });
	});

	test('hidden polls remain hidden and skipHide still includes their choices', async () => {
		const { service } = setup([poll('hidden')]);
		const hidden = note('hidden', { visibility: 'specified', visibleUserIds: [] });
		const [packed] = await service.packMany([hidden], me);
		const [unhidden] = await service.packMany([hidden], me, { skipHide: true });

		expect(packed.isHidden).toBe(true);
		expect(packed.poll).toBeUndefined();
		expect(unhidden.poll?.choices).toHaveLength(3);
	});

	test('reuses provided polls and fetches only missing polls', async () => {
		const preloaded = poll('loaded', { votes: [4, 5, 6] });
		const { service, pollsRepository } = setup([poll('missing')]);
		const packed = await service.packMany([note('loaded'), note('missing')], me, { polls: [preloaded] });

		expect(packed[0].poll?.choices.map(c => c.votes)).toEqual([4, 5, 6]);
		expect(pollsRepository.findBy).toHaveBeenCalledExactlyOnceWith({ noteId: In(['missing']) });
		expect(pollsRepository.findOneByOrFail).not.toHaveBeenCalled();
	});
});


describe('NoteEntityService buffered reaction checkpoints', () => {
	test.each([null, 'committed-batch'])('packs pending/live reactions once with database checkpoint %s', async checkpoint => {
		const buffered: BufferedReactions = {
			deltas: { like: -1, wow: 1 },
			pairs: [],
			pairChanges: new Map([['viewer', 'wow']]),
			pending: { id: 'committed-batch', deltas: { like: 1 }, pairs: [], changes: ['viewer', 'like'] },
		};
		const { service } = setup([], [], new Map([['buffered', buffered]]));
		const fixture = note('buffered', {
			hasPoll: false,
			reactions: checkpoint ? { like: 1 } : {},
			reactionAndUserPairCache: checkpoint ? ['viewer/like'] : [],
			lastReactionsBufferId: checkpoint,
		});
		const [packed] = await service.packMany([fixture], me);
		expect(packed.reactions).toEqual({ like: 0, wow: 1 });
		expect(packed.myReaction).toBe('wow');
	});

	test('diff reads load the checkpoint and exclude an already committed pending batch', async () => {
		const buffered: BufferedReactions = {
			deltas: { like: 1 }, pairs: [], pairChanges: new Map(),
			pending: { id: 'committed-batch', deltas: { like: 2 }, pairs: [], changes: [] },
		};
		const { service, notesRepository } = setup([], [], new Map([['buffered', buffered]]));
		const fixture = note('buffered', { hasPoll: false, reactions: { like: 2 }, lastReactionsBufferId: 'committed-batch' });
		notesRepository.find.mockImplementation(async ({ select }: { select: Record<string, boolean> }) => [
			Object.fromEntries(Object.entries(fixture).filter(([key]) => select[key])),
		]);
		const [diff] = await service.fetchDiffs(['buffered']);
		expect(diff.reactions).toEqual({ like: 3 });
	});
});
