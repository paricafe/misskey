/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import type { MiUserListMembership, UserListMembershipsRepository, UserListsRepository } from '@/models/_.js';
import type { Packed } from '@/misc/json-schema.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteStreamingHidingService } from '../NoteStreamingHidingService.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { isRenotePacked, isQuotePacked } from '@/misc/is-renote.js';
import type { JsonObject } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class UserListChannel extends Channel {
	public readonly chName = 'userList';
	public static shouldShare = false;
	public static requireCredential = false as const;
	private listId: string;
	private membershipsMap: Record<string, Pick<MiUserListMembership, 'withReplies'> | undefined> = {};
	private listUsersFetchCount = 0;
	private disposed = false;
	private retryTimer?: NodeJS.Timeout;
	private retryDelay = 1000;
	private withFiles: boolean;
	private withRenotes: boolean;

	constructor(
		@Inject(DI.userListsRepository)
		private userListsRepository: UserListsRepository,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		@Inject(REQUEST)
		request: ChannelRequest,

		private noteEntityService: NoteEntityService,
		private noteStreamingHidingService: NoteStreamingHidingService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		if (typeof params.listId !== 'string') return false;
		this.listId = params.listId;
		this.withFiles = !!(params.withFiles ?? false);
		this.withRenotes = !!(params.withRenotes ?? true);

		const listExist = await this.userListsRepository.exists({
			where: {
				id: this.listId,
				userId: this.user!.id,
			},
		});
		if (!listExist || this.disposed) return false;

		this.subscriber.on(`userListStream:${this.listId}`, this.onListEvent);

		this.subscriber.on('notesStream', this.onNote);

		void this.updateListUsers();

		return true;
	}

	@bindThis
	private onListEvent(data: GlobalEvents['userList']['payload']) {
		if (data.type === 'internalListDeleted') {
			this.connection.disconnectChannel(this.id);
			return;
		}

		if (data.type === 'internalMembershipUpdated') {
			delete this.membershipsMap[data.body.userId];
			void this.updateListUsers();
			return;
		}

		// クライアントに転送するのはメンバーの追加・削除のみ
		if (data.type === 'userAdded' || data.type === 'userRemoved') {
			this.send(data);
		}
	}

	@bindThis
	private async updateListUsers() {
		clearTimeout(this.retryTimer);
		const fetchCount = ++this.listUsersFetchCount;

		let memberships: Pick<MiUserListMembership, 'userId' | 'withReplies'>[];
		try {
			memberships = await this.userListMembershipsRepository.find({
				where: {
					userListId: this.listId,
				},
				select: { userId: true, withReplies: true },
			});
		} catch {
			if (fetchCount !== this.listUsersFetchCount) return;
			this.retryTimer = setTimeout(() => { void this.updateListUsers(); }, this.retryDelay);
			this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
			return;
		}

		// 読み込み中に次の読み込みが始まっていれば古い結果は使わない
		if (fetchCount !== this.listUsersFetchCount) return;

		const membershipsMap: Record<string, Pick<MiUserListMembership, 'withReplies'> | undefined> = {};
		for (const membership of memberships) {
			membershipsMap[membership.userId] = {
				withReplies: membership.withReplies,
			};
		}
		this.membershipsMap = membershipsMap;
		this.retryDelay = 1000;
	}

	@bindThis
	private async onNote(note: Packed<'Note'>) {
		const isMe = this.user!.id === note.userId;

		if (note.channelId) return;

		if (this.withFiles && (note.fileIds == null || note.fileIds.length === 0)) return;

		const membership = this.membershipsMap[note.userId];
		if (!membership) return;

		if (!this.isNoteVisibleForMe(note)) return;

		if (note.reply) {
			const reply = note.reply;
			if (reply.userId !== this.user!.id && !isMe && reply.userId !== note.userId) {
				if (!membership.withReplies) return;
				if (!this.isNoteVisibleForMe(reply)) return;
			}
		}

		if (isRenotePacked(note) && !isQuotePacked(note) && !this.withRenotes) return;

		if (this.isNoteMutedOrBlocked(note)) return;

		const filtered = await this.noteStreamingHidingService.filter(note, this.user?.id ?? null);
		if (!filtered) return;
		// eslint-disable-next-line no-param-reassign -- これ以降元の Note オブジェクトは見てはいけないので、いっそ再代入した方が安全
		note = filtered;

		const packed = await this.noteEntityService.withMyRenoteReaction(note, this.user?.id ?? null);

		const current = this.membershipsMap[note.userId];
		if (!current || current.withReplies !== membership.withReplies) return;

		this.send('note', packed);
	}

	@bindThis
	public dispose() {
		this.disposed = true;
		this.listUsersFetchCount++;
		this.membershipsMap = {};
		clearTimeout(this.retryTimer);
		this.subscriber.off(`userListStream:${this.listId}`, this.onListEvent);
		this.subscriber.off('notesStream', this.onNote);
	}
}
