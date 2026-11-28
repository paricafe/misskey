/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { EntityNotFoundError, In } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import { DI } from '@/di-symbols.js';
import type { Packed } from '@/misc/json-schema.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import type { MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { MiPoll } from '@/models/Poll.js';
import type { MiPollVote } from '@/models/PollVote.js';
import type { MiChannel, UsersRepository, NotesRepository, FollowingsRepository, PollsRepository, PollVotesRepository, NoteReactionsRepository, ChannelsRepository, MiMeta } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { DebounceLoader } from '@/misc/loader.js';
import { IdService } from '@/core/IdService.js';
import { shouldHideNoteByTime } from '@/misc/should-hide-note-by-time.js';
import { isQuotePacked, isRenotePacked } from '@/misc/is-renote.js';
import { ReactionsBufferingService } from '@/core/ReactionsBufferingService.js';
import type { BufferedReactions } from '@/core/ReactionsBufferingService.js';
import { CacheService } from '@/core/CacheService.js';
import type { OnModuleInit } from '@nestjs/common';
import type { CustomEmojiService } from '../CustomEmojiService.js';
import type { ReactionService } from '../ReactionService.js';
import type { UserEntityService } from './UserEntityService.js';
import type { DriveFileEntityService } from './DriveFileEntityService.js';

function isPureRenote(note: MiNote): note is MiNote & { renoteId: MiNote['id']; renote: MiNote } {
	return (
		note.renote != null &&
		note.reply == null &&
		note.text == null &&
		note.cw == null &&
		(note.fileIds == null || note.fileIds.length === 0) &&
		!note.hasPoll
	);
}

function getAppearNoteIds(notes: MiNote[]): Set<string> {
	const ids = new Set<string>();

	function visit(note: MiNote) {
		if (ids.has(note.id)) return;
		ids.add(note.id);
		if (note.reply) visit(note.reply);
		if (note.renote) visit(note.renote);
	}

	for (const note of notes) visit(note);
	return ids;
}

async function nullIfEntityNotFound<T>(promise: Promise<T>): Promise<T | null> {
	try {
		return await promise;
	} catch (err) {
		if (err instanceof EntityNotFoundError) {
			return null;
		}
		throw err;
	}
}

type PendingMyReactionWaiter = {
	resolve: (value: string | undefined) => void;
	reject: (error: unknown) => void;
};

@Injectable()
export class NoteEntityService implements OnModuleInit {
	private userEntityService: UserEntityService;
	private driveFileEntityService: DriveFileEntityService;
	private cacheService: CacheService;
	private customEmojiService: CustomEmojiService;
	private reactionService: ReactionService;
	private reactionsBufferingService: ReactionsBufferingService;
	private idService: IdService;
	private noteLoader = new DebounceLoader(this.findNoteOrFail);
	#pendingMyReactionBatches = new Map<MiNote['id'], Map<MiUser['id'], PendingMyReactionWaiter[]>>();

	constructor(
		private moduleRef: ModuleRef,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.pollVotesRepository)
		private pollVotesRepository: PollVotesRepository,

		@Inject(DI.noteReactionsRepository)
		private noteReactionsRepository: NoteReactionsRepository,

		@Inject(DI.channelsRepository)
		private channelsRepository: ChannelsRepository,

	) {
	}

	onModuleInit() {
		this.userEntityService = this.moduleRef.get('UserEntityService');
		this.driveFileEntityService = this.moduleRef.get('DriveFileEntityService');
		this.cacheService = this.moduleRef.get('CacheService');
		this.customEmojiService = this.moduleRef.get('CustomEmojiService');
		this.reactionService = this.moduleRef.get('ReactionService');
		this.reactionsBufferingService = this.moduleRef.get('ReactionsBufferingService');
		this.idService = this.moduleRef.get('IdService');
		this.cacheService = this.moduleRef.get('CacheService');
	}

	@bindThis
	private treatVisibility(packedNote: Packed<'Note'>): Packed<'Note'>['visibility'] {
		if (packedNote.visibility === 'public' || packedNote.visibility === 'home') {
			const followersOnlyBefore = packedNote.user.makeNotesFollowersOnlyBefore;
			if (shouldHideNoteByTime(followersOnlyBefore, packedNote.createdAt)) {
				packedNote.visibility = 'followers';
			}
		}
		return packedNote.visibility;
	}

	@bindThis
	public async shouldHideNote(packedNote: Packed<'Note'>, meId: MiUser['id'] | null): Promise<boolean> {
		if (meId === packedNote.userId) return false;

		if (meId == null && this.meta.ugcVisibilityForVisitor === 'none') return true;

		if (packedNote.user.requireSigninToViewContents && meId == null) {
			return true;
		}

		const hiddenBefore = packedNote.user.makeNotesHiddenBefore;
		if (shouldHideNoteByTime(hiddenBefore, packedNote.createdAt)) {
			return true;
		}

		if (packedNote.visibility === 'specified') {
			if (meId == null) {
				return true;
			} else {
				const specified = packedNote.visibleUserIds!.some(id => meId === id);

				if (!specified) {
					return true;
				}
			}
		}

		if (packedNote.visibility === 'followers') {
			if (meId == null) {
				return true;
			} else if (packedNote.reply && (meId === packedNote.reply.userId)) {
				return false;
			} else if (packedNote.mentions && packedNote.mentions.some(id => meId === id)) {
				return false;
			} else {
				const followings = await this.cacheService.userFollowingsCache.fetch(meId);
				if (!Object.hasOwn(followings, packedNote.userId)) {
					return true;
				}
			}
		}

		return false;
	}

	@bindThis
	public hideNote(packedNote: Packed<'Note'>): void {
		packedNote.visibleUserIds = undefined;
		packedNote.fileIds = [];
		packedNote.files = [];
		packedNote.text = null;
		packedNote.poll = undefined;
		packedNote.cw = null;
		packedNote.history = undefined;
		packedNote.isHidden = true;
	}

	@bindThis
	private async populatePoll(note: Pick<MiNote, 'id'>, meId: MiUser['id'] | null, _hint_?: {
		polls?: Map<MiNote['id'], MiPoll>;
		myVotes?: Map<MiNote['id'], MiPollVote[]>;
	}) {
		const poll = _hint_?.polls?.get(note.id) ?? await this.pollsRepository.findOneByOrFail({ noteId: note.id });
		const choices = poll.choices.map((c, i) => ({
			text: c,
			votes: poll.votes[i],
			isVoted: false,
		}));

		if (meId) {
			const prefetchedVotes = _hint_?.myVotes?.get(note.id);
			if (prefetchedVotes != null) {
				for (const vote of poll.multiple ? prefetchedVotes : prefetchedVotes.slice(0, 1)) {
					choices[vote.choice].isVoted = true;
				}
			} else if (poll.multiple) {
				const votes = await this.pollVotesRepository.findBy({
					userId: meId,
					noteId: note.id,
				});

				const myChoices = votes.map(v => v.choice);
				for (const myChoice of myChoices) {
					choices[myChoice].isVoted = true;
				}
			} else {
				const vote = await this.pollVotesRepository.findOneBy({
					userId: meId,
					noteId: note.id,
				});

				if (vote) {
					choices[vote.choice].isVoted = true;
				}
			}
		}

		return {
			multiple: poll.multiple,
			expiresAt: poll.expiresAt?.toISOString() ?? null,
			choices,
		};
	}

	@bindThis
	public async withMyPollVotes(note: Packed<'Note'>, meId: MiUser['id'] | null): Promise<Packed<'Note'>> {
		const [poll, renote, reply] = await Promise.all([
			note.poll ? this.populatePoll(note, meId) : note.poll,
			note.renote ? this.withMyPollVotes(note.renote, meId) : note.renote,
			note.reply ? this.withMyPollVotes(note.reply, meId) : note.reply,
		]);

		if (poll === note.poll && renote === note.renote && reply === note.reply) return note;

		return { ...note, poll, renote, reply };
	}

	#loadMyReactionBatched(noteId: MiNote['id'], meId: MiUser['id']): Promise<string | undefined> {
		let byUser = this.#pendingMyReactionBatches.get(noteId);
		const shouldSchedule = byUser == null;
		if (byUser == null) {
			byUser = new Map();
			this.#pendingMyReactionBatches.set(noteId, byUser);
		}

		let waiters = byUser.get(meId);
		if (waiters == null) {
			waiters = [];
			byUser.set(meId, waiters);
		}

		const promise = new Promise<string | undefined>((resolve, reject) => {
			waiters.push({ resolve, reject });
		});

		if (shouldSchedule) {
			queueMicrotask(() => {
				void this.#flushMyReactionBatch(noteId);
			});
		}

		return promise;
	}

	async #flushMyReactionBatch(noteId: MiNote['id']): Promise<void> {
		const byUser = this.#pendingMyReactionBatches.get(noteId);
		if (byUser == null) return;
		this.#pendingMyReactionBatches.delete(noteId);

		const userIds = [...byUser.keys()];
		try {
			if (userIds.length === 1) {
				const userId = userIds[0];
				const reaction = await this.noteReactionsRepository.findOneBy({
					userId,
					noteId,
				});
				const converted = reaction ? this.reactionService.convertLegacyReaction(reaction.reaction) : undefined;
				for (const waiter of byUser.get(userId)!) {
					waiter.resolve(converted);
				}
				return;
			}

			const reactions = await this.noteReactionsRepository.findBy({
				noteId,
				userId: In(userIds),
			});
			const reactionsByUserId = new Map<MiUser['id'], string>();
			for (const reaction of reactions) {
				reactionsByUserId.set(reaction.userId, this.reactionService.convertLegacyReaction(reaction.reaction));
			}
			for (const [userId, waiters] of byUser) {
				const converted = reactionsByUserId.get(userId);
				for (const waiter of waiters) {
					waiter.resolve(converted);
				}
			}
		} catch (error) {
			for (const waiters of byUser.values()) {
				for (const waiter of waiters) {
					waiter.reject(error);
				}
			}
		}
	}

	@bindThis
	public async populateMyReaction(note: { id: MiNote['id']; reactions: MiNote['reactions']; reactionAndUserPairCache?: MiNote['reactionAndUserPairCache']; }, meId: MiUser['id'], _hint_?: {
		myReactions: Map<MiNote['id'], string | null>;
	}) {
		if (_hint_?.myReactions.has(note.id)) {
			const reaction = _hint_.myReactions.get(note.id);
			if (reaction) {
				return this.reactionService.convertLegacyReaction(reaction);
			} else {
				return undefined;
			}
		}

		const reactionsCount = Object.values(note.reactions).reduce((a, b) => a + b, 0);
		if (reactionsCount === 0) return undefined;
		if (note.reactionAndUserPairCache && reactionsCount <= note.reactionAndUserPairCache.length) {
			const pair = note.reactionAndUserPairCache.find(p => p.startsWith(meId));
			if (pair) {
				return this.reactionService.convertLegacyReaction(pair.split('/')[1]);
			} else {
				return undefined;
			}
		}

		if (this.idService.parse(note.id).date.getTime() + 2000 > Date.now()) {
			return undefined;
		}

		return await this.#loadMyReactionBatched(note.id, meId);
	}

	@bindThis
	public async withMyRenoteReaction(note: Packed<'Note'>, meId: MiUser['id'] | null): Promise<Packed<'Note'>> {
		if (meId == null) return note;
		if (!isRenotePacked(note) || isQuotePacked(note)) return note;
		if (note.renote == null || Object.keys(note.renote.reactions).length === 0) return note;

		const myReaction = await this.populateMyReaction(note.renote, meId);

		return {
			...note,
			renote: {
				...note.renote,
				myReaction,
			},
		};
	}

	@bindThis
	public async isVisibleForMe(note: MiNote, meId: MiUser['id'] | null): Promise<boolean> {
		if (note.visibility === 'specified') {
			if (meId == null) {
				return false;
			} else if (meId === note.userId) {
				return true;
			} else {
				return note.visibleUserIds.some(id => meId === id);
			}
		}

		if (note.visibility === 'followers') {
			if (meId == null) {
				return false;
			} else if (meId === note.userId) {
				return true;
			} else if (note.replyUserId && (meId === note.replyUserId)) {
				return true;
			} else if (note.mentions && note.mentions.some(id => meId === id)) {
				return true;
			} else {
				const [isFollowing, user] = await Promise.all([
					this.followingsRepository.exists({
						where: {
							followeeId: note.userId,
							followerId: meId,
						},
					}),
					this.usersRepository.findOneByOrFail({ id: meId }),
				]);

				return isFollowing || (note.userHost != null && user.host != null);
			}
		}

		if (meId != null) {
			const isBlocked = (await this.cacheService.userBlockedCache.fetch(meId)).has(note.userId);

			if (isBlocked) return false;
		}

		return true;
	}

	@bindThis
	public async packAttachedFiles(fileIds: MiNote['fileIds'], packedFiles: Map<MiNote['fileIds'][number], Packed<'DriveFile'> | null>): Promise<Packed<'DriveFile'>[]> {
		const missingIds = [];
		for (const id of fileIds) {
			if (!packedFiles.has(id)) missingIds.push(id);
		}
		if (missingIds.length) {
			const additionalMap = await this.driveFileEntityService.packManyByIdsMap(missingIds);
			for (const [k, v] of additionalMap) {
				packedFiles.set(k, v);
			}
		}
		return fileIds.map(id => packedFiles.get(id)).filter(x => x != null);
	}

	@bindThis
	public async pack(
		src: MiNote['id'] | MiNote,
		me?: { id: MiUser['id'] } | null | undefined,
		options?: {
			detail?: boolean;
			skipHide?: boolean;
			withReactionAndUserPairCache?: boolean;
			withHistory?: boolean;
			_hint_?: {
				bufferedReactions: Map<MiNote['id'], BufferedReactions> | null;
				myReactions: Map<MiNote['id'], string | null>;
				packedFiles: Map<MiNote['fileIds'][number], Packed<'DriveFile'> | null>;
				packedUsers: Map<MiUser['id'], Packed<'UserLite'>>;
				polls?: Map<MiNote['id'], MiPoll>;
				myVotes?: Map<MiNote['id'], MiPollVote[]>;
				channels?: Map<MiChannel['id'], MiChannel | null>;
				missingEmojiKeys?: ReadonlySet<string>;
			};
		},
	): Promise<Packed<'Note'>> {
		const opts = Object.assign({
			detail: true,
			skipHide: false,
			withReactionAndUserPairCache: false,
		}, options);

		const meId = me ? me.id : null;
		const note = typeof src === 'object' ? src : await this.noteLoader.load(src);
		const host = note.userHost;

		const bufferedReactions = opts._hint_?.bufferedReactions?.get(note.id)
			?? (this.meta.enableReactionsBuffering ? await this.reactionsBufferingService.get(note.id) : undefined);
		const deltas = bufferedReactions ? this.reactionsBufferingService.getDeltas(note, bufferedReactions) : {};
		const reactions = this.reactionService.convertLegacyReactions(this.reactionsBufferingService.mergeReactions(note.reactions, deltas));
		const reactionAndUserPairCache = bufferedReactions
			? this.reactionsBufferingService.getPairs(note, bufferedReactions)
			: note.reactionAndUserPairCache;

		let text = note.text;

		if (note.name && (note.url ?? note.uri)) {
			text = `【${note.name}】\n${(note.text ?? '').trim()}\n\n${note.url ?? note.uri}`;
		}

		const channel = note.channelId
			? note.channel
				? note.channel
				: opts._hint_?.channels?.has(note.channelId)
					? (opts._hint_.channels.get(note.channelId) ?? null)
					: await this.channelsRepository.findOneBy({ id: note.channelId })
			: null;

		const reactionEmojiNames = Object.keys(reactions)
			.filter(x => x.startsWith(':') && x.includes('@') && !x.includes('@.'))
			.map(x => this.reactionService.decodeReaction(x).reaction.replaceAll(':', ''));
		const packedFiles = options?._hint_?.packedFiles;
		const packedUsers = options?._hint_?.packedUsers;
		const missingEmojiKeys = options?._hint_?.missingEmojiKeys;

		const packed: Packed<'Note'> = await awaitAll({
			id: note.id,
			createdAt: this.idService.parse(note.id).date.toISOString(),
			updatedAt: note.updatedAt?.toISOString(),
			history: opts.withHistory
				? this.notesRepository.findOne({ where: { id: note.id }, select: { id: true, history: true } }).then(row => row?.history ?? null)
				: undefined,
			userId: note.userId,
			user: packedUsers?.get(note.userId) ?? this.userEntityService.pack(note.user ?? note.userId, me),
			text: text,
			cw: note.cw,
			visibility: note.visibility,
			localOnly: note.localOnly,
			reactionAcceptance: note.reactionAcceptance,
			visibleUserIds: note.visibility === 'specified' ? note.visibleUserIds : undefined,
			renoteCount: note.renoteCount,
			repliesCount: note.repliesCount,
			reactionCount: Object.values(reactions).reduce((a, b) => a + b, 0),
			reactions: reactions,
			reactionEmojis: missingEmojiKeys && missingEmojiKeys.size > 0
				? this.customEmojiService.populateEmojis(reactionEmojiNames, host, missingEmojiKeys)
				: this.customEmojiService.populateEmojis(reactionEmojiNames, host),
			reactionAndUserPairCache: opts.withReactionAndUserPairCache ? reactionAndUserPairCache : undefined,
			emojis: host != null
				? (missingEmojiKeys && missingEmojiKeys.size > 0
					? this.customEmojiService.populateEmojis(note.emojis, host, missingEmojiKeys)
					: this.customEmojiService.populateEmojis(note.emojis, host))
				: undefined,
			tags: note.tags.length > 0 ? note.tags : undefined,
			fileIds: note.fileIds,
			files: packedFiles != null ? this.packAttachedFiles(note.fileIds, packedFiles) : this.driveFileEntityService.packManyByIds(note.fileIds),
			replyId: note.replyId,
			renoteId: note.renoteId,
			channelId: note.channelId ?? undefined,
			channel: channel ? {
				id: channel.id,
				name: channel.name,
				color: channel.color,
				isSensitive: channel.isSensitive,
				allowRenoteToExternal: channel.allowRenoteToExternal,
				userId: channel.userId,
			} : undefined,
			mentions: note.mentions.length > 0 ? note.mentions : undefined,
			hasPoll: note.hasPoll || undefined,
			uri: note.uri ?? undefined,
			url: note.url ?? undefined,

			...(opts.detail ? {
				clippedCount: note.clippedCount,

				reply: (note.replyId && note.reply === null) ? null : note.replyId ? nullIfEntityNotFound(this.pack(note.reply ?? note.replyId, me, {
					detail: false,
					skipHide: opts.skipHide,
					withReactionAndUserPairCache: opts.withReactionAndUserPairCache,
					_hint_: options?._hint_,
				})) : undefined,

				renote: (note.renoteId && note.renote === null) ? null : note.renoteId ? nullIfEntityNotFound(this.pack(note.renote ?? note.renoteId, me, {
					detail: true,
					skipHide: opts.skipHide,
					withReactionAndUserPairCache: opts.withReactionAndUserPairCache,
					_hint_: options?._hint_,
				})) : undefined,

				poll: note.hasPoll ? this.populatePoll(note, meId, options?._hint_) : undefined,

				...(meId && Object.keys(reactions).length > 0 ? {
					myReaction: this.populateMyReaction({
						id: note.id,
						reactions: reactions,
						reactionAndUserPairCache: reactionAndUserPairCache,
					}, meId, options?._hint_),
				} : {}),
			} : {}),
		});

		this.treatVisibility(packed);

		if (!opts.skipHide && (await this.shouldHideNote(packed, meId))) {
			this.hideNote(packed);
		}

		return packed;
	}

	@bindThis
	public async packMany(
		notes: MiNote[],
		me?: { id: MiUser['id'] } | null | undefined,
		options?: {
			detail?: boolean;
			skipHide?: boolean;
			polls?: MiPoll[];
		},
	) {
		if (notes.length === 0) return [];

		const bufferedReactions = this.meta.enableReactionsBuffering ? await this.reactionsBufferingService.getMany([...getAppearNoteIds(notes)]) : null;

		const meId = me ? me.id : null;
		const polls = new Map(options?.polls?.map(poll => [poll.noteId, poll]));
		const myVotes = new Map<MiNote['id'], MiPollVote[]>();
		if (options?.detail !== false) {
			const pollNoteIds = new Set<MiNote['id']>();
			const visited = new Set<MiNote['id']>();
			for (const root of notes) {
				let note: MiNote | null = root;
				while (note != null && !visited.has(note.id)) {
					visited.add(note.id);
					if (note.hasPoll) pollNoteIds.add(note.id);
					note = note.renote;
				}
			}

			const missingPollIds = [...pollNoteIds].filter(id => !polls.has(id));
			const [fetchedPolls, votes] = await Promise.all([
				missingPollIds.length > 0 ? this.pollsRepository.findBy({ noteId: In(missingPollIds) }) : [],
				meId && pollNoteIds.size > 0 ? this.pollVotesRepository.findBy({ userId: meId, noteId: In([...pollNoteIds]) }) : [],
			]);
			for (const poll of fetchedPolls) polls.set(poll.noteId, poll);
			if (meId) {
				for (const id of pollNoteIds) myVotes.set(id, []);
				for (const vote of votes) myVotes.get(vote.noteId)!.push(vote);
			}
		}

		const myReactionsMap = new Map<MiNote['id'], string | null>();
		if (meId) {
			const idsNeedFetchMyReaction = new Set<MiNote['id']>();

			const oldId = this.idService.gen(Date.now() - 2000);

			const reactionNotes: MiNote[] = [];
			const visited = new Set<MiNote['id']>();
			for (const root of notes) {
				let note: MiNote | null = root;
				while (note != null && !visited.has(note.id)) {
					visited.add(note.id);
					if (note === root && !isPureRenote(note) && note.id >= oldId) {
						myReactionsMap.set(note.id, null);
					} else if (!isPureRenote(note)) {
						reactionNotes.push(note);
					}
					note = note.renote;
				}
			}

			for (const reactionNote of reactionNotes) {
				const buffered = bufferedReactions?.get(reactionNote.id);
				const deltas = buffered ? this.reactionsBufferingService.getDeltas(reactionNote, buffered) : {};
				const reactionsCount = Object.values(this.reactionsBufferingService.mergeReactions(reactionNote.reactions, deltas)).reduce((a, b) => a + b, 0);
				const pairs = buffered ? this.reactionsBufferingService.getPairs(reactionNote, buffered) : reactionNote.reactionAndUserPairCache;
				if (reactionsCount === 0) {
					myReactionsMap.set(reactionNote.id, null);
				} else if (reactionsCount <= pairs.length) {
					const pair = pairs.find(p => p.startsWith(meId + '/'));
					myReactionsMap.set(reactionNote.id, pair ? pair.split('/')[1] : null);
				} else {
					idsNeedFetchMyReaction.add(reactionNote.id);
				}
			}

			const myReactions = idsNeedFetchMyReaction.size > 0 ? await this.noteReactionsRepository.findBy({
				userId: meId,
				noteId: In(Array.from(idsNeedFetchMyReaction)),
			}) : [];
			const myReactionsByNoteId = new Map(myReactions.map(reaction => [reaction.noteId, reaction.reaction]));

			for (const id of idsNeedFetchMyReaction) {
				myReactionsMap.set(id, myReactionsByNoteId.get(id) ?? null);
			}
		}

		const missingChannelIds = new Set<MiChannel['id']>();
		const usersById = new Map<MiUser['id'], MiUser | MiUser['id']>();
		const addUser = (user: MiUser | null | undefined, userId: MiUser['id'] | null | undefined) => {
			if (user != null) {
				usersById.set(user.id, user);
			} else if (userId != null && !usersById.has(userId)) {
				usersById.set(userId, userId);
			}
		};
		const visitedForMeta = new Map<MiNote['id'], boolean>();
		const collectNoteMeta = (note: MiNote, includeNested: boolean) => {
			const prev = visitedForMeta.get(note.id);
			if (prev === true || (prev === false && !includeNested)) return;
			visitedForMeta.set(note.id, includeNested);
			if (prev == null) {
				addUser(note.user, note.userId);
				if (note.channelId != null && note.channel == null) {
					missingChannelIds.add(note.channelId);
				}
			}
			if (includeNested) {
				if (note.reply != null) {
					collectNoteMeta(note.reply, false);
				} else if (note.replyUserId != null) {
					addUser(null, note.replyUserId);
				}
				if (note.renote != null) {
					collectNoteMeta(note.renote, true);
				} else if (note.renoteUserId != null) {
					addUser(null, note.renoteUserId);
				}
			}
		};
		const includeNested = options?.detail !== false;
		for (const note of notes) {
			collectNoteMeta(note, includeNested);
		}

		const channels = new Map<MiChannel['id'], MiChannel | null>();
		if (missingChannelIds.size > 0) {
			const fetchedChannels = await this.channelsRepository.findBy({
				id: In([...missingChannelIds]),
			});
			for (const id of missingChannelIds) channels.set(id, null);
			for (const channel of fetchedChannels) channels.set(channel.id, channel);
		}

		const missingEmojiKeys = await this.customEmojiService.prefetchEmojis(
			this.aggregateNoteEmojis(notes, bufferedReactions, includeNested),
		);
		const fileIds = notes.map(n => [n.fileIds, n.renote?.fileIds, n.reply?.fileIds]).flat(2).filter(x => x != null);
		const packedFiles = fileIds.length > 0 ? await this.driveFileEntityService.packManyByIdsMap(fileIds) : new Map();
		const users = [...usersById.values()];
		const packedUsers = await this.userEntityService.packMany(users, me)
			.then(users => new Map(users.map(u => [u.id, u])));

		return await Promise.all(notes.map(n => this.pack(n, me, {
			...options,
			_hint_: {
				bufferedReactions,
				myReactions: myReactionsMap,
				packedFiles,
				packedUsers,
				polls,
				myVotes,
				channels,
				missingEmojiKeys: missingEmojiKeys ?? undefined,
			},
		})));
	}

	@bindThis
	public aggregateNoteEmojis(
		notes: MiNote[],
		bufferedReactions?: Map<MiNote['id'], BufferedReactions> | null,
		includeNested = true,
	) {
		const emojis: { name: string; host: string; }[] = [];
		const visited = new Map<MiNote['id'], boolean>();

		const pushParsed = (emojiNames: string[] | undefined, host: string | null) => {
			if (emojiNames == null || emojiNames.length === 0) return;
			for (const e of emojiNames) {
				const parsed = this.customEmojiService.parseEmojiStr(e, host);
				if (parsed.name != null && parsed.host != null) {
					emojis.push({ name: parsed.name, host: parsed.host });
				}
			}
		};

		const pushNoteReactions = (note: MiNote) => {
			const buffered = bufferedReactions?.get(note.id);
			const deltas = buffered ? this.reactionsBufferingService.getDeltas(note, buffered) : null;
			const merged = deltas ? this.reactionsBufferingService.mergeReactions(note.reactions, deltas) : note.reactions;
			for (const [reaction, count] of Object.entries(merged)) {
				if (count <= 0) continue;
				const decoded = this.reactionService.decodeReaction(reaction);
				if (decoded.name != null && decoded.host != null) {
					emojis.push({ name: decoded.name, host: decoded.host });
				}
			}
		};

		const visit = (note: MiNote, recurse: boolean) => {
			const prev = visited.get(note.id);
			if (prev === true || (prev === false && !recurse)) return;
			visited.set(note.id, recurse);

			if (prev == null) {
				pushParsed(note.emojis, note.userHost);
				pushNoteReactions(note);
				if (note.user) {
					pushParsed(note.user.emojis, note.userHost);
				}
			}

			if (recurse) {
				if (note.reply) visit(note.reply, false);
				if (note.renote) visit(note.renote, true);
			}
		};

		for (const note of notes) {
			visit(note, includeNested);
		}
		return emojis;
	}

	@bindThis
	private findNoteOrFail(id: string): Promise<MiNote> {
		return this.notesRepository.findOneOrFail({
			where: { id },
			relations: {
				user: true,
				renote: true,
				reply: true,
			},
		});
	}

	@bindThis
	public async fetchDiffs(noteIds: MiNote['id'][], meId: MiUser['id'] | null = null) {
		if (noteIds.length === 0) return [];
		if (meId == null && this.meta.ugcVisibilityForVisitor === 'none') return [];

		const fetched = await this.notesRepository.find({
			where: {
				id: In(noteIds),
			},
			select: {
				id: true,
				userId: true,
				userHost: true,
				visibility: true,
				visibleUserIds: true,
				mentions: true,
				replyUserId: true,
				reactions: true,
				lastReactionsBufferId: true,
				reactionAndUserPairCache: true,
				repliesCount: true,
				renoteCount: true,
			},
		});

		const notes: MiNote[] = [];
		for (const note of fetched) {
			if (await this.isVisibleForMe(note, meId)) {
				notes.push(note);
			}
		}

		const bufferedReactionsMap = this.meta.enableReactionsBuffering ? await this.reactionsBufferingService.getMany(noteIds) : null;

		const packings = notes.map(note => {
			const bufferedReactions = bufferedReactionsMap?.get(note.id);
			const deltas = bufferedReactions ? this.reactionsBufferingService.getDeltas(note, bufferedReactions) : {};
			const reactions = this.reactionService.convertLegacyReactions(this.reactionsBufferingService.mergeReactions(note.reactions, deltas));

			const reactionEmojiNames = Object.keys(reactions)
				.filter(x => x.startsWith(':') && x.includes('@') && !x.includes('@.'))
				.map(x => this.reactionService.decodeReaction(x).reaction.replaceAll(':', ''));

			return this.customEmojiService.populateEmojis(reactionEmojiNames, note.userHost).then(reactionEmojis => ({
				id: note.id,
				reactions,
				reactionEmojis,
				repliesCount: note.repliesCount,
				renoteCount: note.renoteCount,
			}));
		});

		return await Promise.all(packings);
	}
}
