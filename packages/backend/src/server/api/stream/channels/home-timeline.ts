/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import type { Packed } from '@/misc/json-schema.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteStreamingHidingService } from '../NoteStreamingHidingService.js';
import { bindThis } from '@/decorators.js';
import { isRenotePacked, isQuotePacked } from '@/misc/is-renote.js';
import type { JsonObject } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';

@Injectable({ scope: Scope.TRANSIENT })
export class HomeTimelineChannel extends Channel {
	public readonly chName = 'homeTimeline';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:account';
	private withRenotes: boolean;
	private withFiles: boolean;

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		private noteEntityService: NoteEntityService,
		private noteStreamingHidingService: NoteStreamingHidingService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject) {
		this.withRenotes = !!(params.withRenotes ?? true);
		this.withFiles = !!(params.withFiles ?? false);

		this.subscriber.on('notesStream', this.onNote);
	}

	@bindThis
	private async onNote(note: Packed<'Note'>) {
		const isMe = this.user!.id === note.userId;

		if (this.withFiles && (note.fileIds == null || note.fileIds.length === 0)) return;

		if (note.channelId) {
			if (!this.followingChannels.has(note.channelId)) {
				return;
			}
		} else {
			if (!isMe && !Object.hasOwn(this.following, note.userId)) return;
		}

		if (!this.isNoteVisibleForMe(note)) return;

		if (note.reply) {
			const reply = note.reply;
			if (this.following[note.userId]?.withReplies) {
				if (reply.visibility === 'followers' && !Object.hasOwn(this.following, reply.userId) && reply.userId !== this.user!.id) return;
			} else {
				if (reply.userId !== this.user!.id && !isMe && reply.userId !== note.userId) return;
			}
		}

		if (isRenotePacked(note) && !isQuotePacked(note) && note.renote) {
			if (!this.withRenotes) return;
			if (note.renote.reply) {
				const reply = note.renote.reply;
				if (reply.visibility === 'followers' && !Object.hasOwn(this.following, reply.userId) && reply.userId !== this.user!.id) return;
			}
		}

		if (this.isNoteMutedOrBlocked(note)) return;

		const filtered = await this.noteStreamingHidingService.filter(note, this.user?.id ?? null);
		if (!filtered) return;
		// eslint-disable-next-line no-param-reassign -- これ以降元の Note オブジェクトは見てはいけないので、いっそ再代入した方が安全
		note = filtered;

		this.send('note', await this.noteEntityService.withMyRenoteReaction(note, this.user?.id ?? null));
	}

	@bindThis
	public dispose() {
		this.subscriber.off('notesStream', this.onNote);
	}
}
