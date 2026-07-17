/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import type { Packed } from '@/misc/json-schema.js';
import type { JsonObject } from '@/misc/json-value.js';
import type MainStreamConnection from '@/server/api/stream/Connection.js';
import type { MastodonConversation, MastodonConversationService } from './MastodonConversationService.js';
import type { MastodonEntityService } from './MastodonEntityService.js';
import type { MastodonFilterContext, MastodonFilterService } from './MastodonFilterService.js';
import type { MastodonNotificationService, MastodonNotificationSource } from './MastodonNotificationService.js';
import type { MastodonScopeService } from './MastodonScopeService.js';
import type { MastodonUserFeatureService } from './MastodonUserFeatureService.js';
import type { MastodonUserAuth } from './types.js';

export const MASTODON_STREAMS = [
	'user',
	'user:notification',
	'public',
	'public:local',
	'public:media',
	'public:local:media',
	'public:remote',
	'public:remote:media',
	'hashtag',
	'hashtag:local',
	'list',
	'direct',
] as const;

export type MastodonStreamName = typeof MASTODON_STREAMS[number];

export type MastodonStreamSubscription = {
	stream: MastodonStreamName;
	tags?: readonly string[];
	listId?: string;
};

export type MastodonStreamOutput = {
	event: string;
	payload?: unknown;
	stream: MastodonStreamName;
	rawPayload?: true;
};

type NativeFrame = {
	type?: string;
	body?: {
		id?: string;
		type?: string;
		body?: unknown;
	};
};

type NativeChannel = {
	id: string;
	descriptor: string;
	targets: Map<string, MastodonStreamSubscription>;
};

type DeliveredNote = {
	note: Packed<'Note'>;
	streams: Set<MastodonStreamName>;
	conversationIds: Map<MastodonStreamName, string>;
};

type SessionOptions = {
	auth: MastodonUserAuth;
	subscriber: EventEmitter;
	nativeStream: MainStreamConnection;
	mastodonScopeService: MastodonScopeService;
	mastodonEntityService: MastodonEntityService;
	mastodonFilterService: MastodonFilterService;
	mastodonNotificationService: MastodonNotificationService;
	mastodonUserFeatureService: MastodonUserFeatureService;
	mastodonConversationService: MastodonConversationService;
	send: (output: MastodonStreamOutput) => void;
	close: () => void;
};

const DELIVERED_NOTE_LIMIT = 1000;
const FOLLOWED_TAG_LIMIT = 20;
const FOLLOWED_TAG_PREFIX = 'followed-tag:';
const MAX_SUBSCRIPTIONS = 32;
const MAX_NATIVE_CHANNELS = 32;

export class MastodonStreamSession {
	readonly #auth: MastodonUserAuth;
	readonly #subscriber: EventEmitter;
	readonly #nativeStream: MainStreamConnection;
	readonly #scopeService: MastodonScopeService;
	readonly #entityService: MastodonEntityService;
	readonly #filterService: MastodonFilterService;
	readonly #notificationService: MastodonNotificationService;
	readonly #userFeatureService: MastodonUserFeatureService;
	readonly #conversationService: MastodonConversationService;
	readonly #send: SessionOptions['send'];
	readonly #close: SessionOptions['close'];
	readonly #subscriptions = new Map<string, MastodonStreamSubscription>();
	readonly #channels = new Map<string, NativeChannel>();
	readonly #channelsById = new Map<string, NativeChannel>();
	readonly #delivered = new Map<string, DeliveredNote>();
	readonly #followedTags = new Set<string>();
	#nativeSocket: (EventEmitter & { send: (data: string | Buffer) => void }) | null = null;
	#nextChannelId = 0;
	#started = false;
	#disposed = false;
	#eventTail = Promise.resolve();

	constructor(options: SessionOptions) {
		this.#auth = options.auth;
		this.#subscriber = options.subscriber;
		this.#nativeStream = options.nativeStream;
		this.#scopeService = options.mastodonScopeService;
		this.#entityService = options.mastodonEntityService;
		this.#filterService = options.mastodonFilterService;
		this.#notificationService = options.mastodonNotificationService;
		this.#userFeatureService = options.mastodonUserFeatureService;
		this.#conversationService = options.mastodonConversationService;
		this.#send = options.send;
		this.#close = options.close;
	}

	public async start(): Promise<void> {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		const socket = new EventEmitter() as EventEmitter & { send: (data: string | Buffer) => void };
		socket.send = data => { void this.handleNativeFrame(data.toString()); };
		this.#nativeSocket = socket;
		await this.#nativeStream.listen(this.#subscriber, socket as never);
		if (this.#disposed || this.#nativeSocket !== socket) {
			this.#subscriber.removeAllListeners();
			this.#nativeStream.dispose();
			socket.removeAllListeners();
			throw new TypeError('Streaming session is not active');
		}
	}

	public async subscribe(input: MastodonStreamSubscription): Promise<void> {
		this.ensureActive();
		const subscription = this.normalize(input);
		const key = this.subscriptionKey(subscription);
		if (this.#subscriptions.has(key)) return;
		this.assertScopes(subscription.stream);
		if (this.#subscriptions.size >= MAX_SUBSCRIPTIONS) throw new TypeError('Too many streaming subscriptions');
		this.#subscriptions.set(key, subscription);
		try {
			await this.connectSubscription(key, subscription);
		} catch (error) {
			this.#subscriptions.delete(key);
			await this.removeTarget(key);
			if (subscription.stream === 'user' && ![...this.#subscriptions.values()].some(value => value.stream === 'user')) {
				for (const tag of [...this.#followedTags]) await this.removeFollowedTag(tag);
			}
			throw error;
		}
	}

	public async unsubscribe(input: MastodonStreamSubscription): Promise<void> {
		const subscription = this.normalize(input);
		const key = this.subscriptionKey(subscription);
		if (!this.#subscriptions.delete(key)) return;
		await this.removeTarget(key);
		if (subscription.stream === 'user' && ![...this.#subscriptions.values()].some(value => value.stream === 'user')) {
			for (const tag of [...this.#followedTags]) await this.removeFollowedTag(tag);
		}
	}

	public handleNativeFrame(data: string): Promise<void> {
		return this.enqueueEvent(() => this.processNativeFrame(data));
	}

	private async processNativeFrame(data: string): Promise<void> {
		let frame: NativeFrame;
		try {
			frame = JSON.parse(data) as NativeFrame;
		} catch {
			return;
		}
		if (frame.type === 'noteUpdated' && frame.body?.id != null && frame.body.type != null) {
			await this.handleNoteEvent(frame.body.id, { type: frame.body.type, body: frame.body.body });
			return;
		}
		if ((frame.type === 'announcementDeleted' || frame.type === 'announcement.delete') && typeof frame.body === 'string') {
			this.emitForUserStreams('announcement.delete', frame.body, true);
			return;
		}
		if (frame.type !== 'channel' || frame.body?.id == null || frame.body.type == null) return;
		const channel = this.#channelsById.get(frame.body.id);
		if (channel == null) return;
		try {
			if (frame.body.type === 'notification') {
				await this.handleNotification(channel, frame.body.body as Packed<'Notification'>);
				return;
			}
			if (frame.body.type === 'announcementCreated') {
				const body = frame.body.body as { announcement?: unknown };
				const announcement = this.#entityService.announcement((body.announcement ?? body) as Packed<'Announcement'>);
				for (const subscription of channel.targets.values()) {
					if (subscription.stream === 'user') this.#send({ event: 'announcement', payload: announcement, stream: 'user' });
				}
				return;
			}
			if (frame.body.type === 'announcementDeleted' || frame.body.type === 'announcement.delete') {
				if (typeof frame.body.body === 'string') this.emitForTargets(channel, 'announcement.delete', frame.body.body, true);
				return;
			}
			if (frame.body.type === 'note' || ['mention', 'reply', 'renote'].includes(frame.body.type)) {
				await this.handleNote(channel, frame.body.body as Packed<'Note'>);
			}
		} catch {
			// A malformed, filtered, or no-longer-visible event must not tear down the stream.
		}
	}

	public handleRedisEvent(event: { channel?: string; message?: unknown }): Promise<void> {
		if (event.channel === `mastodonTokenRevoked:${this.#auth.token.id}`) {
			this.#close();
			return Promise.resolve();
		}
		if (event.channel === 'internal') {
			const internal = event.message as { type?: string; body?: { id?: string; isSuspended?: boolean; isDeleted?: boolean } };
			if (internal.body?.id === this.#auth.user.id &&
				((internal.type === 'userChangeSuspendedState' && internal.body.isSuspended) ||
					(internal.type === 'userChangeDeletedState' && internal.body.isDeleted))) {
				this.#close();
				return Promise.resolve();
			}
		}
		return this.enqueueEvent(() => this.processRedisEvent(event));
	}

	private async processRedisEvent(event: { channel?: string; message?: unknown }): Promise<void> {
		if (event.channel?.startsWith('noteStream:')) {
			await this.handleNoteEvent(event.channel.slice('noteStream:'.length), event.message as { type?: string; body?: unknown });
			return;
		}
		if (event.channel === `mastodonCompat:${this.#auth.user.id}`) {
			const compat = event.message as { type?: string; body?: unknown };
			if (compat.type === 'filters_changed') this.emitForUserStreams('filters_changed');
			if (compat.type === 'notifications_merged') this.emitForUserStreams('notifications_merged');
			if (compat.type === 'followed_tag_changed') {
				await this.refreshFollowedTags();
			}
		}
		if (event.channel != null) this.#subscriber.emit(event.channel, event.message);
	}

	public dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const channel of this.#channels.values()) this.#nativeStream.disconnectChannel(channel.id);
		this.#channels.clear();
		this.#channelsById.clear();
		this.#subscriptions.clear();
		this.#followedTags.clear();
		this.#delivered.clear();
		this.#subscriber.removeAllListeners();
		this.#nativeStream.dispose();
		this.#nativeSocket?.removeAllListeners();
		this.#nativeSocket = null;
	}

	private ensureActive(): void {
		if (!this.#started || this.#disposed) throw new TypeError('Streaming session is not active');
	}

	private enqueueEvent(handler: () => Promise<void>): Promise<void> {
		this.#eventTail = this.#eventTail.then(handler).catch(() => {
			// One malformed or transiently failing event must not poison the session's ordering queue.
		});
		return this.#eventTail;
	}

	private normalize(input: MastodonStreamSubscription): MastodonStreamSubscription {
		if (!MASTODON_STREAMS.includes(input.stream)) throw new TypeError(`Unsupported stream: ${input.stream}`);
		const tags = [...new Set((input.tags ?? []).map(tag => tag.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase()).filter(Boolean))].sort();
		if (input.stream.startsWith('hashtag') && tags.length === 0) throw new TypeError('tag is required for hashtag streams');
		if (tags.length > FOLLOWED_TAG_LIMIT) throw new TypeError(`tag must contain at most ${FOLLOWED_TAG_LIMIT} values`);
		if (tags.some(tag => [...tag].length > 100 || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) throw new TypeError('Invalid hashtag name');
		const listId = input.listId?.trim();
		if (input.stream === 'list' && !listId) throw new TypeError('list is required for list streams');
		return {
			stream: input.stream,
			...(tags.length === 0 ? {} : { tags }),
			...(listId == null || listId === '' ? {} : { listId }),
		};
	}

	private subscriptionKey(subscription: MastodonStreamSubscription): string {
		return JSON.stringify([subscription.stream, subscription.tags ?? [], subscription.listId ?? null]);
	}

	private assertScopes(stream: MastodonStreamName): void {
		if (stream === 'user') {
			this.#scopeService.assertAny(this.#auth.token.scopes, ['read:statuses', 'read:notifications']);
		} else if (stream === 'user:notification') {
			this.#scopeService.assert(this.#auth.token.scopes, 'read:notifications');
		} else {
			this.#scopeService.assert(this.#auth.token.scopes, 'read:statuses');
		}
	}

	private async connectSubscription(key: string, subscription: MastodonStreamSubscription): Promise<void> {
		switch (subscription.stream) {
			case 'user':
				await this.connectTarget(key, subscription, 'main');
				if (this.#scopeService.allows(this.#auth.token.scopes, 'read:statuses')) {
					await this.connectTarget(key, subscription, 'homeTimeline');
					await this.refreshFollowedTags();
				}
				break;
			case 'user:notification':
			case 'direct':
				await this.connectTarget(key, subscription, 'main');
				break;
			case 'public':
			case 'public:media':
			case 'public:remote':
			case 'public:remote:media':
				await this.connectTarget(key, subscription, 'globalTimeline');
				break;
			case 'public:local':
			case 'public:local:media':
				await this.connectTarget(key, subscription, 'localTimeline');
				break;
			case 'hashtag':
			case 'hashtag:local':
				await this.connectTarget(key, subscription, 'hashtag', { q: subscription.tags!.map(tag => [tag]) });
				break;
			case 'list':
				await this.connectTarget(key, subscription, 'userList', { listId: subscription.listId! });
		}
	}

	private async connectTarget(key: string, subscription: MastodonStreamSubscription, channelName: string, params: JsonObject = {}): Promise<void> {
		const descriptor = JSON.stringify([channelName, params]);
		let channel = this.#channels.get(descriptor);
		if (channel == null) {
			if (this.#channels.size >= MAX_NATIVE_CHANNELS) throw new TypeError('Too many streaming channels');
			channel = { id: `mastodon-${this.#nextChannelId++}`, descriptor, targets: new Map() };
			this.#channels.set(descriptor, channel);
			this.#channelsById.set(channel.id, channel);
			try {
				await this.#nativeStream.connectChannel(channel.id, params, channelName);
				if (this.#disposed || this.#channels.get(descriptor) !== channel) {
					this.#nativeStream.disconnectChannel(channel.id);
					throw new TypeError('Streaming session is not active');
				}
			} catch (error) {
				if (this.#channels.get(descriptor) === channel) this.#channels.delete(descriptor);
				if (this.#channelsById.get(channel.id) === channel) this.#channelsById.delete(channel.id);
				throw error;
			}
		}
		channel.targets.set(key, subscription);
	}

	private async removeTarget(key: string): Promise<void> {
		for (const channel of [...this.#channels.values()]) {
			channel.targets.delete(key);
			if (channel.targets.size !== 0) continue;
			this.#nativeStream.disconnectChannel(channel.id);
			this.#channels.delete(channel.descriptor);
			this.#channelsById.delete(channel.id);
		}
	}

	private async addFollowedTag(rawTag: string): Promise<void> {
		if (![...this.#subscriptions.values()].some(value => value.stream === 'user')) return;
		const tag = rawTag.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase();
		if (tag === '' || this.#followedTags.has(tag) || this.#followedTags.size >= FOLLOWED_TAG_LIMIT) return;
		await this.connectTarget(`${FOLLOWED_TAG_PREFIX}${tag}`, { stream: 'user' }, 'hashtag', { q: [[tag]] });
		this.#followedTags.add(tag);
	}

	private async refreshFollowedTags(): Promise<void> {
		if (![...this.#subscriptions.values()].some(value => value.stream === 'user')) return;
		const rows = await this.#userFeatureService.listFollowedTags(this.#auth.user.id);
		const desired = new Set(rows
			.map(row => row.name.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase())
			.filter(Boolean)
			.slice(0, FOLLOWED_TAG_LIMIT));
		for (const tag of [...this.#followedTags]) if (!desired.has(tag)) await this.removeFollowedTag(tag);
		for (const tag of desired) await this.addFollowedTag(tag);
	}

	private async removeFollowedTag(rawTag: string): Promise<void> {
		const tag = rawTag.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase();
		if (!this.#followedTags.delete(tag)) return;
		await this.removeTarget(`${FOLLOWED_TAG_PREFIX}${tag}`);
	}

	private async handleNote(channel: NativeChannel, note: Packed<'Note'>): Promise<void> {
		for (const subscription of channel.targets.values()) {
			const stream = subscription.stream;
			if (stream === 'user:notification') continue;
			if (stream === 'user' && !this.#scopeService.allows(this.#auth.token.scopes, 'read:statuses')) continue;
			if ((stream === 'hashtag:local' || stream.startsWith('public:local')) && note.user.host != null) continue;
			if (stream.startsWith('public:remote') && note.user.host == null) continue;
			if (stream === 'direct' && note.visibility !== 'specified') continue;
			if (stream.endsWith(':media') && (note.files?.length ?? 0) === 0) continue;
			if (this.wasDelivered(stream, note.id)) continue;
			if (stream === 'direct') {
				await this.emitConversation(note, stream);
				continue;
			}
			const status = await this.filteredStatus(note, this.filterContext(stream));
			if (status == null) continue;
			this.remember(stream, note);
			this.#send({ event: 'update', payload: status, stream });
		}
	}

	private async emitConversation(note: Packed<'Note'>, stream: MastodonStreamName): Promise<void> {
		const conversation = await this.#conversationService.upsertLive(this.#auth.user, note.id);
		await this.emitPackedConversation(conversation, stream);
	}

	private async emitPackedConversation(conversation: MastodonConversation, stream: MastodonStreamName): Promise<void> {
		const lastStatus = await this.filteredStatus(conversation.lastStatus, 'home');
		if (lastStatus == null) return;
		this.remember(stream, conversation.lastStatus, conversation.id);
		this.#send({
			event: 'conversation',
			payload: {
				id: conversation.id,
				unread: conversation.unread,
				accounts: conversation.accounts,
				last_status: lastStatus,
			},
			stream,
		});
	}

	private async handleNotification(channel: NativeChannel, native: Packed<'Notification'>): Promise<void> {
		if (!this.#scopeService.allows(this.#auth.token.scopes, 'read:notifications')) return;
		const entity = this.#entityService.notification(native);
		if (entity == null) return;
		const source: MastodonNotificationSource = { native: native as MastodonNotificationSource['native'], entity: entity as MastodonNotificationSource['entity'] };
		const [visible] = await this.#notificationService.list(this.#auth.user.id, [source], { includeFiltered: false });
		if (visible == null) return;
		if (visible.entity.status != null && native.note != null) {
			const [status] = await this.#filterService.apply(this.#auth.user.id, 'notifications', [visible.entity.status], {
				corpora: new Map([[visible.entity.status.id, this.filterCorpus(native.note)]]),
			});
			if (status == null) return;
			visible.entity = { ...visible.entity, status };
		}
		for (const subscription of channel.targets.values()) {
			if (subscription.stream === 'user' || subscription.stream === 'user:notification') {
				this.#send({ event: 'notification', payload: visible.entity, stream: subscription.stream });
			}
		}
	}

	private async filteredStatus(note: Packed<'Note'>, context: MastodonFilterContext): Promise<Record<string, unknown> | null> {
		const status = this.#entityService.status(note) as Record<string, unknown>;
		const [filtered] = await this.#filterService.apply(this.#auth.user.id, context, [status], {
			corpora: new Map([[note.id, this.filterCorpus(note)]]),
		});
		return filtered ?? null;
	}

	private filterCorpus(note: Packed<'Note'>): string[] {
		const corpus: string[] = [];
		if (note.text != null) corpus.push(note.text);
		if (note.cw != null) corpus.push(note.cw);
		for (const file of note.files ?? []) if (file.comment != null) corpus.push(file.comment);
		for (const choice of note.poll?.choices ?? []) corpus.push(choice.text);
		if (note.renote != null) corpus.push(...this.filterCorpus(note.renote));
		return corpus;
	}

	private filterContext(stream: MastodonStreamName): MastodonFilterContext {
		return stream.startsWith('public') || stream.startsWith('hashtag') ? 'public' : 'home';
	}

	private wasDelivered(stream: MastodonStreamName, noteId: string): boolean {
		return this.#delivered.get(noteId)?.streams.has(stream) ?? false;
	}

	private remember(stream: MastodonStreamName, note: Packed<'Note'>, conversationId?: string): void {
		let delivered = this.#delivered.get(note.id);
		if (delivered == null) {
			delivered = { note, streams: new Set(), conversationIds: new Map() };
			this.#delivered.set(note.id, delivered);
		} else {
			delivered.note = note;
		}
		delivered.streams.add(stream);
		if (conversationId != null) delivered.conversationIds.set(stream, conversationId);
		if (this.#delivered.size > DELIVERED_NOTE_LIMIT) this.#delivered.delete(this.#delivered.keys().next().value!);
	}

	private async handleNoteEvent(noteId: string, event: { type?: string; body?: unknown }): Promise<void> {
		const delivered = this.#delivered.get(noteId);
		if (delivered == null) return;
		const streams = [...delivered.streams];
		if (event.type === 'deleted') {
			this.#delivered.delete(noteId);
			for (const stream of streams) {
				if (stream === 'direct') {
					const conversationId = delivered.conversationIds.get(stream);
					if (conversationId == null) continue;
					const conversation = await this.#conversationService.refreshLive(this.#auth.user, conversationId);
					if (conversation != null) await this.emitPackedConversation(conversation, stream);
					continue;
				}
				this.#send({ event: 'delete', payload: noteId, stream, rawPayload: true });
			}
			return;
		}
		if (event.type !== 'updated') return;
		const outer = event.body as { body?: Partial<Packed<'Note'>> } | undefined;
		const changes = outer?.body ?? event.body as Partial<Packed<'Note'>> | undefined;
		const updated = { ...delivered.note, ...(changes ?? {}) } as Packed<'Note'>;
		delivered.note = updated;
		for (const stream of streams) {
			if (stream === 'direct') {
				await this.emitConversation(updated, stream);
				continue;
			}
			const status = await this.filteredStatus(updated, this.filterContext(stream));
			if (status == null) continue;
			this.#send({ event: 'status.update', payload: status, stream });
		}
	}

	private emitForTargets(channel: NativeChannel, event: string, payload?: unknown, rawPayload?: true): void {
		for (const subscription of channel.targets.values()) {
			this.#send({ event, ...(arguments.length < 3 ? {} : { payload }), stream: subscription.stream, ...(rawPayload ? { rawPayload } : {}) });
		}
	}

	private emitForUserStreams(event: string, payload?: unknown, rawPayload?: true): void {
		const streams = new Set<MastodonStreamName>();
		for (const subscription of this.#subscriptions.values()) {
			if (subscription.stream === 'user' || subscription.stream === 'user:notification') streams.add(subscription.stream);
		}
		for (const stream of streams) {
			this.#send({ event, ...(arguments.length < 2 ? {} : { payload }), stream, ...(rawPayload ? { rawPayload } : {}) });
		}
	}
}
