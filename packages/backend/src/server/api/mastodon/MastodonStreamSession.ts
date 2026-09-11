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
	streamParams?: readonly string[];
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
	subscriptions: Map<string, MastodonStreamSubscription>;
	conversationIds: Map<string, string>;
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
	resolveNote: (noteId: string) => Promise<Packed<'Note'> | null>;
	decorateStatus?: (note: Packed<'Note'>, status: Record<string, unknown>) => Promise<Record<string, unknown>>;
	filterStatuses?: (statuses: Record<string, unknown>[], context: MastodonFilterContext) => Promise<Record<string, unknown>[]>;
	filterNotifications?: (notifications: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>;
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
	readonly #resolveNote: SessionOptions['resolveNote'];
	readonly #decorateStatus: SessionOptions['decorateStatus'];
	readonly #filterStatuses: SessionOptions['filterStatuses'];
	readonly #filterNotifications: SessionOptions['filterNotifications'];
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
		this.#resolveNote = options.resolveNote;
		this.#decorateStatus = options.decorateStatus;
		this.#filterStatuses = options.filterStatuses;
		this.#filterNotifications = options.filterNotifications;
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
		for (const [noteId, delivered] of this.#delivered) {
			delivered.subscriptions.delete(key);
			delivered.conversationIds.delete(key);
			if (delivered.subscriptions.size === 0) this.#delivered.delete(noteId);
		}
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
					if (subscription.stream === 'user') this.sendTo(subscription, { event: 'announcement', payload: announcement });
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
		const tags = input.stream.startsWith('hashtag')
			? [...new Set((input.tags ?? []).map(tag => tag.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase()).filter(Boolean))].sort()
			: [];
		if (input.stream.startsWith('hashtag') && tags.length === 0) throw new TypeError('tag is required for hashtag streams');
		if (tags.length > FOLLOWED_TAG_LIMIT) throw new TypeError(`tag must contain at most ${FOLLOWED_TAG_LIMIT} values`);
		if (tags.some(tag => [...tag].length > 100 || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) throw new TypeError('Invalid hashtag name');
		const listId = input.stream === 'list' ? input.listId?.trim() : undefined;
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
		const targets = new Map<string, MastodonStreamSubscription>();
		for (const subscription of channel.targets.values()) {
			const stream = subscription.stream;
			if (!this.isSubscribed(subscription) || stream === 'user:notification') continue;
			if (stream === 'user' && !this.#scopeService.allows(this.#auth.token.scopes, 'read:statuses')) continue;
			if ((stream === 'hashtag:local' || stream.startsWith('public:local')) && note.user.host != null) continue;
			if (stream.startsWith('public:remote') && note.user.host == null) continue;
			if (stream === 'direct' && note.visibility !== 'specified') continue;
			if (stream.endsWith(':media') && (note.files?.length ?? 0) === 0) continue;
			if (this.wasDelivered(subscription, note.id)) continue;
			targets.set(this.subscriptionKey(subscription), subscription);
		}
		const subscriptions = [...targets.values()];
		if (subscriptions.length === 0) return;

		const directConversation = subscriptions.some(subscription => subscription.stream === 'direct')
			? await this.#conversationService.upsertLive(this.#auth.user, note.id)
			: null;
		const voterCounts = await this.#entityService.pollVoterCounts([
			...(subscriptions.some(subscription => subscription.stream !== 'direct') ? [note] : []),
			...(directConversation == null ? [] : [directConversation.lastStatus]),
		]);
		for (const subscription of subscriptions) {
			if (subscription.stream === 'direct') {
				if (directConversation != null) await this.emitPackedConversation(directConversation, subscription, voterCounts);
				continue;
			}
			const status = await this.filteredStatus(note, this.filterContext(subscription.stream), voterCounts);
			if (status == null) continue;
			this.remember(subscription, note);
			this.sendTo(subscription, { event: 'update', payload: status });
		}
	}

	private async emitPackedConversation(
		conversation: MastodonConversation,
		subscription: MastodonStreamSubscription,
		voterCounts: ReadonlyMap<string, number>,
	): Promise<void> {
		const lastStatus = await this.filteredStatus(conversation.lastStatus, 'home', voterCounts);
		if (lastStatus == null) return;
		this.remember(subscription, conversation.lastStatus, conversation.id);
		this.sendTo(subscription, {
			event: 'conversation',
			payload: {
				id: conversation.id,
				unread: conversation.unread,
				accounts: conversation.accounts,
				last_status: lastStatus,
			},
		});
	}

	private async handleNotification(channel: NativeChannel, native: Packed<'Notification'>): Promise<void> {
		if (!this.#scopeService.allows(this.#auth.token.scopes, 'read:notifications')) return;
		const voterCounts = await this.#entityService.pollVoterCounts(native.note == null ? [] : [native.note]);
		const entity = this.#entityService.notification(native, voterCounts);
		if (entity == null) return;
		const [allowed] = await this.#filterNotifications?.([entity]) ?? [entity];
		if (allowed == null) return;
		const source: MastodonNotificationSource = { native: native as MastodonNotificationSource['native'], entity: allowed as MastodonNotificationSource['entity'] };
		const [visible] = await this.#notificationService.list(this.#auth.user.id, [source], { includeFiltered: false });
		if (visible == null) return;
		if (visible.entity.status != null && native.note != null) {
			if (native.note.isHidden) return;
			const decorated = await this.#decorateStatus?.(native.note, visible.entity.status) ?? visible.entity.status;
			const allowedStatuses = await this.#filterStatuses?.([decorated], 'notifications') ?? [decorated];
			const [status] = await this.#filterService.apply(this.#auth.user.id, 'notifications', allowedStatuses, {
				corpora: new Map([[visible.entity.status.id, this.filterCorpus(native.note)]]),
			});
			if (status == null) return;
			visible.entity = { ...visible.entity, status: status as NonNullable<MastodonNotificationSource['entity']['status']> };
		}
		for (const subscription of channel.targets.values()) {
			if (subscription.stream === 'user' || subscription.stream === 'user:notification') {
				this.sendTo(subscription, { event: 'notification', payload: visible.entity });
			}
		}
	}

	private async filteredStatus(
		note: Packed<'Note'>,
		context: MastodonFilterContext,
		voterCounts: ReadonlyMap<string, number>,
	): Promise<Record<string, unknown> | null> {
		if (note.isHidden) return null;
		const entity = this.#entityService.status(note, voterCounts) as Record<string, unknown>;
		const status = await this.#decorateStatus?.(note, entity) ?? entity;
		const allowed = await this.#filterStatuses?.([status], context) ?? [status];
		const [filtered] = await this.#filterService.apply(this.#auth.user.id, context, allowed, {
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

	private wasDelivered(subscription: MastodonStreamSubscription, noteId: string): boolean {
		return this.#delivered.get(noteId)?.subscriptions.has(this.subscriptionKey(subscription)) ?? false;
	}

	private remember(subscription: MastodonStreamSubscription, note: Packed<'Note'>, conversationId?: string): void {
		if (!this.isSubscribed(subscription)) return;
		const key = this.subscriptionKey(subscription);
		let delivered = this.#delivered.get(note.id);
		if (delivered == null) {
			delivered = { subscriptions: new Map(), conversationIds: new Map() };
			this.#delivered.set(note.id, delivered);
		}
		delivered.subscriptions.set(key, subscription);
		if (conversationId != null) delivered.conversationIds.set(key, conversationId);
		if (this.#delivered.size > DELIVERED_NOTE_LIMIT) this.#delivered.delete(this.#delivered.keys().next().value!);
	}

	private async handleNoteEvent(noteId: string, event: { type?: string; body?: unknown }): Promise<void> {
		const delivered = this.#delivered.get(noteId);
		if (delivered == null) return;
		const subscriptions = [...delivered.subscriptions.values()].filter(subscription => this.isSubscribed(subscription));
		if (subscriptions.length === 0) {
			this.#delivered.delete(noteId);
			return;
		}
		if (event.type === 'deleted') {
			this.#delivered.delete(noteId);
			for (const subscription of subscriptions) {
				if (subscription.stream === 'direct') {
					const conversationId = delivered.conversationIds.get(this.subscriptionKey(subscription));
					if (conversationId == null) continue;
					const conversation = await this.#conversationService.refreshLive(this.#auth.user, conversationId);
					if (conversation != null) {
						const voterCounts = await this.#entityService.pollVoterCounts([conversation.lastStatus]);
						await this.emitPackedConversation(conversation, subscription, voterCounts);
					}
					continue;
				}
				this.sendTo(subscription, { event: 'delete', payload: noteId, rawPayload: true });
			}
			return;
		}
		if (event.type !== 'updated') return;
		// Redis note events are global. Repack for this viewer instead of reusing access granted before an unfollow or block.
		const updated = await this.#resolveNote(noteId);
		if (updated == null || updated.isHidden) {
			this.#delivered.delete(noteId);
			return;
		}
		const directConversation = subscriptions.some(subscription => subscription.stream === 'direct')
			? await this.#conversationService.upsertLive(this.#auth.user, updated.id)
			: null;
		const voterCounts = await this.#entityService.pollVoterCounts([
			...(subscriptions.some(subscription => subscription.stream !== 'direct') ? [updated] : []),
			...(directConversation == null ? [] : [directConversation.lastStatus]),
		]);
		for (const subscription of subscriptions) {
			if (subscription.stream === 'direct') {
				if (directConversation != null) await this.emitPackedConversation(directConversation, subscription, voterCounts);
				continue;
			}
			const status = await this.filteredStatus(updated, this.filterContext(subscription.stream), voterCounts);
			if (status == null) continue;
			this.sendTo(subscription, { event: 'status.update', payload: status });
		}
	}

	private emitForTargets(channel: NativeChannel, event: string, payload?: unknown, rawPayload?: true): void {
		for (const subscription of channel.targets.values()) {
			this.sendTo(subscription, { event, ...(arguments.length < 3 ? {} : { payload }), ...(rawPayload ? { rawPayload } : {}) });
		}
	}

	private emitForUserStreams(event: string, payload?: unknown, rawPayload?: true): void {
		for (const subscription of this.#subscriptions.values()) {
			if (subscription.stream === 'user' || subscription.stream === 'user:notification') {
				this.sendTo(subscription, { event, ...(arguments.length < 2 ? {} : { payload }), ...(rawPayload ? { rawPayload } : {}) });
			}
		}
	}

	private isSubscribed(subscription: MastodonStreamSubscription): boolean {
		return !this.#disposed && this.#subscriptions.has(this.subscriptionKey(subscription));
	}

	private sendTo(subscription: MastodonStreamSubscription, output: Omit<MastodonStreamOutput, 'stream' | 'streamParams'>): void {
		if (!this.isSubscribed(subscription)) return;
		const streamParams = subscription.stream === 'list' ? [subscription.listId!] : subscription.stream.startsWith('hashtag') ? subscription.tags : undefined;
		this.#send({ ...output, stream: subscription.stream, ...(streamParams == null ? {} : { streamParams }) });
	}
}
