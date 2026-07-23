/*
 * SPDX-FileCopyrightText: Nya Candy and NyaOne
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable, Inject } from '@nestjs/common';
import * as mfm from 'mfm-js';
import type { MiUser, MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
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

export const MAX_NOTE_HISTORY_REVISIONS = 100;
export const MAX_NOTE_HISTORY_BYTES = 1024 * 1024;
export const NOTE_HISTORY_LIMIT_ERROR_ID = '8a2c5b6f-8e2b-4f1d-a5d9-f2b96c5b0d34';

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
		updater?: MiUser,
		preparation?: NoteUpdatePreparation,
	): Promise<MiNote> {
		if (!data.updatedAt) {
			throw new Error('update time is required');
		}

		const fileIds = data.files === undefined
			? [...note.fileIds]
			: data.files?.map(file => file.id) ?? [];
		if ((data.text == null || data.text.length === 0) && fileIds.length === 0) {
			throw new Error('Note must have text or files');
		}

		if (this.isUpdateAlreadyApplied(note, data.updatedAt)) {
			// Same history already exists, skip this
			return note;
		}

		const preparedUpdate = preparation ?? await this.prepareUpdate(user, note);
		if (
			preparedUpdate.noteId !== note.id ||
			preparedUpdate.sourceHistory !== note.history ||
			preparedUpdate.sourceUpdatedAt !== note.updatedAt
		) {
			throw new Error('Prepared note update does not match the current note state');
		}
		const history = [...preparedUpdate.history];

		// Parse tags & emojis
		const meta = await this.metaService.fetch();

		let tags = data.apHashtags;
		let emojis = data.apEmojis;

		// Parse MFM if needed
		if (!tags || !emojis) {
			const tokens = (data.text ? mfm.parse(data.text)! : []);
			const cwTokens = data.cw ? mfm.parse(data.cw)! : [];
			// Not include poll data

			const combinedTokens = tokens.concat(cwTokens);

			tags = data.apHashtags ?? extractHashtags(combinedTokens);

			emojis = data.apEmojis ?? extractCustomEmojisFromMfm(combinedTokens);
		}

		// if the host is media-silenced, custom emojis are not allowed
		if (this.utilityService.isMediaSilencedHost(meta.mediaSilencedHosts, user.host)) emojis = [];

		tags = tags.filter(tag => Array.from(tag).length <= 128).splice(0, 32);

		const newNote: MiNote = {
			...note,

			// Overwrite updated fields
			text: data.text,
			cw: data.cw,
			updatedAt: data.updatedAt,
			tags,
			emojis,
			fileIds,
		};

		if (!quiet) {
			this.globalEventService.publishNoteStream(note, 'updated', await awaitAll({
				fileIds: newNote.fileIds,
				files: this.driveFileEntityService.packManyByIds(newNote.fileIds),
				cw: data.cw,
				text: data.text ?? '', // prevent null
				updatedAt: data.updatedAt.toISOString(),
				tags: tags.length > 0 ? tags : undefined,
				emojis: note.userHost != null ? this.customEmojiService.populateEmojis(emojis, note.userHost) : undefined,
			}));

			if (this.userEntityService.isLocalUser(user) && !note.localOnly) {
				const content = this.apRendererService.addContext(
					this.apRendererService.renderUpdateNote(
						await this.apRendererService.renderNote(newNote, false), newNote,
					),
				);

				this.deliverToConcerned(user, newNote, content);
			}
		}

		// Check if is latest or previous version
		let updatedNote: MiNote;
		if (note.updatedAt && note.updatedAt >= data.updatedAt) {
			// Previous version, just update history
			history.sort((h1, h2) => new Date(h1.createdAt).getTime() - new Date(h2.createdAt).getTime()); // earliest -> latest

			await this.notesRepository.update({ id: note.id }, {
				history,
			});
			updatedNote = { ...note, history };
		} else {
			// Latest version

			// Update index
			this.searchService.indexNote(newNote);

			// Update note info
			await this.notesRepository.update({ id: note.id }, {
				updatedAt: data.updatedAt,
				fileIds: newNote.fileIds,
				history,
				cw: data.cw,
				text: data.text,
				tags,
				emojis,
			});
			updatedNote = { ...newNote, history };
		}

		// Currently not implemented
		// if (updater && (note.userId !== updater.id)) {
		// 	const user = await this.usersRepository.findOneByOrFail({ id: note.userId });
		// 	this.moderationLogService.log(updater, 'updateNote', {
		// 		noteId: note.id,
		// 		noteUserId: note.userId,
		// 		noteUserUsername: user.username,
		// 		noteUserHost: user.host,
		// 		note: note,
		// 	});
		// }

		return updatedNote;
	}

	isUpdateAlreadyApplied(
		note: Pick<MiNote, 'history' | 'updatedAt'>,
		updatedAt: Date,
	): boolean {
		return note.updatedAt?.getTime() === updatedAt.getTime() ||
			(note.history?.some(revision => revision.createdAt === updatedAt.toISOString()) ?? false);
	}

	async prepareUpdate(
		user: { id: MiUser['id'] },
		note: MiNote,
	): Promise<NoteUpdatePreparation> {
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

		const mentions = extractMentions(tokens);
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

		// Parse MFM if needed
		const tokens = (note.text ? mfm.parse(note.text)! : []);
		const cwTokens = note.cw ? mfm.parse(note.cw)! : [];

		const combinedTokens = tokens.concat(cwTokens);

		const mentionedUsers = await this.extractMentionedUsers(user, combinedTokens);

		if (note.reply && (user.id !== note.reply.userId) && !mentionedUsers.some(u => u.id === note.reply!.userId)) {
			mentionedUsers.push(await this.usersRepository.findOneByOrFail({ id: note.reply.userId }));
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

		// 投稿がリプライかつ投稿者がローカルユーザーかつリプライ先の投稿の投稿者がリモートユーザーなら配送
		if (note.reply && note.reply.userHost !== null) {
			const u = await this.usersRepository.findOneBy({ id: note.reply.userId });
			if (u && this.userEntityService.isRemoteUser(u)) dm.addDirectRecipe(u);
		}

		// 投稿がRenoteかつ投稿者がローカルユーザーかつRenote元の投稿の投稿者がリモートユーザーなら配送
		if (note.renote && note.renote.userHost !== null) {
			const u = await this.usersRepository.findOneBy({ id: note.renote.userId });
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
