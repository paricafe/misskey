/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { Inject, Injectable } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import * as Redis from 'ioredis';
import * as WebSocket from 'ws';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiAccessToken } from '@/models/AccessToken.js';
import type { Packed } from '@/misc/json-schema.js';
import type { JsonObject } from '@/misc/json-value.js';
import MainStreamConnection, { type ConnectionRequest } from '@/server/api/stream/Connection.js';
import type * as http from 'node:http';
import type { MastodonAuth } from './types.js';
import { MastodonAuthenticateService } from './MastodonAuthenticateService.js';
import { MastodonEntityService } from './MastodonEntityService.js';
import { MastodonScopeService } from './MastodonScopeService.js';

const MAX_BUFFERED_BYTES = 1024 * 1024;
const ALLOWED_STREAMS = new Set(['user', 'user:notification', 'public', 'public:local', 'public:media', 'public:local:media', 'hashtag', 'hashtag:local', 'list', 'direct']);

type ConnectionContext = {
	auth: MastodonAuth;
	streams: Set<string>;
	tags: Set<string>;
	listId: string | null;
	subscriber: EventEmitter;
	nativeStream: MainStreamConnection;
	channelStreams: Map<string, Set<string>>;
	deliveredNoteStreams: Map<string, Set<string>>;
	lastPongAt: number;
};

type NativeChannelFrame = {
	type?: string;
	body?: {
		id?: string;
		type?: string;
		body?: unknown;
	};
};

export function isMastodonStreamingPath(path: string): boolean {
	return path === '/api/v1/streaming' || path.startsWith('/api/v1/streaming/');
}

export function mastodonStreamEvent(event: string, payload: unknown, stream: string): string {
	return JSON.stringify({ event, payload: JSON.stringify(payload), stream: [stream] });
}

@Injectable()
export class MastodonStreamingApiServerService {
	#wss: WebSocket.WebSocketServer | null = null;
	#server: http.Server | null = null;
	#connections = new Map<WebSocket.WebSocket, ConnectionContext>();
	#heartbeatInterval: NodeJS.Timeout | null = null;

	constructor(
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		private moduleRef: ModuleRef,
		private mastodonAuthenticateService: MastodonAuthenticateService,
		private mastodonScopeService: MastodonScopeService,
		private mastodonEntityService: MastodonEntityService,
	) {}

	@bindThis
	public attach(server: http.Server): void {
		this.#server = server;
		this.#wss = new WebSocket.WebSocketServer({ noServer: true });
		server.on('upgrade', this.onUpgrade);
		this.redisForSub.on('message', this.onRedisMessage);
		this.#wss.on('connection', (connection: WebSocket.WebSocket, _request: http.IncomingMessage, context: ConnectionContext) => {
			this.#connections.set(connection, context);
			connection.on('pong', () => { context.lastPongAt = Date.now(); });
			void this.startNativeStream(connection, context).catch(() => connection.terminate());
			connection.once('close', () => {
				context.subscriber.removeAllListeners();
				context.nativeStream.dispose();
				this.#connections.delete(connection);
			});
		});
		this.#heartbeatInterval = setInterval(() => {
			const now = Date.now();
			for (const [connection, context] of this.#connections) {
				if (now - context.lastPongAt > 90_000) connection.terminate();
				else connection.ping();
			}
		}, 30_000);
	}

	@bindThis
	private async onUpgrade(request: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
		if (request.url == null) return;
		try {
			const url = new URL(request.url, 'http://localhost');
			if (!isMastodonStreamingPath(url.pathname)) return;
			const authorization = request.headers.authorization;
			const token = authorization?.startsWith('Bearer ')
				? authorization.slice(7)
				: url.searchParams.get('access_token');
			if (token == null || token === '') {
				this.reject(socket, 401, 'Unauthorized');
				return;
			}
			const auth = await this.mastodonAuthenticateService.authenticate(token);
			const streams = this.getStreams(url);
			this.assertScopes(auth, streams);
			const contextId = ContextIdFactory.create();
			const permissions = new Set(['read:account', ...this.mastodonScopeService.toMisskeyPermissions(auth.token.scopes)]);
			const syntheticToken = {
				id: auth.token.id,
				userId: auth.user.id,
				permission: [...permissions],
			} as MiAccessToken;
			this.moduleRef.registerRequestByContextId<ConnectionRequest>({ user: auth.user, token: syntheticToken }, contextId);
			const nativeStream = await this.moduleRef.create(MainStreamConnection, contextId);
			await nativeStream.init();
			const context: ConnectionContext = {
				auth,
				streams,
				tags: new Set(url.searchParams.getAll('tag').map(tag => tag.toLowerCase())),
				listId: url.searchParams.get('list'),
				subscriber: new EventEmitter(),
				nativeStream,
				channelStreams: new Map(),
				deliveredNoteStreams: new Map(),
				lastPongAt: Date.now(),
			};
			this.#wss!.handleUpgrade(request, socket, head, ws => {
				this.#wss!.emit('connection', ws, request, context);
			});
		} catch {
			this.reject(socket, 401, 'Unauthorized');
		}
	}

	private getStreams(url: URL): Set<string> {
		const streams = new Set([...url.searchParams.getAll('stream'), ...url.searchParams.getAll('stream[]')]);
		const suffix = url.pathname.slice('/api/v1/streaming/'.length);
		if (suffix !== url.pathname && suffix !== '') streams.add(suffix.replaceAll('/', ':'));
		if (streams.size === 0) streams.add('user');
		for (const stream of streams) {
			if (!ALLOWED_STREAMS.has(stream)) throw new TypeError(`Unsupported stream: ${stream}`);
		}
		if ([...streams].some(stream => stream.startsWith('hashtag')) && url.searchParams.getAll('tag').length === 0) {
			throw new TypeError('tag is required for hashtag streams');
		}
		if (streams.has('list') && url.searchParams.get('list') == null) throw new TypeError('list is required for list streams');
		return streams;
	}

	private assertScopes(auth: MastodonAuth, streams: ReadonlySet<string>): void {
		const statusStream = [...streams].some(stream => stream !== 'user:notification');
		const notificationStream = streams.has('user') || streams.has('user:notification');
		if (statusStream) this.mastodonScopeService.assert(auth.token.scopes, 'read:statuses');
		if (notificationStream && !statusStream) this.mastodonScopeService.assert(auth.token.scopes, 'read:notifications');
	}

	private async startNativeStream(connection: WebSocket.WebSocket, context: ConnectionContext): Promise<void> {
		const nativeSocket = new EventEmitter() as EventEmitter & { send: (data: string | Buffer) => void };
		nativeSocket.send = data => this.onNativeFrame(connection, context, data.toString());
		await context.nativeStream.listen(context.subscriber, nativeSocket as unknown as WebSocket.WebSocket);

		let id = 0;
		const connect = async (streams: Iterable<string>, channel: string, params: JsonObject = {}) => {
			const channelId = `mastodon-${id++}`;
			context.channelStreams.set(channelId, new Set(streams));
			await context.nativeStream.connectChannel(channelId, params, channel);
		};
		const mainStreams = ['user', 'user:notification', 'direct'].filter(stream => context.streams.has(stream));
		if (mainStreams.length > 0) await connect(mainStreams, 'main');
		if (context.streams.has('user')) await connect(['user'], 'homeTimeline');
		const publicStreams = ['public', 'public:media'].filter(stream => context.streams.has(stream));
		if (publicStreams.length > 0) await connect(publicStreams, 'globalTimeline');
		const localStreams = ['public:local', 'public:local:media'].filter(stream => context.streams.has(stream));
		if (localStreams.length > 0) await connect(localStreams, 'localTimeline');
		for (const stream of ['hashtag', 'hashtag:local']) {
			if (context.streams.has(stream)) await connect([stream], 'hashtag', { q: [...context.tags].map(tag => [tag]) });
		}
		if (context.streams.has('list')) await connect(['list'], 'userList', { listId: context.listId! });
	}

	private onNativeFrame(connection: WebSocket.WebSocket, context: ConnectionContext, data: string): void {
		let frame: NativeChannelFrame;
		try {
			frame = JSON.parse(data) as NativeChannelFrame;
		} catch {
			return;
		}
		if (frame.type !== 'channel' || frame.body?.id == null || frame.body.type == null) return;
		const streams = context.channelStreams.get(frame.body.id);
		if (streams == null) return;

		try {
			if (frame.body.type === 'notification') {
				if (!this.mastodonScopeService.allows(context.auth.token.scopes, 'read:notifications')) return;
				const notification = this.mastodonEntityService.notification(frame.body.body as Packed<'Notification'>);
				if (notification != null) {
					for (const stream of streams) if (stream === 'user' || stream === 'user:notification') this.send(connection, 'notification', notification, stream);
				}
			} else if (frame.body.type === 'note' || ['mention', 'reply', 'renote'].includes(frame.body.type)) {
				const note = frame.body.body as Packed<'Note'>;
				for (const stream of streams) {
					if (stream === 'user:notification') continue;
					if (stream === 'hashtag:local' && note.user.host != null) continue;
					if (stream === 'direct' && note.visibility !== 'specified') continue;
					if (stream.endsWith(':media') && (note.files?.length ?? 0) === 0) continue;
					let deliveredStreams = context.deliveredNoteStreams.get(note.id);
					if (deliveredStreams?.has(stream)) continue;
					if (deliveredStreams == null) {
						deliveredStreams = new Set();
						context.deliveredNoteStreams.set(note.id, deliveredStreams);
					}
					deliveredStreams.add(stream);
					this.send(connection, 'update', this.mastodonEntityService.status(note), stream);
				}
				if (context.deliveredNoteStreams.size > 1000) context.deliveredNoteStreams.delete(context.deliveredNoteStreams.keys().next().value!);
			}
		} catch {
			// A malformed or no-longer-visible event must not tear down the stream.
		}
	}

	@bindThis
	private onRedisMessage(_channel: string, data: string): void {
		let event: { channel?: string; message?: unknown };
		try {
			event = JSON.parse(data) as { channel?: string; message?: unknown };
		} catch {
			return;
		}

		for (const [connection, context] of this.#connections) {
			if (event.channel === `mastodonTokenRevoked:${context.auth.token.id}`) {
				connection.terminate();
				continue;
			}
			if (event.channel === 'internal') {
				const internal = event.message as { type?: string; body?: { id?: string; isSuspended?: boolean; isDeleted?: boolean } };
				if (internal.body?.id === context.auth.user.id && ((internal.type === 'userChangeSuspendedState' && internal.body.isSuspended) || (internal.type === 'userChangeDeletedState' && internal.body.isDeleted))) {
					connection.terminate();
					continue;
				}
			}
			if (event.channel?.startsWith('noteStream:')) {
				const noteEvent = event.message as { type?: string };
				if (noteEvent.type === 'deleted') {
					const noteId = event.channel.slice('noteStream:'.length);
					for (const stream of context.deliveredNoteStreams.get(noteId) ?? []) this.send(connection, 'delete', noteId, stream);
					context.deliveredNoteStreams.delete(noteId);
				}
			}
			if (event.channel != null) context.subscriber.emit(event.channel, event.message);
		}
	}

	private send(connection: WebSocket.WebSocket, event: string, payload: unknown, stream: string): void {
		if (connection.readyState !== WebSocket.WebSocket.OPEN) return;
		if (connection.bufferedAmount > MAX_BUFFERED_BYTES) {
			connection.terminate();
			return;
		}
		connection.send(mastodonStreamEvent(event, payload, stream));
	}

	private reject(socket: import('node:stream').Duplex, status: number, message: string): void {
		socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
		socket.destroy();
	}

	@bindThis
	public async detach(): Promise<void> {
		if (this.#heartbeatInterval != null) {
			clearInterval(this.#heartbeatInterval);
			this.#heartbeatInterval = null;
		}
		this.#server?.off('upgrade', this.onUpgrade);
		this.#server = null;
		this.redisForSub.off('message', this.onRedisMessage);
		for (const connection of this.#connections.keys()) connection.terminate();
		this.#connections.clear();
		const wss = this.#wss;
		this.#wss = null;
		if (wss == null) return;
		await new Promise<void>(resolve => wss.close(() => resolve()));
	}
}
