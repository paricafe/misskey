/*
 * SPDX-FileCopyrightText: Nya Candy and NyaOne
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, Inject } from '@nestjs/common';
import { In } from 'typeorm';
import * as mfm from 'mfm-js';
import type { MiUser, MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { MiNote } from '@/models/Note.js';
import type { InstancesRepository, MiDriveFile, NotesRepository, PollsRepository, PollVotesRepository, UsersRepository } from '@/models/_.js';
import { RelayService } from '@/core/RelayService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import NotesChart from '@/core/chart/charts/notes.js';
import PerUserNotesChart from '@/core/chart/charts/per-user-notes.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { bindThis } from '@/decorators.js';
import { MetaService } from '@/core/MetaService.js';
import { SearchService } from '@/core/SearchService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { IdService } from '@/core/IdService.js';
import { trackPromise } from '@/misc/promise-tracker.js';
import { extractMentions } from '@/misc/extract-mentions.js';
import { RemoteUserResolveService } from '@/core/RemoteUserResolveService.js';
import { extractHashtags } from "@/misc/extract-hashtags.js";
import { extractCustomEmojisFromMfm } from "@/misc/extract-custom-emojis-from-mfm.js";
import { UtilityService } from "@/core/UtilityService.js";
import { CustomEmojiService } from "@/core/CustomEmojiService.js";
import { DriveFileEntityService } from "@/core/entities/DriveFileEntityService.js";
import { awaitAll } from "@/misc/prelude/await-all.js";
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { extractUrlsForKeyWordCheck } from '@/misc/extract-urls-for-keyword-check.js';
import { normalizeTag } from '@/misc/normalize-tag.js';

export const MAX_NOTE_HISTORY_REVISIONS = 100;
export const MAX_NOTE_HISTORY_BYTES = 1024 * 1024;
export const NOTE_HISTORY_LIMIT_ERROR_ID = '8a2c5b6f-8e2b-4f1d-a5d9-f2b96c5b0d34';
// Shared with NoteCreateService so the inbox processor treats it as a rejected note.
export const NOTE_PROHIBITED_WORDS_ERROR_ID = '689ee33f-f97c-479a-ac49-1b9f8140af99';
export const NOTE_SENSITIVE_WORDS_ERROR_ID = '3f0e7c8a-5b2d-4c1e-9a6f-8d4b2e7c1a90';
export const NOTE_NOT_FOUND_ERROR_ID = '512d8fe8-453e-463c-bf87-5b795293dc0c';
export const NOTE_NO_CONTENT_ERROR_ID = '238ea885-ef3d-489f-8a93-76b4709c3b5e';

type Option = {
	updatedAt?: Date | null;
	text: string | null;
	files?: MiDriveFile[] | null;
	cw: string | null;
	apHashtags?: string[] | null;
	apEmojis?: string[] | null;
};

type PollSnapshot = {
	poll?: NonNullable<Packed<'Note'>['poll']>;
	votersCount?: number;
};

export type NoteUpdatePreparation = Readonly<{
	noteId: MiNote['id'];
	sourceHistory: MiNote['history'];
	sourceUpdatedAt: MiNote['updatedAt'];
	history: NonNullable<MiNote['history']>;
}>;

@Injectable()
export class NoteUpdateService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.pollVotesRepository)
		private pollVotesRepository: PollVotesRepository,

		private customEmojiService: CustomEmojiService,
		private driveFileEntityService: DriveFileEntityService,
		private userEntityService: UserEntityService,
		private noteEntityService: NoteEntityService,
		private globalEventService: GlobalEventService,
		private relayService: RelayService,
		private federatedInstanceService: FederatedInstanceService,
		private remoteUserResolveService: RemoteUserResolveService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
		private metaService: MetaService,
		private searchService: SearchService,
		private moderationLogService: ModerationLogService,
		private notesChart: NotesChart,
		private perUserNotesChart: PerUserNotesChart,
		private instanceChart: InstanceChart,
		private idService: IdService,
		private utilityService: UtilityService,
	) {}

	/**
	 * Update note
	 * @param user Note creator
	 * @param note Note to update
	 * @param data New note info
	 */
	async update(
		user: { id: MiUser['id']; uri: MiUser['uri']; host: MiUser['host']; isBot: MiUser['isBot']; },
		note: MiNote,
		data: Option,
		quiet = false,
		_updater?: MiUser,
	): Promise<MiNote> {
		if (!data.updatedAt) {
			throw new Error('update time is required');
		}
		const updatedAt = data.updatedAt;

		this.assertNoteOwner(user, note);

		if (this.isUpdateAlreadyApplied(note, updatedAt)) {
			return note;
		}

		const meta = await this.metaService.fetch();
		if (meta.prohibitedWords.length > 0 && this.utilityService.isKeyWordIncluded(
			this.utilityService.concatNoteContentsForKeyWordCheck({
				cw: data.cw,
				text: data.text,
				others: [...extractUrlsForKeyWordCheck(data.cw ?? ''), ...extractUrlsForKeyWordCheck(data.text ?? '')],
			}),
			meta.prohibitedWords,
		)) {
			throw new IdentifiableError(NOTE_PROHIBITED_WORDS_ERROR_ID, 'Note contains prohibited words');
		}
		// An edit cannot downgrade visibility: the note may already be in public timelines.
		const sensitiveWordsTarget = data.cw ?? data.text ?? '';
		if (
			user.host == null && note.visibility === 'public' && note.channelId == null && meta.sensitiveWords.length > 0 &&
			this.utilityService.isKeyWordIncluded([sensitiveWordsTarget, ...extractUrlsForKeyWordCheck(sensitiveWordsTarget)].join('\n'), meta.sensitiveWords)
		) {
			throw new IdentifiableError(NOTE_SENSITIVE_WORDS_ERROR_ID, 'Public note contains sensitive words');
		}

		let tags = data.apHashtags;
		let emojis = data.apEmojis;

		if (!tags || !emojis) {
			const tokens = (data.text ? mfm.parse(data.text)! : []);
			const cwTokens = data.cw ? mfm.parse(data.cw)! : [];
			const combinedTokens = tokens.concat(cwTokens);
			tags = data.apHashtags ?? extractHashtags(combinedTokens);
			emojis = data.apEmojis ?? extractCustomEmojisFromMfm(combinedTokens);
		}

		if (this.utilityService.isMediaSilencedHost(meta.mediaSilencedHosts, user.host)) emojis = [];
		tags = tags.filter(tag => Array.from(tag).length <= 128).splice(0, 32).map(tag => normalizeTag(tag));

		// Keep this transaction DB-local. ActivityPub actor, attachment, and emoji
		// resolution must be completed by the caller before entering it.
		const result = await this.notesRepository.manager.transaction(async transactionalEntityManager => {
			const transactionalNotesRepository = transactionalEntityManager.getRepository(MiNote);
			const lockedRow = await transactionalNotesRepository.findOne({
				where: { id: note.id },
				lock: { mode: 'pessimistic_write' },
			});
			if (lockedRow == null) {
				throw new IdentifiableError(NOTE_NOT_FOUND_ERROR_ID, 'note is not registered');
			}
			const lockedNote = await this.withHistory({ ...note, ...lockedRow }, transactionalNotesRepository);

			this.assertNoteOwner(user, lockedNote);
			if (this.isUpdateAlreadyApplied(lockedNote, updatedAt)) {
				return { updatedNote: lockedNote, changed: false };
			}

			const fileIds = data.files === undefined
				? [...lockedNote.fileIds]
				: data.files?.map(file => file.id) ?? [];
			if ((data.text == null || data.text.length === 0) && fileIds.length === 0) {
				throw new IdentifiableError(NOTE_NO_CONTENT_ERROR_ID, 'Note must have text or files');
			}

			const preparedUpdate = await this.prepareUpdate(user, lockedNote);
			const history = [...preparedUpdate.history];
			const newNote: MiNote = {
				...lockedNote,
				text: data.text,
				cw: data.cw,
				updatedAt,
				tags,
				emojis,
				fileIds,
				history,
			};

			await transactionalNotesRepository.update({ id: lockedNote.id }, {
				updatedAt,
				fileIds: newNote.fileIds,
				history,
				cw: data.cw,
				text: data.text,
				tags,
				emojis,
			});

			return { updatedNote: newNote, changed: true };
		});

		if (!result.changed) return result.updatedNote;

		const updatedNote = result.updatedNote;
		this.searchService.indexNote(updatedNote);

		if (!quiet) {
			this.globalEventService.publishNoteStream(updatedNote, 'updated', await awaitAll({
				fileIds: updatedNote.fileIds,
				files: this.driveFileEntityService.packManyByIds(updatedNote.fileIds),
				cw: updatedNote.cw,
				text: updatedNote.text ?? '',
				updatedAt: updatedNote.updatedAt!.toISOString(),
				tags: updatedNote.tags.length > 0 ? updatedNote.tags : undefined,
				emojis: updatedNote.userHost != null ? this.customEmojiService.populateEmojis(updatedNote.emojis, updatedNote.userHost) : undefined,
			}));

			if (this.userEntityService.isLocalUser(user) && !updatedNote.localOnly) {
				const content = this.apRendererService.addContext(
					this.apRendererService.renderUpdateNote(
						await this.apRendererService.renderNote(updatedNote, false), updatedNote,
					),
				);
				this.deliverToConcerned(user, updatedNote, content);
			}
		}

		return updatedNote;
	}

	isUpdateAlreadyApplied(
		note: Pick<MiNote, 'history' | 'updatedAt'>,
		updatedAt: Date,
	): boolean {
		return (note.updatedAt != null && updatedAt.getTime() <= note.updatedAt.getTime()) ||
			(note.history?.some(revision => revision.createdAt === updatedAt.toISOString()) ?? false);
	}

	/** The history column is not selected by default; load it for edit checks and snapshots. */
	async withHistory<T extends Pick<MiNote, 'id'>>(
		note: T,
		notesRepository: Pick<NotesRepository, 'findOne'> = this.notesRepository,
	): Promise<T & Pick<MiNote, 'history'>> {
		const row = await notesRepository.findOne({ where: { id: note.id }, select: { id: true, history: true } });
		return { ...note, history: row?.history ?? null };
	}

	async prepareUpdate(
		user: { id: MiUser['id'] },
		note: MiNote,
	): Promise<NoteUpdatePreparation> {
		this.assertNoteOwner(user, note);
		const oldRevision = await this.snapshotRevision(user, note);
		const history = [...(note.history || []), oldRevision];
		if (
			history.length > MAX_NOTE_HISTORY_REVISIONS ||
			Buffer.byteLength(JSON.stringify(history), 'utf8') > MAX_NOTE_HISTORY_BYTES
		) {
			throw new IdentifiableError(NOTE_HISTORY_LIMIT_ERROR_ID, 'Note edit history limit exceeded.');
		}

		return {
			noteId: note.id,
			sourceHistory: note.history,
			sourceUpdatedAt: note.updatedAt,
			history,
		};
	}

	private assertNoteOwner(user: { id: MiUser['id'] }, note: Pick<MiNote, 'userId'>): void {
		if (user.id !== note.userId) {
			throw new Error('note author does not match the cached note owner');
		}
	}

	private async snapshotRevision(
		user: { id: MiUser['id'] },
		note: MiNote,
	): Promise<NonNullable<MiNote['history']>[number]> {
		const [packed, pollSnapshot] = await Promise.all([
			this.noteEntityService.pack(note, user, {
				detail: false,
				skipHide: true,
			}),
			this.snapshotPoll(note),
		]);
		const files = (packed.files ?? []).map(file => ({
			...file,
			properties: { ...file.properties },
		}));
		const emojiUrls = packed.emojis == null && note.userHost == null
			? this.snapshotLocalEmojiUrls(note.emojis, await this.customEmojiService.localEmojisCache.fetch())
			: { ...(packed.emojis ?? {}) };

		return {
			createdAt: (note.updatedAt || this.idService.parse(note.id).date).toISOString(),
			cw: note.cw,
			text: note.text,
			fileIds: [...note.fileIds],
			files,
			sensitive: files.some(file => file.isSensitive) || packed.channel?.isSensitive === true,
			emojis: [...note.emojis],
			emojiUrls,
			...(pollSnapshot.poll == null ? {} : { poll: pollSnapshot.poll }),
			...(pollSnapshot.votersCount == null ? {} : { pollVotersCount: pollSnapshot.votersCount }),
			renoteId: note.renoteId,
		};
	}

	private snapshotLocalEmojiUrls(
		names: readonly string[],
		localEmojis: ReadonlyMap<string, { publicUrl: string; originalUrl: string }>,
	): Record<string, string> {
		return Object.fromEntries(names.flatMap(name => {
			const emoji = localEmojis.get(name);
			const url = emoji?.publicUrl || emoji?.originalUrl;
			return url == null ? [] : [[name, url]];
		}));
	}

	private async snapshotPoll(note: Pick<MiNote, 'id' | 'hasPoll'>): Promise<PollSnapshot> {
		if (!note.hasPoll) return {};

		const poll = await this.pollsRepository.findOneByOrFail({ noteId: note.id });
		const snapshot: PollSnapshot = {
			poll: {
				multiple: poll.multiple,
				expiresAt: poll.expiresAt?.toISOString() ?? null,
				choices: poll.choices.map((text, index) => ({
					text,
					votes: poll.votes[index] ?? 0,
					isVoted: false,
				})),
			},
		};

		if (poll.multiple) {
			const row = await this.pollVotesRepository.createQueryBuilder('vote')
				.select('COUNT(DISTINCT vote."userId")', 'count')
				.where('vote."noteId" = :noteId', { noteId: note.id })
				.getRawOne<{ count: number | string }>();
			const votersCount = Number(row?.count ?? 0);
			if (Number.isSafeInteger(votersCount) && votersCount >= 0) {
				snapshot.votersCount = votersCount;
			}
		}

		return snapshot;
	}

	@bindThis
	private async extractMentionedUsers(user: { host: MiUser['host']; }, tokens: mfm.MfmNode[]): Promise<MiUser[]> {
		if (tokens == null) return [];

		const mentions = [...new Map(extractMentions(tokens).map(mention => [mention.acct.toLowerCase(), mention])).values()];
		let mentionedUsers = (await Promise.all(mentions.map(m =>
			this.remoteUserResolveService.resolveUser(m.username, m.host ?? user.host).catch(() => null),
		))).filter(x => x != null) as MiUser[];

		// Drop duplicate users
		mentionedUsers = mentionedUsers.filter((u, i, self) =>
			i === self.findIndex(u2 => u.id === u2.id),
		);

		return mentionedUsers;
	}

	@bindThis
	private async deliverToConcerned(user: { id: MiLocalUser['id']; host: null; }, note: MiNote, noteActivity: any) {
		const dm = this.apDeliverManagerService.createDeliverManager(user, noteActivity);

		// Earlier edits may have delivered the note to users who are no longer mentioned.
		const tokens = [note, ...(note.history ?? [])].flatMap(revision =>
			[revision.text, revision.cw].flatMap(text => text ? mfm.parse(text) : []));
		const mentionedUsers = await this.extractMentionedUsers(user, tokens);

		// Users mentioned before this edit already have the note, so they need the Update too.
		const previouslyMentionedIds = note.mentions.filter(id => !mentionedUsers.some(u => u.id === id));
		if (previouslyMentionedIds.length > 0) {
			mentionedUsers.push(...await this.usersRepository.findBy({ id: In(previouslyMentionedIds) }));
		}

		if (note.visibility === 'specified') {
			if (note.visibleUserIds == null) throw new Error('invalid param');

			for (const u of note.visibleUserIds) {
				if (!mentionedUsers.some(x => x.id === u)) {
					mentionedUsers.push(await this.usersRepository.findOneByOrFail({ id: u }));
				}
			}
		}

		// メンションされたリモートユーザーに配送
		for (const u of mentionedUsers.filter(u => this.userEntityService.isRemoteUser(u))) {
			dm.addDirectRecipe(u as MiRemoteUser);
		}

		// The note is loaded without relations, so use the denormalized author columns.
		// 投稿がリプライかつリプライ先の投稿の投稿者がリモートユーザーなら配送
		if (note.replyUserId != null && note.replyUserHost != null) {
			const u = await this.usersRepository.findOneBy({ id: note.replyUserId });
			if (u && this.userEntityService.isRemoteUser(u)) dm.addDirectRecipe(u);
		}

		// 投稿がRenoteかつRenote元の投稿の投稿者がリモートユーザーなら配送
		if (note.renoteUserId != null && note.renoteUserHost != null) {
			const u = await this.usersRepository.findOneBy({ id: note.renoteUserId });
			if (u && this.userEntityService.isRemoteUser(u)) dm.addDirectRecipe(u);
		}

		// フォロワーに配送
		if (['public', 'home', 'followers'].includes(note.visibility)) {
			dm.addFollowersRecipe();
		}

		if (['public'].includes(note.visibility)) {
			this.relayService.deliverToRelays(user, noteActivity);
		}

		trackPromise(dm.execute());
	}
}
