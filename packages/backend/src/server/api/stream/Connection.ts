/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as WebSocket from 'ws';
import promiseLimit from 'promise-limit';
import { ContextIdFactory, ModuleRef, REQUEST } from '@nestjs/core';
import { Inject, Injectable, Scope } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { isJsonObject } from '@/misc/json-value.js';
import type { JsonObject, JsonValue } from '@/misc/json-value.js';
import { ChannelMutingService } from '@/core/ChannelMutingService.js';
import { ChannelFollowingService } from '@/core/ChannelFollowingService.js';
import type { GlobalEvents, StreamEventEmitter } from '@/core/GlobalEventService.js';
import { MiFollowing, MiUserProfile } from '@/models/_.js';
import type { MiMeta } from '@/models/_.js';
import { CacheService } from '@/core/CacheService.js';
import { bindThis } from '@/decorators.js';
import { NotificationService } from '@/core/NotificationService.js';
import type { MiAccessToken } from '@/models/AccessToken.js';
import type { MiUser } from '@/models/User.js';
import { MainChannel } from '@/server/api/stream/channels/main.js';
import { HomeTimelineChannel } from '@/server/api/stream/channels/home-timeline.js';
import { LocalTimelineChannel } from '@/server/api/stream/channels/local-timeline.js';
import { HybridTimelineChannel } from '@/server/api/stream/channels/hybrid-timeline.js';
import { GlobalTimelineChannel } from '@/server/api/stream/channels/global-timeline.js';
import { UserListChannel } from '@/server/api/stream/channels/user-list.js';
import { ClipChannel } from '@/server/api/stream/channels/clip.js';
import { HashtagChannel } from '@/server/api/stream/channels/hashtag.js';
import { RoleTimelineChannel } from '@/server/api/stream/channels/role-timeline.js';
import { AntennaChannel } from '@/server/api/stream/channels/antenna.js';
import { ChannelChannel } from '@/server/api/stream/channels/channel.js';
import { DriveChannel } from '@/server/api/stream/channels/drive.js';
import { ServerStatsChannel } from '@/server/api/stream/channels/server-stats.js';
import { QueueStatsChannel } from '@/server/api/stream/channels/queue-stats.js';
import { AdminChannel } from '@/server/api/stream/channels/admin.js';
import { ChatUserChannel } from '@/server/api/stream/channels/chat-user.js';
import { ChatRoomChannel } from '@/server/api/stream/channels/chat-room.js';
import { ReversiChannel } from '@/server/api/stream/channels/reversi.js';
import { ReversiGameChannel } from '@/server/api/stream/channels/reversi-game.js';
import type { ChannelRequest } from './channel.js';
import type { ChannelConstructor } from './channel.js';
import type Channel from './channel.js';
import type { EventEmitter } from 'events';

const MAX_CHANNELS_PER_CONNECTION = 32;
const MAX_SUBSCRIBING_NOTES_PER_CONNECTION = 1536;
const MAX_BUFFERED_AMOUNT_PER_CONNECTION = 1024 * 1024 * 8;

@Injectable({ scope: Scope.TRANSIENT })
export default class Connection {
	public user?: MiUser;
	public token?: MiAccessToken;
	private wsConnection: WebSocket.WebSocket;
	private messageQueue = promiseLimit<void>(1);
	public subscriber: StreamEventEmitter;
	private channels: Map<string, Channel> = new Map();
	private subscribingNotes: Map<string, number> = new Map();
	public userProfile: MiUserProfile | null = null;
	public following: Record<string, Pick<MiFollowing, 'withReplies'> | undefined> = {};
	public followingChannels: Set<string> = new Set();
	public mutingChannels: Set<string> = new Set();
	public userIdsWhoMeMuting: Set<string> = new Set();
	public userIdsWhoBlockingMe: Set<string> = new Set();
	public userIdsWhoMeMutingRenotes: Set<string> = new Set();
	public userMutedInstances: Set<string> = new Set();
	private fetchIntervalId: NodeJS.Timeout | null = null;

	constructor(
		private moduleRef: ModuleRef,
		private notificationService: NotificationService,
		private cacheService: CacheService,
		private channelFollowingService: ChannelFollowingService,
		private channelMutingService: ChannelMutingService,
		@Inject(DI.meta)
		private meta: MiMeta,
		@Inject(REQUEST)
		request: ConnectionRequest,
	) {
		if (request.user) this.user = request.user;
		if (request.token) this.token = request.token;
	}

	@bindThis
	public async fetch() {
		if (this.user == null) return;
		const [
			userProfile,
			following,
			followingChannels,
			mutingChannels,
			userIdsWhoMeMuting,
			userIdsWhoBlockingMe,
			userIdsWhoMeMutingRenotes,
		] = await Promise.all([
			this.cacheService.userProfileCache.fetch(this.user.id),
			this.cacheService.userFollowingsCache.fetch(this.user.id),
			this.channelFollowingService.userFollowingChannelsCache.fetch(this.user.id),
			this.channelMutingService.mutingChannelsCache.fetch(this.user.id),
			this.cacheService.userMutingsCache.fetch(this.user.id),
			this.cacheService.userBlockedCache.fetch(this.user.id),
			this.cacheService.renoteMutingsCache.fetch(this.user.id),
		]);
		this.userProfile = userProfile;
		this.following = following;
		this.followingChannels = followingChannels;
		this.mutingChannels = mutingChannels;
		this.userIdsWhoMeMuting = userIdsWhoMeMuting;
		this.userIdsWhoBlockingMe = userIdsWhoBlockingMe;
		this.userIdsWhoMeMutingRenotes = userIdsWhoMeMutingRenotes;
		this.userMutedInstances = new Set(userProfile.mutedInstances);
	}

	@bindThis
	public async init() {
		if (this.user != null) {
			await this.fetch();

			if (!this.fetchIntervalId) {
				this.fetchIntervalId = setInterval(this.fetch, 1000 * 10);
			}
		}
	}

	@bindThis
	public async listen(subscriber: EventEmitter, wsConnection: WebSocket.WebSocket) {
		this.subscriber = subscriber;

		this.wsConnection = wsConnection;
		this.wsConnection.on('message', data => this.messageQueue(() => this.onWsConnectionMessage(data)));

		this.subscriber.on('broadcast', data => {
			this.onBroadcastMessage(data);
		});
	}

	@bindThis
	private async onWsConnectionMessage(data: WebSocket.RawData) {
		if (this.wsConnection.readyState !== WebSocket.WebSocket.OPEN) return;

		let obj: JsonObject;

		try {
			obj = JSON.parse(data.toString());
		} catch (_) {
			return;
		}

		const { type, body } = obj;

		switch (type) {
			case 'readNotification': this.onReadNotification(body); break;
			case 'subNote': this.onSubscribeNote(body); break;
			case 's': this.onSubscribeNote(body); break;
			case 'sr': this.onSubscribeNote(body); break;
			case 'unsubNote': this.onUnsubscribeNote(body); break;
			case 'un': this.onUnsubscribeNote(body); break;
			case 'connect': await this.onChannelConnectRequested(body); break;
			case 'disconnect': this.onChannelDisconnectRequested(body); break;
			case 'channel': this.onChannelMessageRequested(body); break;
			case 'ch': this.onChannelMessageRequested(body); break;
		}
	}

	@bindThis
	private onBroadcastMessage(data: GlobalEvents['broadcast']['payload']) {
		this.sendMessageToWs(data.type, data.body);
	}

	@bindThis
	private onReadNotification(payload: JsonValue | undefined) {
		this.notificationService.readAllNotification(this.user!.id);
	}

	@bindThis
	private onSubscribeNote(payload: JsonValue | undefined) {
		if (!isJsonObject(payload)) return;
		if (!payload.id || typeof payload.id !== 'string') return;

		const current = this.subscribingNotes.get(payload.id) ?? 0;

		if (current === 0 && this.subscribingNotes.size >= MAX_SUBSCRIBING_NOTES_PER_CONNECTION) {
			const oldestId = this.subscribingNotes.keys().next().value;
			if (oldestId != null) {
				this.subscriber.off(`noteStream:${oldestId}`, this.onNoteStreamMessage);
				this.subscribingNotes.delete(oldestId);
			}
		} else {
			this.subscribingNotes.delete(payload.id);
		}

		const updated = current + 1;
		this.subscribingNotes.set(payload.id, updated);

		if (updated === 1) {
			this.subscriber.on(`noteStream:${payload.id}`, this.onNoteStreamMessage);
		}
	}

	@bindThis
	private onUnsubscribeNote(payload: JsonValue | undefined) {
		if (!isJsonObject(payload)) return;
		if (!payload.id || typeof payload.id !== 'string') return;

		const current = this.subscribingNotes.get(payload.id);
		if (current == null) return;
		const updated = current - 1;
		if (updated <= 0) {
			this.subscribingNotes.delete(payload.id);
			this.subscriber.off(`noteStream:${payload.id}`, this.onNoteStreamMessage);
		} else {
			this.subscribingNotes.set(payload.id, updated);
		}
	}

	@bindThis
	private async onNoteStreamMessage(data: GlobalEvents['note']['payload']) {
		if (data.body.userId !== this.user?.id) {
			if (data.body.visibility === 'specified' && (this.user == null || !data.body.visibleUserIds.includes(this.user.id))) {
				return;
			}

			if (data.body.visibility === 'followers' && !Object.hasOwn(this.following, data.body.userId)) {
				return;
			}
		}

		if (this.user == null && this.meta.ugcVisibilityForVisitor === 'none') return;

		this.sendMessageToWs('noteUpdated', {
			id: data.body.id,
			type: data.type,
			body: data.body.body,
		});
	}

	@bindThis
	private async onChannelConnectRequested(payload: JsonValue | undefined) {
		if (!isJsonObject(payload)) return;
		const { channel, id, params, pong } = payload;
		if (typeof id !== 'string') return;
		if (typeof channel !== 'string') return;
		if (typeof pong !== 'boolean' && typeof pong !== 'undefined' && pong !== null) return;
		if (typeof params !== 'undefined' && !isJsonObject(params)) return;
		await this.connectChannel(id, params, channel, pong ?? undefined);
	}

	@bindThis
	private onChannelDisconnectRequested(payload: JsonValue | undefined) {
		if (!isJsonObject(payload)) return;
		const { id } = payload;
		if (typeof id !== 'string') return;
		this.disconnectChannel(id);
	}

	@bindThis
	public sendMessageToWs(type: string, payload: JsonObject) {
		const message = JSON.stringify({
			type: type,
			body: payload,
		});

		if (this.wsConnection.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFERED_AMOUNT_PER_CONNECTION) {
			this.wsConnection.terminate();
			return;
		}

		this.wsConnection.send(message);
	}

	@bindThis
	public async connectChannel(id: string, params: JsonObject | undefined, channel: string, pong = false) {
		if (this.channels.has(id)) {
			this.disconnectChannel(id);
		}

		if (this.channels.size >= MAX_CHANNELS_PER_CONNECTION) {
			return;
		}

		const channelConstructor = this.getChannelConstructor(channel);

		if (channelConstructor.requireCredential && this.user == null) {
			return;
		}

		if (this.token && ((channelConstructor.kind && !this.token.permission.some(p => p === channelConstructor.kind))
			|| (!channelConstructor.kind && channelConstructor.requireCredential))) {
			return;
		}

		if (channelConstructor.shouldShare) {
			for (const c of this.channels.values()) {
				if (c.chName === channel) {
					return;
				}
			}
		}

		const contextId = ContextIdFactory.create();
		this.moduleRef.registerRequestByContextId<ChannelRequest>({
			id: id,
			connection: this,
		}, contextId);
		const ch: Channel = await this.moduleRef.create<Channel>(channelConstructor, contextId);
		if (this.wsConnection.readyState !== WebSocket.WebSocket.OPEN) return;

		this.channels.set(ch.id, ch);
		const valid = await ch.init(params ?? {});
		if (typeof valid === 'boolean' && !valid) {
			this.disconnectChannel(id);
			return;
		}

		if (pong) {
			this.sendMessageToWs('connected', {
				id: id,
			});
		}
	}

	@bindThis
	public getChannelConstructor(name: string): ChannelConstructor<boolean> {
		switch (name) {
			case 'main': return MainChannel;
			case 'homeTimeline': return HomeTimelineChannel;
			case 'localTimeline': return LocalTimelineChannel;
			case 'hybridTimeline': return HybridTimelineChannel;
			case 'globalTimeline': return GlobalTimelineChannel;
			case 'userList': return UserListChannel;
			case 'clip': return ClipChannel;
			case 'hashtag': return HashtagChannel;
			case 'roleTimeline': return RoleTimelineChannel;
			case 'antenna': return AntennaChannel;
			case 'channel': return ChannelChannel;
			case 'drive': return DriveChannel;
			case 'serverStats': return ServerStatsChannel;
			case 'queueStats': return QueueStatsChannel;
			case 'admin': return AdminChannel;
			case 'chatUser': return ChatUserChannel;
			case 'chatRoom': return ChatRoomChannel;
			case 'reversi': return ReversiChannel;
			case 'reversiGame': return ReversiGameChannel;

			default:
				throw new Error(`no such channel: ${name}`);
		}
	}

	@bindThis
	public disconnectChannel(id: string) {
		const channel = this.channels.get(id);

		if (channel) {
			if (channel.dispose) channel.dispose();
			this.channels.delete(id);
		}
	}

	@bindThis
	private onChannelMessageRequested(data: JsonValue | undefined) {
		if (!isJsonObject(data)) return;
		if (typeof data.id !== 'string') return;
		if (typeof data.type !== 'string') return;
		if (typeof data.body === 'undefined') return;

		const channel = this.channels.get(data.id);
		if (channel != null && channel.onMessage != null) {
			channel.onMessage(data.type, data.body);
		}
	}

	@bindThis
	public dispose() {
		if (this.fetchIntervalId) clearInterval(this.fetchIntervalId);

		for (const c of this.channels.values()) {
			if (c.dispose) c.dispose();
		}
		this.channels.clear();

		for (const id of this.subscribingNotes.keys()) {
			this.subscriber.off(`noteStream:${id}`, this.onNoteStreamMessage);
		}
		this.subscribingNotes.clear();
	}
}

export interface ConnectionRequest {
	user: MiUser | null | undefined,
	token: MiAccessToken | null | undefined,
}
