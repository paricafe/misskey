/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { IncomingMessage, Server } from 'node:http';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import type { EntityConverter } from './entities.js';
import { applyFilters, conversationFromNote, conversationState, latestConversationNote } from './features.js';
import { decorateStatus, hydrateStatus } from './metadata.js';
import { NativeError } from './native-client.js';
import type { NativeClient } from './native-client.js';
import { allowsScope, toNativePermissions } from './scopes.js';
import type { CompatStore, Grant } from './store.js';
import type { Json } from './types.js';

export interface StreamingDependencies {
	native: Pick<NativeClient, 'call' | 'socketUrl' | 'socketPath'>;
	entities: EntityConverter;
	store: CompatStore;
	publicUrl: string;
}

type UserGrant = Grant & { kind: 'user'; userId: string; nativeToken: string };
type Subscription = {
	key: string;
	stream: string;
	identity: string[];
	tag?: string;
	list?: string;
	media: boolean;
};
type NativeChannel = { id: string; descriptor: string; targets: Set<string> };
type Delivery = { targets: Set<string>; nestedIds: Set<string>; conversation?: Json };

const MAX_SUBSCRIPTIONS = 32;
const MAX_TRACKED_NOTES = 1000;
const MAX_PENDING_EVENTS = 256;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 15_000;
const streamNames = new Set(['user', 'user:notification', 'public', 'public:local', 'public:remote', 'public:media', 'public:local:media', 'public:remote:media', 'hashtag', 'hashtag:local', 'list', 'direct']);

class StreamError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}

function object(value: unknown): value is Json {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function subscription(input: Json): Subscription {
	if (typeof input.stream !== 'string' || !streamNames.has(input.stream)) throw new StreamError(400, 'Unknown stream type');
	const stream = input.stream;
	const identity = [stream];
	let tag: string | undefined;
	let list: string | undefined;
	if (stream.startsWith('hashtag')) {
		if (typeof input.tag !== 'string' || !input.tag.trim() || input.tag.length > 128 || /[\s#]/u.test(input.tag)) throw new StreamError(400, 'A hashtag is required');
		tag = input.tag.normalize('NFKC').toLowerCase();
		identity.push(tag);
	}
	if (stream === 'list') {
		if (!identifier(input.list)) throw new StreamError(400, 'A list ID is required');
		list = input.list;
		identity.push(list);
	}
	return { key: JSON.stringify(identity), stream, identity, tag, list, media: stream.endsWith(':media') };
}

async function authorizedGrant(store: StreamingDependencies['store'], token: string): Promise<UserGrant> {
	const grant = await store.getGrant(token);
	if (!grant || grant.kind !== 'user' || !identifier(grant.userId) || !grant.nativeToken) throw new StreamError(401, 'The access token is invalid');
	if (!allowsScope(grant.scopes, 'read:statuses') && !allowsScope(grant.scopes, 'read:notifications')) throw new StreamError(403, 'A read scope is required');
	return grant as UserGrant;
}

function authorizeSubscription(grant: UserGrant, target: Subscription): void {
	const required = target.stream === 'user:notification' ? 'read:notifications' : 'read:statuses';
	if (target.stream === 'user') {
		if (allowsScope(grant.scopes, 'read:statuses') || allowsScope(grant.scopes, 'read:notifications')) return;
	}
	if (!allowsScope(grant.scopes, required)) throw new StreamError(403, `Scope ${required} is required`);
}

function credential(request: IncomingMessage, url: URL): string {
	const tokens = url.searchParams.getAll('access_token');
	if (tokens.length > 1) throw new StreamError(401, 'The access token is invalid');
	const authorization = request.headers.authorization;
	const bearer = authorization == null ? undefined : /^Bearer ([^\s]+)$/iu.exec(authorization)?.[1];
	if (authorization != null && !bearer) throw new StreamError(401, 'The access token is invalid');
	const token = bearer ?? tokens[0];
	if (!token || token.length > 4096 || (bearer && tokens[0] && bearer !== tokens[0])) throw new StreamError(401, 'The access token is invalid');
	return token;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	if (socket.destroyed) return;
	const body = JSON.stringify({ error: message });
	const reason = ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable' } as Record<number, string>)[status] ?? 'Bad Request';
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`);
}

async function openNative(native: StreamingDependencies['native'], token: string, signal: AbortSignal): Promise<WebSocket> {
	const socketPath = native.socketPath;
	const socket = new WebSocket(native.socketUrl(token), {
		handshakeTimeout: 10_000, maxPayload: MAX_BUFFERED_BYTES, followRedirects: false,
		// ws resets socketPath internally; keep the HTTP URL intact and override only the transport.
		...(socketPath ? { createConnection: () => createConnection({ path: socketPath }) } : {}),
	});
	// A transport error may contain its credential-bearing URL. It must never reach a client or a logger.
	socket.on('error', () => undefined);
	await new Promise<void>((resolve, reject) => {
		const abort = () => { cleanup(); socket.terminate(); reject(new StreamError(503, 'The streaming connection was cancelled')); };
		const failed = () => { cleanup(); reject(new StreamError(502, 'The native streaming service is unavailable')); };
		const cleanup = () => {
			signal.removeEventListener('abort', abort);
			socket.off('open', ready);
			socket.off('error', failed);
			socket.off('close', failed);
		};
		const ready = () => { cleanup(); resolve(); };
		socket.once('open', ready);
		socket.once('error', failed);
		socket.once('close', failed);
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) abort();
	}).catch(error => { socket.terminate(); throw error; });
	return socket;
}

class StreamingSession {
	private readonly subscriptions = new Map<string, Subscription>();
	private readonly desiredSubscriptions = new Map<string, Subscription>();
	private readonly channels = new Map<string, NativeChannel>();
	private readonly channelsById = new Map<string, NativeChannel>();
	private readonly delivered = new Map<string, Delivery>();
	private readonly nativeNoteIds = new Map<string, Set<string>>();
	private channelSequence = 0;
	private queue: Promise<void> = Promise.resolve();
	private pendingEvents = 0;
	private ended = false;
	private alive = true;
	private validating = false;
	private readonly heartbeat: NodeJS.Timeout;
	private readonly controller = new AbortController();

	constructor(
		private readonly client: WebSocket,
		private readonly upstream: WebSocket,
		private readonly deps: StreamingDependencies,
		private readonly token: string,
		private readonly grant: UserGrant,
		private filterRevision: unknown,
		private readonly onClosed: () => void,
	) {
		client.on('error', () => this.close());
		client.on('close', () => this.close());
		client.on('pong', () => { this.alive = true; });
		client.on('message', (data, binary) => {
			if (binary) { this.enqueue(() => this.sendError(new StreamError(400, 'Only JSON text messages are supported'))); return; }
			try {
				const input: unknown = JSON.parse(data.toString());
				if (!object(input) || !['subscribe', 'unsubscribe'].includes(input.type)) throw new StreamError(400, 'Invalid subscription request');
				const target = subscription(input);
				if (input.type === 'unsubscribe') {
					this.desiredSubscriptions.delete(target.key);
					this.enqueue(() => this.unsubscribe(target));
				} else this.requestSubscription(target);
			} catch (error) { this.enqueue(() => this.sendError(error)); }
		});
		upstream.on('message', (data, binary) => {
			if (!binary) this.enqueue(() => this.nativeFrame(data.toString()));
		});
		upstream.on('error', () => this.close(1011, 'The native streaming connection failed'));
		upstream.on('close', () => this.close(1012, 'The native streaming connection closed'));
		this.heartbeat = setInterval(() => {
			if (this.validating || this.ended) return;
			if (!this.alive) { this.close(); return; }
			this.validating = true;
			void (async () => {
				if (await this.currentGrant() == null) return;
				await this.checkFilters();
				if (this.ended || this.client.readyState !== WebSocket.OPEN) return;
				this.alive = false;
				this.client.ping();
				const user = await this.native<Json>('i');
				if (user.id !== this.grant.userId || user.isSuspended === true || user.isDeleted === true) this.close(1008, 'The access token is invalid');
			})().catch(() => this.close(1008, 'The native authorization is unavailable')).finally(() => { this.validating = false; });
		}, HEARTBEAT_MS);
		this.heartbeat.unref();
	}

	requestSubscription(target: Subscription): void {
		const existing = this.subscriptions.get(target.key);
		if (existing && this.desiredSubscriptions.get(target.key) === existing) return;
		this.desiredSubscriptions.set(target.key, target);
		this.enqueue(() => this.subscribe(target));
	}

	private async subscribe(target: Subscription): Promise<void> {
		if (this.desiredSubscriptions.get(target.key) !== target) return;
		const grant = await this.currentGrant();
		if (!grant) return;
		authorizeSubscription(grant, target);
		if (this.subscriptions.has(target.key)) return;
		if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new StreamError(400, 'Too many stream subscriptions');
		if (target.list) await this.native('users/lists/show', { listId: target.list });
		if (this.ended || this.desiredSubscriptions.get(target.key) !== target) return;
		this.subscriptions.set(target.key, target);
		if (target.stream === 'user' || target.stream === 'direct') {
			if (allowsScope(grant.scopes, 'read:statuses')) this.connect(target, 'homeTimeline');
			if (target.stream === 'direct' || allowsScope(grant.scopes, 'read:notifications')) this.connect(target, 'main');
		} else if (target.stream === 'user:notification') this.connect(target, 'main');
		else if (target.stream.startsWith('hashtag')) this.connect(target, 'hashtag', { q: [[target.tag]] });
		else if (target.list) this.connect(target, 'userList', { listId: target.list, withRenotes: true });
		else this.connect(target, target.stream.startsWith('public:local') ? 'localTimeline' : 'globalTimeline', { withRenotes: true, withFiles: false });
	}

	close(code = 1001, reason = 'The streaming connection closed'): void {
		if (this.ended) return;
		this.ended = true;
		clearInterval(this.heartbeat);
		this.controller.abort();
		this.subscriptions.clear();
		this.desiredSubscriptions.clear();
		this.delivered.clear();
		this.nativeNoteIds.clear();
		this.channels.clear();
		this.channelsById.clear();
		this.upstream.terminate();
		if (this.client.readyState === WebSocket.OPEN) {
			this.client.close(code, reason);
			const forceClose = setTimeout(() => this.client.terminate(), 1000);
			forceClose.unref();
		} else this.client.terminate();
		this.onClosed();
	}

	private async currentGrant(): Promise<UserGrant | null> {
		if (this.ended) return null;
		try {
			const grant = await authorizedGrant(this.deps.store, this.token);
			if (this.ended) return null;
			if (grant.userId !== this.grant.userId || grant.nativeToken !== this.grant.nativeToken) throw new StreamError(401, 'The access token is invalid');
			return grant;
		} catch {
			this.close(1008, 'The access token is invalid');
			return null;
		}
	}

	private async native<T>(endpoint: string, body: Json = {}): Promise<T> {
		return await this.deps.native.call<T>(endpoint, body, this.grant.nativeToken, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]) });
	}

	private connect(target: Subscription, name: string, params: Json = {}): void {
		const descriptor = JSON.stringify([name, params]);
		const existing = this.channels.get(descriptor);
		if (existing) { existing.targets.add(target.key); return; }
		const channel = { id: `mc_${++this.channelSequence}`, descriptor, targets: new Set([target.key]) };
		this.channels.set(descriptor, channel);
		this.channelsById.set(channel.id, channel);
		this.nativeSend({ type: 'connect', body: { id: channel.id, channel: name, params, pong: true } });
	}

	private async unsubscribe(target: Subscription): Promise<void> {
		if (!await this.currentGrant()) return;
		if (!this.subscriptions.delete(target.key)) return;
		for (const channel of this.channels.values()) {
			channel.targets.delete(target.key);
			if (channel.targets.size > 0) continue;
			this.channels.delete(channel.descriptor);
			this.channelsById.delete(channel.id);
			this.nativeSend({ type: 'disconnect', body: { id: channel.id } });
		}
		for (const [noteId, delivery] of this.delivered) {
			delivery.targets.delete(target.key);
			if (delivery.targets.size === 0) this.forget(noteId);
		}
	}

	private nativeSend(message: Json): void {
		if (this.ended || this.upstream.readyState !== WebSocket.OPEN) return;
		if (this.upstream.bufferedAmount > MAX_BUFFERED_BYTES) { this.close(1013, 'The streaming client is too slow'); return; }
		this.upstream.send(JSON.stringify(message));
	}

	private enqueue(action: () => Promise<void>): void {
		if (this.ended) return;
		if (++this.pendingEvents > MAX_PENDING_EVENTS) { this.close(1013, 'Too many pending streaming events'); return; }
		this.queue = this.queue.then(async () => {
			if (await this.currentGrant()) { await this.checkFilters(); if (!this.ended) await action(); }
		}).catch(async error => {
			if (error instanceof NativeError && [401, 403].includes(error.status)) this.close(1008, 'The native authorization is unavailable');
			else if (error instanceof StreamError) await this.sendError(error);
			// Hidden/deleted entities and malformed native frames are intentionally not emitted.
		}).finally(() => { this.pendingEvents--; });
	}

	private async sendError(error: unknown): Promise<void> {
		if (!await this.currentGrant() || this.client.readyState !== WebSocket.OPEN) return;
		const failure = error instanceof StreamError ? error : new StreamError(400, 'Invalid subscription request');
		this.client.send(JSON.stringify({ error: failure.message, status: failure.status }));
	}

	private async checkFilters(): Promise<void> {
		const revision = await this.deps.store.get('filter-revision', this.grant.userId, 'current');
		if (revision === this.filterRevision) return;
		this.filterRevision = revision;
		for (const target of this.subscriptions.values()) {
			if (target.stream === 'user') await this.send(target, 'filters_changed');
		}
	}

	private async send(target: Subscription, event: string, payload?: Json | string): Promise<boolean> {
		const grant = await this.currentGrant();
		if (!grant || this.desiredSubscriptions.get(target.key) !== target || this.subscriptions.get(target.key) !== target || this.client.readyState !== WebSocket.OPEN) return false;
		const required = event === 'notification' ? 'read:notifications' : 'read:statuses';
		if (event !== 'filters_changed' && !allowsScope(grant.scopes, required)) return false;
		if (this.client.bufferedAmount > MAX_BUFFERED_BYTES) { this.close(1013, 'The streaming client is too slow'); return false; }
		this.client.send(JSON.stringify({ stream: target.identity, event, ...(payload === undefined ? {} : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }) }));
		return true;
	}

	private async nativeFrame(data: string): Promise<void> {
		let frame: unknown;
		try { frame = JSON.parse(data); } catch { return; }
		if (!object(frame) || !object(frame.body)) return;
		if (frame.type === 'noteUpdated' && identifier(frame.body.id)) {
			if (frame.body.type === 'updated' || frame.body.type === 'deleted') await this.noteChanged(frame.body.id);
			return;
		}
		if (frame.type !== 'channel' || typeof frame.body.id !== 'string') return;
		const channel = this.channelsById.get(frame.body.id);
		if (!channel || !object(frame.body.body)) return;
		if (frame.body.type === 'notification') await this.notification(channel, frame.body.body);
		else if (['note', 'mention', 'reply', 'renote'].includes(frame.body.type) && identifier(frame.body.body.id)) {
			const note = await this.visibleNote(frame.body.body.id);
			if (note) await this.deliverNote(note, [...channel.targets], 'update');
		}
	}

	private async visibleNote(noteId: string): Promise<Json | null> {
		try {
			const note = await this.native<Json>('notes/show', { noteId });
			return object(note) && note.id === noteId && this.deps.entities.status(note, { viewerId: this.grant.userId }) != null ? note : null;
		} catch (error) {
			if (error instanceof NativeError && (error.status === 404 || error.code === 'NO_SUCH_NOTE')) return null;
			throw error;
		}
	}

	private matches(target: Subscription, note: Json): boolean {
		if (target.stream === 'user:notification') return false;
		if (target.stream === 'direct') return note.visibility === 'specified';
		if (target.stream.startsWith('public') || target.stream.startsWith('hashtag')) {
			if (note.visibility !== 'public' || note.channelId != null) return false;
		}
		if (target.stream.includes(':local') && note.user?.host != null) return false;
		if (target.stream.includes(':remote') && note.user?.host == null) return false;
		if (target.media && !note.files?.length) return false;
		if (target.tag && (!Array.isArray(note.tags) || !note.tags.some((tag: unknown) => typeof tag === 'string' && tag.normalize('NFKC').toLowerCase() === target.tag))) return false;
		return true;
	}

	private async deliverNote(note: Json, keys: string[], event: 'update' | 'status.update'): Promise<void> {
		const status = this.deps.entities.status(note, { viewerId: this.grant.userId });
		if (!status) return;
		let hydrated: Json | undefined;
		for (const key of keys) {
			const target = this.subscriptions.get(key);
			if (!target || !this.matches(target, note)) continue;
			if (event === 'update' && this.delivered.get(note.id)?.targets.has(key)) continue;
			if (target.stream === 'direct') {
				const conversation = await this.conversation(note, status);
				if (conversation && await this.send(target, 'conversation', conversation)) this.remember(note, target, conversation);
			} else {
				const context = target.stream.startsWith('public') || target.stream.startsWith('hashtag') ? 'public' : 'home';
				hydrated ??= await this.hydratedStatus(status);
				const decorated = await applyFilters(this.deps.store, this.grant.userId, hydrated, context);
				if (await this.send(target, event, decorated)) this.remember(note, target);
			}
		}
	}

	private async notification(channel: NativeChannel, source: Json): Promise<void> {
		if (!allowsScope((await this.currentGrant())?.scopes ?? [], 'read:notifications')) return;
		let note: Json | null = null;
		if (object(source.note)) {
			if (!identifier(source.note.id)) return;
			note = await this.visibleNote(source.note.id);
			if (!note) return;
		}
		const converted = this.deps.entities.notification({ ...source, ...(note ? { note } : {}) });
		if (!converted) return;
		if (note) {
			const status = this.deps.entities.status(note, { viewerId: this.grant.userId });
			if (!status) return;
			converted.status = await applyFilters(this.deps.store, this.grant.userId, await this.hydratedStatus(status), 'notifications');
		}
		for (const key of channel.targets) {
			const target = this.subscriptions.get(key);
			if (target && ['user', 'user:notification'].includes(target.stream)) await this.send(target, 'notification', converted);
		}
	}

	private remember(note: Json, target: Subscription, conversation?: Json): void {
		let delivery = this.delivered.get(note.id);
		if (!delivery) {
			delivery = { targets: new Set(), nestedIds: new Set() };
			this.delivered.set(note.id, delivery);
		}
		delivery.targets.add(target.key);
		if (conversation) delivery.conversation = conversation;
		const ids = new Set<string>();
		let current: unknown = note;
		for (let depth = 0; depth < 3 && object(current) && identifier(current.id); depth++) {
			ids.add(current.id);
			current = current.renote;
		}
		for (const id of delivery.nestedIds) {
			if (!ids.has(id)) this.releaseNoteReference(id, note.id);
		}
		delivery.nestedIds = ids;
		for (const id of ids) {
			let targets = this.nativeNoteIds.get(id);
			if (!targets) {
				targets = new Set();
				this.nativeNoteIds.set(id, targets);
				this.nativeSend({ type: 'subNote', body: { id } });
			}
			targets.add(note.id);
		}
		while (this.delivered.size > MAX_TRACKED_NOTES) this.forget(this.delivered.keys().next().value!);
	}

	private forget(noteId: string): void {
		const delivery = this.delivered.get(noteId);
		if (!delivery) return;
		this.delivered.delete(noteId);
		for (const id of delivery.nestedIds) this.releaseNoteReference(id, noteId);
	}

	private releaseNoteReference(id: string, noteId: string): void {
		const targets = this.nativeNoteIds.get(id);
		if (!targets) return;
		targets.delete(noteId);
		if (targets.size === 0) {
			this.nativeNoteIds.delete(id);
			this.nativeSend({ type: 'unsubNote', body: { id } });
		}
	}

	private async noteChanged(changedId: string): Promise<void> {
		const affected = [...this.nativeNoteIds.get(changedId) ?? []];
		for (const noteId of affected) {
			const delivery = this.delivered.get(noteId);
			if (!delivery) continue;
			const note = await this.visibleNote(noteId);
			if (!note) {
				for (const key of delivery.targets) {
					const target = this.subscriptions.get(key);
					if (target?.stream === 'direct') await this.refreshConversation(target, delivery, noteId);
					else if (target) await this.send(target, 'delete', noteId);
				}
				this.forget(noteId);
				continue;
			}
			for (const key of [...delivery.targets]) {
				const target = this.subscriptions.get(key);
				if (!target || this.matches(target, note)) continue;
				if (target.stream === 'direct') await this.refreshConversation(target, delivery, noteId);
				else await this.send(target, 'delete', noteId);
				delivery.targets.delete(key);
			}
			if (delivery.targets.size === 0) this.forget(noteId);
			else await this.deliverNote(note, [...delivery.targets], 'status.update');
		}
	}

	private async refreshConversation(target: Subscription, delivery: Delivery, removedId: string): Promise<void> {
		const previous = delivery.conversation;
		if (!previous) return;
		const note = await latestConversationNote(this.deps.store, this.grant.userId, previous.id, this.native.bind(this), removedId);
		if (note) {
			const status = this.deps.entities.status(note, { viewerId: this.grant.userId });
			const conversation = status ? await this.conversation(note, status) : null;
			if (conversation && await this.send(target, 'conversation', conversation)) this.remember(note, target, conversation);
		} else if (!(await conversationState(this.deps.store, this.grant.userId, previous.id, { id: removedId })).hidden) {
			await this.send(target, 'conversation', { ...previous, last_status: null, unread: false });
		}
	}

	private async conversation(note: Json, status: Json): Promise<Json | null> {
		const conversation = await conversationFromNote(this.deps.store, this.grant.userId, note, this.native.bind(this), this.deps.entities, { status: await decorateStatus(this.deps.store, status, this.grant.userId) });
		if (conversation?.last_status) conversation.last_status = await this.hydratedStatus(conversation.last_status);
		return conversation;
	}

	private async hydratedStatus(status: Json): Promise<Json> {
		const grant = await this.currentGrant();
		if (!grant) throw new StreamError(401, 'The access token is invalid');
		const reads = new Map<string, Promise<Json>>();
		return await hydrateStatus(this.deps.store, await decorateStatus(this.deps.store, status, grant.userId), grant.userId, toNativePermissions(grant.scopes).includes('read:account'), (endpoint, body) => {
			const key = JSON.stringify([endpoint, body]);
			let response = reads.get(key);
			if (!response) { response = this.native<Json>(endpoint, body); reads.set(key, response); }
			return response;
		});
	}
}

/** Owns only the compatibility upgrade path; native routes remain owned by the host. */
export function attachStreaming(server: Server, deps: StreamingDependencies): { close(): Promise<void> } {
	const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
	const sessions = new Set<StreamingSession>();
	const pending = new Map<Duplex, AbortController>();
	let closed = false;
	const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		let url: URL;
		try { url = new URL(request.url ?? '/', deps.publicUrl); } catch { return; }
		if (url.pathname !== '/api/v1/streaming' && url.pathname !== '/api/v1/streaming/') return;
		if (closed) { rejectUpgrade(socket, 503, 'The streaming service is shutting down'); return; }
		const controller = new AbortController();
		pending.set(socket, controller);
		const disconnect = () => controller.abort();
		socket.once('close', disconnect);
		void (async () => {
			let upstream: WebSocket | undefined;
			let adopted = false;
			try {
				const token = credential(request, url);
				const grant = await authorizedGrant(deps.store, token);
				if (['stream', 'tag', 'list'].some(name => url.searchParams.getAll(name).length > 1)) throw new StreamError(400, 'A subscription parameter was repeated');
				const initial = url.searchParams.has('stream') ? subscription(Object.fromEntries(url.searchParams)) : null;
				if (initial) authorizeSubscription(grant, initial);
				const context = { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) };
				const user = await deps.native.call<Json>('i', {}, grant.nativeToken, context);
				if (user.id !== grant.userId || user.isSuspended === true || user.isDeleted === true) throw new StreamError(401, 'The access token is invalid');
				if (initial?.list) await deps.native.call('users/lists/show', { listId: initial.list }, grant.nativeToken, context);
				upstream = await openNative(deps.native, grant.nativeToken, controller.signal);
				if (closed || socket.destroyed || controller.signal.aborted) { upstream.terminate(); return; }
				if (upstream.readyState !== WebSocket.OPEN) throw new StreamError(502, 'The native streaming connection closed');
				const filterRevision = await deps.store.get('filter-revision', grant.userId, 'current');
				const current = await authorizedGrant(deps.store, token);
				if (current.userId !== grant.userId || current.nativeToken !== grant.nativeToken) throw new StreamError(401, 'The access token is invalid');
				if (initial) authorizeSubscription(current, initial);
				if (closed || socket.destroyed || controller.signal.aborted) { upstream.terminate(); return; }
				if (upstream.readyState !== WebSocket.OPEN) throw new StreamError(502, 'The native streaming connection closed');
				wss.handleUpgrade(request, socket, head, client => {
					adopted = true;
					const session = new StreamingSession(client, upstream!, deps, token, current, filterRevision, () => sessions.delete(session));
					sessions.add(session);
					if (initial) session.requestSubscription(initial);
				});
			} catch (error) {
				upstream?.terminate();
				if (error instanceof StreamError) rejectUpgrade(socket, error.status, error.message);
				else if (error instanceof NativeError && [401, 403, 404].includes(error.status)) rejectUpgrade(socket, error.status, 'Native authorization or stream access was denied');
				else rejectUpgrade(socket, 502, 'The native streaming service is unavailable');
			} finally {
				if (!adopted) upstream?.terminate();
				pending.delete(socket);
				socket.off('close', disconnect);
			}
		})();
	};
	server.on('upgrade', upgrade);
	return {
		async close() {
			if (closed) return;
			closed = true;
			server.off('upgrade', upgrade);
			for (const [socket, controller] of pending) { controller.abort(); socket.destroy(); }
			for (const session of [...sessions]) session.close();
			for (const client of wss.clients) client.terminate();
			await new Promise<void>(resolve => wss.close(() => resolve()));
		},
	};
}
