/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Brackets, DataSource, In, IsNull, Not } from 'typeorm';
import { Injectable, Inject } from '@nestjs/common';
import * as mfm from 'mfm-js';
import type { MiUser, MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { MiNote, type IMentionedRemoteUsers } from '@/models/Note.js';
import type { InstancesRepository, MiMeta, NotesRepository, UsersRepository } from '@/models/_.js';
import { RelayService } from '@/core/RelayService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import NotesChart from '@/core/chart/charts/notes.js';
import PerUserNotesChart from '@/core/chart/charts/per-user-notes.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import { SearchService } from '@/core/SearchService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';
import { shouldCountRenote } from '@/misc/should-count-renote.js';
import { resolveNoteMentions } from '@/misc/resolve-note-mentions.js';
import { RemoteUserResolveService } from '@/core/RemoteUserResolveService.js';

@Injectable()
export class NoteDeleteService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
		private relayService: RelayService,
		private federatedInstanceService: FederatedInstanceService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
		private searchService: SearchService,
		private moderationLogService: ModerationLogService,
		private notesChart: NotesChart,
		private perUserNotesChart: PerUserNotesChart,
		private instanceChart: InstanceChart,
		private remoteUserResolveService: RemoteUserResolveService,
	) {}

	async delete(user: { id: MiUser['id']; uri: MiUser['uri']; host: MiUser['host']; isBot: MiUser['isBot']; }, note: MiNote, quiet = false, deleter?: MiUser) {
		const deletedAt = new Date();

		const relatedNoteIds = [...new Set(
			[note.replyId, note.renoteId].filter((id): id is MiNote['id'] => id != null),
		)];
		const relatedNotes = relatedNoteIds.length === 0
			? []
			: await this.notesRepository.findBy({ id: In(relatedNoteIds) });
		const replyTarget = note.replyId == null ? null : relatedNotes.find(target => target.id === note.replyId) ?? null;
		const renoteTarget = note.renoteId == null ? null : relatedNotes.find(target => target.id === note.renoteId) ?? null;
		const mutation = await this.deleteNoteAndUpdateCounters(user, note, replyTarget, renoteTarget);
		if (!mutation.deleted) return;
		note = mutation.deletedNote!;

		if (replyTarget != null && mutation.replyCountChanged) {
			this.globalEventService.publishNoteStream(replyTarget, 'repliesCountChanged', { delta: -1 });
		}

		if (renoteTarget != null && mutation.renoteCountChanged) {
			this.globalEventService.publishNoteStream(renoteTarget, 'renoteCountChanged', { delta: -1 });
		}

		for (const targetId of mutation.childTargetIds) {
			const target = relatedNotes.find(relatedNote => relatedNote.id === targetId);
			if (target == null) continue;
			this.globalEventService.publishNoteStream(target, 'childrenChanged', {
				action: 'removed',
				childId: note.id,
			});
		}

		if (!quiet) {
			this.globalEventService.publishNoteStream(note, 'deleted', {
				deletedAt: deletedAt,
			});

			if (this.userEntityService.isLocalUser(user) && !note.localOnly) {
				let renote: MiNote | null = null;

				if (isRenote(note) && !isQuote(note)) {
					renote = await this.notesRepository.findOneBy({
						id: note.renoteId,
					});
				}

				const content = this.apRendererService.addContext(renote
					? this.apRendererService.renderUndo(this.apRendererService.renderAnnounce(renote.uri ?? `${this.config.url}/notes/${renote.id}`, note), user)
					: this.apRendererService.renderDelete(this.apRendererService.renderTombstone(`${this.config.url}/notes/${note.id}`), user));

				this.deliverToConcerned(user, note, content);
			}

			this.notesChart.update(note, false);
			if (this.meta.enableChartsForRemoteUser || (user.host == null)) {
				this.perUserNotesChart.update(user, note, false);
			}

			if (this.meta.enableStatsForFederatedInstances) {
				if (this.userEntityService.isRemoteUser(user)) {
					this.federatedInstanceService.fetchOrRegister(user.host).then(async i => {
						this.instancesRepository.decrement({ id: i.id }, 'notesCount', 1);
						if (this.meta.enableChartsForFederatedInstances) {
							this.instanceChart.updateNote(i.host, note, false);
						}
					});
				}
			}
		}

		this.searchService.unindexNote(note);

		if (deleter && (note.userId !== deleter.id)) {
			const user = await this.usersRepository.findOneByOrFail({ id: note.userId });
			this.moderationLogService.log(deleter, 'deleteNote', {
				noteId: note.id,
				noteUserId: note.userId,
				noteUserUsername: user.username,
				noteUserHost: user.host,
				note: note,
			});
		}
	}

	@bindThis
	private async deleteNoteAndUpdateCounters(
		user: Pick<MiUser, 'id' | 'isBot'>,
		note: MiNote,
		replyTarget: MiNote | null,
		renoteTarget: MiNote | null,
	): Promise<{
		deleted: boolean;
		deletedNote: MiNote | null;
		replyCountChanged: boolean;
		renoteCountChanged: boolean;
		childTargetIds: MiNote['id'][];
	}> {
		return this.db.transaction(async transactionalEntityManager => {
			const snapshot = await transactionalEntityManager.findOne(MiNote, {
				where: { id: note.id, userId: user.id },
				select: { id: true, text: true, cw: true, mentions: true, mentionedRemoteUsers: true, history: true },
				lock: { mode: 'pessimistic_write' },
			});
			if (snapshot == null) return { deleted: false, deletedNote: null, replyCountChanged: false, renoteCountChanged: false, childTargetIds: [] };
			const deletion = await transactionalEntityManager.delete(MiNote, {
				id: note.id,
				userId: user.id,
			});
			if (deletion.affected !== 1) {
				return {
					deleted: false,
					deletedNote: null,
					replyCountChanged: false,
					renoteCountChanged: false,
					childTargetIds: [],
				};
			}

			let replyCountChanged = false;
			let renoteCountChanged = false;
			const childTargetIds = new Set<MiNote['id']>();

			if (replyTarget != null) {
				const result = await transactionalEntityManager.decrement(MiNote, { id: replyTarget.id }, 'repliesCount', 1);
				replyCountChanged = result.affected === 1;
				if (replyCountChanged) childTargetIds.add(replyTarget.id);
			}

			if (renoteTarget != null) {
				let renoteTargetExists = false;
				if (shouldCountRenote(renoteTarget, user)) {
					const result = await transactionalEntityManager.decrement(MiNote, { id: renoteTarget.id }, 'renoteCount', 1);
					renoteCountChanged = result.affected === 1;
					renoteTargetExists = renoteCountChanged;
				} else if (isRenote(note) && isQuote(note)) {
					renoteTargetExists = await transactionalEntityManager.existsBy(MiNote, { id: renoteTarget.id });
				}
				if (renoteTargetExists && isRenote(note) && isQuote(note)) childTargetIds.add(renoteTarget.id);
			}

			return {
				deleted: true,
				deletedNote: {
					...note,
					text: snapshot.text,
					cw: snapshot.cw,
					mentions: snapshot.mentions,
					mentionedRemoteUsers: snapshot.mentionedRemoteUsers,
					history: snapshot.history,
				},
				replyCountChanged,
				renoteCountChanged,
				childTargetIds: [...childTargetIds],
			};
		});
	}

	@bindThis
	private async getMentionedRemoteUsers(note: MiNote) {
		const where = [] as any[];

		const uris = (JSON.parse(note.mentionedRemoteUsers) as IMentionedRemoteUsers).map(x => x.uri);
		if (uris.length > 0) {
			where.push(
				{ uri: In(uris) },
			);
		}
		const history = note.history ?? [];
		const legacyRevisions = history.filter(revision => revision.mentions == null);
		const tokens = (legacyRevisions.length > 0 ? [note, ...legacyRevisions] : []).flatMap(revision =>
			[revision.text, revision.cw].flatMap(text => text ? mfm.parse(text) : []));
		const resolved = await resolveNoteMentions(note.userHost, tokens, this.remoteUserResolveService.resolveUser);
		const mentionIds = [...new Set([...note.mentions, ...history.flatMap(revision => revision.mentions ?? []), ...resolved.map(user => user.id)])];
		if (mentionIds.length > 0) where.push({ id: In(mentionIds), host: Not(IsNull()) });

		if (note.renoteUserId) {
			where.push({
				id: note.renoteUserId,
			});
		}

		if (where.length === 0) return [];

		return await this.usersRepository.find({
			where,
		}) as MiRemoteUser[];
	}

	@bindThis
	private async getRenotedOrRepliedRemoteUsers(note: MiNote) {
		const query = this.notesRepository.createQueryBuilder('note')
			.leftJoinAndSelect('note.user', 'user')
			.where(new Brackets(qb => {
				qb.orWhere('note.renoteId = :renoteId', { renoteId: note.id });
				qb.orWhere('note.replyId = :replyId', { replyId: note.id });
			}))
			.andWhere({ userHost: Not(IsNull()) });
		const notes = await query.getMany() as (MiNote & { user: MiRemoteUser })[];
		const remoteUsers = notes.map(({ user }) => user);
		return remoteUsers;
	}

	@bindThis
	private async deliverToConcerned(user: { id: MiLocalUser['id']; host: null; }, note: MiNote, content: any) {
		this.apDeliverManagerService.deliverToFollowers(user, content);
		this.relayService.deliverToRelays(user, content);
		this.apDeliverManagerService.deliverToUsers(user, content, [
			...await this.getMentionedRemoteUsers(note),
			...await this.getRenotedOrRepliedRemoteUsers(note),
		]);
	}
}
