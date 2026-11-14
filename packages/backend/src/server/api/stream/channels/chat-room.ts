/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import type { JsonObject } from '@/misc/json-value.js';
import { ChatService } from '@/core/ChatService.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';
import type { ChatRoomsRepository } from '@/models/_.js';

@Injectable({ scope: Scope.TRANSIENT })
export class ChatRoomChannel extends Channel {
	public readonly chName = 'chatRoom';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:chat';
	private roomId: string;
	private disposed = false;
	private permissionExpiresAt = 0;
	private permissionCheck: Promise<boolean> | null = null;
	private permissionIntervalId: NodeJS.Timeout | null = null;

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		private chatService: ChatService,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject): Promise<boolean> {
		if (typeof params.roomId !== 'string') return false;
		if (!this.user) return false;

		this.roomId = params.roomId;
		this.subscriber.on(`chatRoomMembership:${this.roomId}:${this.user.id}`, this.onInternalEvent);
		if (!(await this.checkPermission()) || this.disposed) return false;

		this.subscriber.on(`chatRoomStream:${this.roomId}`, this.onEvent);
		this.permissionIntervalId = setInterval(() => { void this.checkPermission(); }, 10_000);

		return true;
	}

	@bindThis
	private async onEvent(data: GlobalEvents['chatRoom']['payload']) {
		if (!(await this.checkPermission()) || this.disposed) return;
		this.send(data.type, data.body);
	}

	@bindThis
	private onInternalEvent(event: GlobalEvents['internal']['payload']) {
		if (event.type !== 'chatRoomMemberLeft' || event.body.roomId !== this.roomId || event.body.userId !== this.user?.id) return;
		this.connection.disconnectChannel(this.id);
	}

	private checkPermission(): Promise<boolean> {
		if (this.disposed || !this.user) return Promise.resolve(false);
		if (this.permissionCheck) return this.permissionCheck;
		if (Date.now() < this.permissionExpiresAt) return Promise.resolve(true);
		this.permissionCheck = (async () => {
			try {
				const room = await this.chatRoomsRepository.findOneBy({ id: this.roomId });
				if (!room || !(await this.chatService.hasPermissionToViewRoomTimeline(this.user!.id, room))) {
					this.connection.disconnectChannel(this.id);
					return false;
				}
				this.permissionExpiresAt = Date.now() + 10_000;
				return !this.disposed;
			} catch {
				this.connection.disconnectChannel(this.id);
				return false;
			} finally {
				this.permissionCheck = null;
			}
		})();
		return this.permissionCheck;
	}

	@bindThis
	public async onMessage(type: string, body: any) {
		if (!(await this.checkPermission()) || this.disposed) return;
		switch (type) {
			case 'read':
				if (this.roomId) {
					await this.chatService.readRoomChatMessage(this.user!.id, this.roomId);
				}
				break;
		}
	}

	@bindThis
	public dispose() {
		this.disposed = true;
		if (this.permissionIntervalId) clearInterval(this.permissionIntervalId);
		this.subscriber.off(`chatRoomMembership:${this.roomId}:${this.user?.id}`, this.onInternalEvent);
		this.subscriber.off(`chatRoomStream:${this.roomId}`, this.onEvent);
	}
}
