/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { bindThis } from '@/decorators.js';
import { isInstanceMuted } from '@/misc/is-instance-muted.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { isQuotePacked, isRenotePacked } from '@/misc/is-renote.js';
import { isChannelRelated } from '@/misc/is-channel-related.js';
import type { Awaitable } from '@/types.js';
import type { Packed } from '@/misc/json-schema.js';
import type { JsonObject, JsonValue } from '@/misc/json-value.js';
import type Connection from './Connection.js';

// eslint-disable-next-line import/no-default-export
export default abstract class Channel {
	protected connection: Connection;
	public id: string;
	public abstract readonly chName: string;
	public static readonly shouldShare: boolean;
	public static readonly requireCredential: boolean;
	public static readonly kind: string | null;

	protected get user() {
		return this.connection.user;
	}

	protected get userProfile() {
		return this.connection.userProfile;
	}

	protected get following() {
		return this.connection.following;
	}

	protected get userIdsWhoMeMuting() {
		return this.connection.userIdsWhoMeMuting;
	}

	protected get userIdsWhoMeMutingRenotes() {
		return this.connection.userIdsWhoMeMutingRenotes;
	}

	protected get userIdsWhoBlockingMe() {
		return this.connection.userIdsWhoBlockingMe;
	}

	protected get userMutedInstances() {
		return this.connection.userMutedInstances;
	}

	protected get followingChannels() {
		return this.connection.followingChannels;
	}

	protected get mutingChannels() {
		return this.connection.mutingChannels;
	}

	protected get subscriber() {
		return this.connection.subscriber;
	}

	protected isNoteVisibleForMe(note: Packed<'Note'>): boolean {
		const meId = this.connection.user?.id ?? null;

		if (note.visibility === 'specified') {
			if (meId == null) {
				return false;
			} else if (meId === note.userId) {
				return true;
			} else {
				return note.visibleUserIds?.some(id => meId === id) ?? false;
			}
		}

		if (note.visibility === 'followers') {
			if (meId == null) {
				return false;
			} else if (meId === note.userId) {
				return true;
			} else if (note.reply && (meId === note.reply.userId)) {
				return true;
			} else if (note.mentions && note.mentions.some(id => meId === id)) {
				return true;
			} else {
				return Object.hasOwn(this.following, note.userId);
			}
		}

		return true;
	}

	protected isNoteMutedOrBlocked(note: Packed<'Note'>): boolean {
		if (isInstanceMuted(note, this.userMutedInstances)) return true;

		if (isUserRelated(note, this.userIdsWhoMeMuting)) return true;
		if (isUserRelated(note, this.userIdsWhoBlockingMe)) return true;

		if (isRenotePacked(note) && !isQuotePacked(note) && this.userIdsWhoMeMutingRenotes.has(note.user.id)) return true;

		if (isChannelRelated(note, this.mutingChannels)) return true;

		return false;
	}

	constructor(request: ChannelRequest) {
		this.id = request.id;
		this.connection = request.connection;
	}

	public send(payload: { type: string, body: JsonValue }): void;
	public send(type: string, payload: JsonValue): void;
	@bindThis
	public send(typeOrPayload: { type: string, body: JsonValue } | string, payload?: JsonValue) {
		const type = payload === undefined ? (typeOrPayload as { type: string, body: JsonValue }).type : (typeOrPayload as string);
		const body = payload === undefined ? (typeOrPayload as { type: string, body: JsonValue }).body : payload;

		this.connection.sendMessageToWs('channel', {
			id: this.id,
			type: type,
			body: body,
		});
	}

	public abstract init(params: JsonObject): Awaitable<void | boolean>;

	public dispose?(): void;

	public onMessage?(type: string, body: JsonValue): Awaitable<void>;
}

export interface ChannelRequest {
	id: string,
	connection: Connection,
}

export interface ChannelConstructor<T extends boolean> {
	new(...args: any[]): Channel;
	shouldShare: boolean;
	requireCredential: T;
	kind: T extends true ? string : string | null | undefined;
}
