/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { MiMastodonUserState, NotesRepository, UsersRepository } from '@/models/_.js';
import type { Packed } from '@/misc/json-schema.js';
import { MastodonApiStateService } from './MastodonApiStateService.js';
import { MastodonEntityService } from './MastodonEntityService.js';
import { MastodonApiError } from './errors.js';
import { digestCredential } from './utils.js';

const CONVERSATION_KIND = 'conversation';
const DELETED_KIND = 'conversation_deleted';
const CANDIDATE_LIMIT = 200;
const PAGE_LIMIT = 40;

type StoredConversation = {
	groupKey: string;
	participants: MiUser['id'][];
	lastStatusId: MiNote['id'];
	readThroughId: MiNote['id'] | null;
	forcedUnread: boolean;
};

type DeletedConversation = {
	deletedThroughId: MiNote['id'];
};

type ConversationGroup = {
	key: string;
	groupKey: string;
	participants: MiUser['id'][];
	lastNote: MiNote;
};

type ConversationProjection = {
	id: string;
	unread: boolean;
	participants: MiUser['id'][];
	lastNote: MiNote;
};

export type MastodonConversation = {
	id: string;
	unread: boolean;
	accounts: ReturnType<MastodonEntityService['account']>[];
	lastStatus: Packed<'Note'>;
};

export type MastodonConversationPage = {
	limit: number;
	maxId?: string;
	minId?: string;
	sinceId?: string;
};

@Injectable()
export class MastodonConversationService {
	constructor(
		private mastodonApiStateService: MastodonApiStateService,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private idService: IdService,
		private noteEntityService: NoteEntityService,
		private userEntityService: UserEntityService,
		private mastodonEntityService: MastodonEntityService,
	) {}

	public async list(user: MiLocalUser, page: MastodonConversationPage): Promise<MastodonConversation[]> {
		const notes = await this.directNotes(user.id, page);
		const groups = this.groups(notes);
		const candidateIds = new Set(notes.map(note => note.id));
		const projections = await this.withConversationLocks(user.id, async stateService => {
			const contexts = await Promise.all(groups.map(async group => ({
				group,
				row: await stateService.get(user.id, CONVERSATION_KIND, group.key),
				tombstone: await stateService.get(user.id, DELETED_KIND, group.key),
			})));
			const missingProjectedIds = [...new Set(contexts.flatMap(({ row }) => {
				const stored = this.stored(row);
				return stored != null && !candidateIds.has(stored.lastStatusId) ? [stored.lastStatusId] : [];
			}))];
			const existingProjectedIds = new Set(missingProjectedIds.length === 0
				? []
				: (await this.notesRepository.findBy({ id: In(missingProjectedIds) })).map(note => note.id));
			const result: ConversationProjection[] = [];
			for (const context of contexts) {
				const projection = await this.reconcile(stateService, user.id, context.group, context.row, context.tombstone, existingProjectedIds);
				if (projection != null) result.push(projection);
			}
			return result;
		});
		const limit = Math.min(PAGE_LIMIT, Math.max(1, Math.floor(page.limit)));
		const lowerId = this.lowerId(page.minId, page.sinceId);
		const filtered = projections
			.filter(projection => page.maxId == null || projection.lastNote.id < page.maxId)
			.filter(projection => lowerId == null || projection.lastNote.id > lowerId)
			.sort((left, right) => right.lastNote.id.localeCompare(left.lastNote.id))
			.slice(0, limit);
		return await this.pack(user, filtered);
	}

	public async read(user: MiLocalUser, conversationId: string): Promise<MastodonConversation> {
		return await this.mutate(user, conversationId, stored => ({
			...stored,
			readThroughId: this.maxId(stored.readThroughId, stored.lastStatusId),
			forcedUnread: false,
		}));
	}

	public async unread(user: MiLocalUser, conversationId: string): Promise<MastodonConversation> {
		return await this.mutate(user, conversationId, stored => ({ ...stored, forcedUnread: true }));
	}

	public async delete(user: MiLocalUser, conversationId: string): Promise<Record<string, never>> {
		return await this.withConversationLocks(user.id, async stateService => {
			const row = await this.ownedRow(stateService, user.id, conversationId);
			const stored = this.stored(row);
			if (stored == null) this.notFound();
			await stateService.put({
				userId: user.id,
				kind: DELETED_KIND,
				key: row.key,
				value: { deletedThroughId: stored.lastStatusId } satisfies DeletedConversation,
			});
			await stateService.delete(user.id, CONVERSATION_KIND, row.key);
			return {};
		});
	}

	private async mutate(
		user: MiLocalUser,
		conversationId: string,
		update: (stored: StoredConversation) => StoredConversation,
	): Promise<MastodonConversation> {
		const projection = await this.withConversationLocks(user.id, async stateService => {
			const row = await this.ownedRow(stateService, user.id, conversationId);
			const stored = this.stored(row);
			if (stored == null) this.notFound();
			const lastNote = await this.notesRepository.findOneBy({ id: stored.lastStatusId });
			let group = lastNote == null || !this.isDirectFor(lastNote, user.id)
				? null
				: this.groups([lastNote]).find(value => value.groupKey === stored.groupKey) ?? null;
			if (group == null) {
				const notes = await this.directNotes(user.id, {});
				group = this.groups(notes).find(value => value.groupKey === stored.groupKey) ?? null;
			}
			if (group == null) this.notFound();
			const reconciled = this.updatedStored(stored, group.lastNote, user.id);
			const next = update(reconciled);
			await stateService.put({ userId: user.id, kind: CONVERSATION_KIND, key: row.key, value: next });
			return this.projection(row.id, next, group.lastNote, user.id);
		});
		return (await this.pack(user, [projection]))[0]!;
	}

	private async reconcile(
		stateService: MastodonApiStateService,
		userId: MiUser['id'],
		group: ConversationGroup,
		row: MiMastodonUserState | null,
		tombstoneRow: MiMastodonUserState | null,
		existingProjectedIds: Set<string>,
	): Promise<ConversationProjection | null> {
		const current = this.stored(row);
		if (current != null && current.groupKey === group.groupKey) {
			if (current.lastStatusId > group.lastNote.id && existingProjectedIds.has(current.lastStatusId)) return null;
			const updated = this.updatedStored(current, group.lastNote, userId);
			if (!this.sameStored(current, updated)) {
				await stateService.put({ userId, kind: CONVERSATION_KIND, key: group.key, value: updated });
			}
			return this.projection(row!.id, updated, group.lastNote, userId);
		}

		const tombstone = this.deleted(tombstoneRow);
		if (tombstone != null && tombstone.deletedThroughId >= group.lastNote.id) return null;
		const stored: StoredConversation = {
			groupKey: group.groupKey,
			participants: group.participants,
			lastStatusId: group.lastNote.id,
			readThroughId: group.lastNote.userId === userId ? group.lastNote.id : null,
			forcedUnread: false,
		};
		const id = this.idService.gen();
		await stateService.createWithId({ id, userId, kind: CONVERSATION_KIND, key: group.key, value: stored });
		return this.projection(id, stored, group.lastNote, userId);
	}

	private updatedStored(current: StoredConversation, lastNote: MiNote, userId: MiUser['id']): StoredConversation {
		const authoredByUser = lastNote.userId === userId;
		const advanced = lastNote.id > current.lastStatusId;
		return {
			...current,
			lastStatusId: lastNote.id,
			readThroughId: authoredByUser && advanced ? this.maxId(current.readThroughId, lastNote.id) : current.readThroughId,
			forcedUnread: authoredByUser && advanced ? false : current.forcedUnread,
		};
	}

	private projection(id: string, stored: StoredConversation, lastNote: MiNote, userId: MiUser['id']): ConversationProjection {
		return {
			id,
			unread: stored.forcedUnread || (lastNote.userId !== userId && (stored.readThroughId == null || lastNote.id > stored.readThroughId)),
			participants: stored.participants,
			lastNote,
		};
	}

	private async pack(user: MiLocalUser, projections: ConversationProjection[]): Promise<MastodonConversation[]> {
		if (projections.length === 0) return [];
		const participantIds = [...new Set(projections.flatMap(projection => projection.participants))]
			.filter(id => id !== user.id)
			.sort();
		const users = participantIds.length === 0 ? [] : await this.usersRepository.findBy({ id: In(participantIds) });
		const usersById = new Map(users.filter(value => !value.isDeleted).map(value => [value.id, value]));
		const visibleUsers = participantIds.flatMap(id => {
			const value = usersById.get(id);
			return value == null ? [] : [value];
		});
		const [packedNotes, packedUsers] = await Promise.all([
			this.noteEntityService.packMany(projections.map(projection => projection.lastNote), user),
			this.userEntityService.packMany(visibleUsers, user, { schema: 'UserDetailed' }),
		]);
		const notesById = new Map(packedNotes.map(note => [note.id, note]));
		const accountsById = new Map(packedUsers.map(account => [account.id, this.mastodonEntityService.account(account)]));
		return projections.flatMap(projection => {
			const lastStatus = notesById.get(projection.lastNote.id);
			if (lastStatus == null) return [];
			return [{
				id: projection.id,
				unread: projection.unread,
				accounts: projection.participants
					.filter(id => id !== user.id)
					.flatMap(id => {
						const account = accountsById.get(id);
						return account == null ? [] : [account];
					}),
				lastStatus,
			}];
		});
	}

	private async directNotes(userId: MiUser['id'], page: Pick<MastodonConversationPage, 'maxId' | 'minId' | 'sinceId'>): Promise<MiNote[]> {
		const query = this.notesRepository.createQueryBuilder('note')
			.where('note.visibility = :visibility', { visibility: 'specified' })
			.andWhere('(note.userId = :userId OR :userIdAsList <@ note.visibleUserIds)', { userId, userIdAsList: [userId] });
		if (page.maxId != null && page.maxId !== '') query.andWhere('note.id < :maxId', { maxId: page.maxId });
		const lowerId = this.lowerId(page.minId, page.sinceId);
		if (lowerId != null && lowerId !== '') query.andWhere('note.id > :minId', { minId: lowerId });
		const hasMinId = page.minId != null && page.minId !== '';
		const notes = await query.orderBy('note.id', hasMinId ? 'ASC' : 'DESC').take(CANDIDATE_LIMIT).getMany();
		return notes
			.filter(note => this.isDirectFor(note, userId))
			.filter(note => page.maxId == null || page.maxId === '' || note.id < page.maxId)
			.filter(note => lowerId == null || lowerId === '' || note.id > lowerId)
			.sort((left, right) => right.id.localeCompare(left.id))
			.slice(0, CANDIDATE_LIMIT);
	}

	private isDirectFor(note: MiNote, userId: MiUser['id']): boolean {
		return note.visibility === 'specified' && (note.userId === userId || note.visibleUserIds.includes(userId));
	}

	private groups(notes: MiNote[]): ConversationGroup[] {
		const groups = new Map<string, ConversationGroup>();
		for (const note of notes) {
			const participants = [...new Set([note.userId, ...note.visibleUserIds])].sort();
			const groupKey = JSON.stringify([note.threadId ?? note.id, participants]);
			const key = digestCredential(groupKey);
			const current = groups.get(key);
			if (current == null || note.id > current.lastNote.id) {
				groups.set(key, { key, groupKey, participants, lastNote: note });
			}
		}
		return [...groups.values()].sort((left, right) => right.lastNote.id.localeCompare(left.lastNote.id));
	}

	private async ownedRow(stateService: MastodonApiStateService, userId: MiUser['id'], id: string): Promise<MiMastodonUserState> {
		const row = await stateService.getById(id);
		if (row == null || row.userId !== userId || row.kind !== CONVERSATION_KIND) this.notFound();
		return row;
	}

	private stored(row: MiMastodonUserState | null): StoredConversation | null {
		if (row == null || row.kind !== CONVERSATION_KIND || row.value == null || typeof row.value !== 'object' || Array.isArray(row.value)) return null;
		const value = row.value as Partial<StoredConversation>;
		if (typeof value.groupKey !== 'string' || !Array.isArray(value.participants) || value.participants.some(id => typeof id !== 'string') ||
			typeof value.lastStatusId !== 'string' || (value.readThroughId != null && typeof value.readThroughId !== 'string') ||
			typeof value.forcedUnread !== 'boolean') return null;
		return {
			groupKey: value.groupKey,
			participants: [...new Set(value.participants)].sort(),
			lastStatusId: value.lastStatusId,
			readThroughId: value.readThroughId ?? null,
			forcedUnread: value.forcedUnread,
		};
	}

	private deleted(row: MiMastodonUserState | null): DeletedConversation | null {
		if (row == null || row.kind !== DELETED_KIND || row.value == null || typeof row.value !== 'object' || Array.isArray(row.value)) return null;
		const deletedThroughId = (row.value as Partial<DeletedConversation>).deletedThroughId;
		return typeof deletedThroughId === 'string' ? { deletedThroughId } : null;
	}

	private maxId(left: string | null, right: string): string {
		return left == null || right > left ? right : left;
	}

	private lowerId(minId: string | undefined, sinceId: string | undefined): string | undefined {
		if (minId == null || minId === '') return sinceId;
		if (sinceId == null || sinceId === '') return minId;
		return minId > sinceId ? minId : sinceId;
	}

	private sameStored(left: StoredConversation, right: StoredConversation): boolean {
		return left.groupKey === right.groupKey && left.lastStatusId === right.lastStatusId && left.readThroughId === right.readThroughId &&
			left.forcedUnread === right.forcedUnread && left.participants.length === right.participants.length &&
			left.participants.every((id, index) => id === right.participants[index]);
	}

	private async withConversationLocks<T>(
		userId: MiUser['id'],
		callback: (stateService: MastodonApiStateService) => Promise<T>,
	): Promise<T> {
		return await this.mastodonApiStateService.withUserKindLocks([
			{ userId, kind: CONVERSATION_KIND },
			{ userId, kind: DELETED_KIND },
		], callback);
	}

	private notFound(): never {
		throw new MastodonApiError(404, 'not_found', 'Conversation not found');
	}
}
