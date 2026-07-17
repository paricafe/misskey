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
import MainStreamConnection, { type ConnectionRequest } from '@/server/api/stream/Connection.js';
import type * as http from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { MastodonApiError } from './errors.js';
import { MastodonAuthenticateService } from './MastodonAuthenticateService.js';
import { MastodonConversationService } from './MastodonConversationService.js';
import { MastodonEntityService } from './MastodonEntityService.js';
import { MastodonFilterService } from './MastodonFilterService.js';
import { MastodonNotificationService } from './MastodonNotificationService.js';
import { MastodonScopeService } from './MastodonScopeService.js';
import {
	MASTODON_STREAMS,
	MastodonStreamSession,
	type MastodonStreamName,
	type MastodonStreamOutput,
	type MastodonStreamSubscription,
} from './MastodonStreamSession.js';
import type { MastodonUserAuth } from './types.js';
import { MastodonUserFeatureService } from './MastodonUserFeatureService.js';

const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_INCOMING_FRAME_BYTES = 64 * 1024;
const SSE_HEARTBEAT_MILLISECONDS = 15_000;

type WebSocketContext = {
	session: MastodonStreamSession;
	lastPongAt: number;
	messageTail: Promise<void>;
};

type MultiplexMessage = {
	type?: unknown;
	stream?: unknown;
	tag?: unknown;
	'tag[]'?: unknown;
	list?: unknown;
	listId?: unknown;
	only_media?: unknown;
};

export function isMastodonStreamingPath(path: string): boolean {
	return path === '/api/v1/streaming' || path.startsWith('/api/v1/streaming/');
}

export function mastodonStreamEvent(
	event: string,
	payload: unknown,
	stream: string,
	options: { rawPayload?: boolean; omitPayload?: boolean } = {},
): string {
	return JSON.stringify({
		event,
		...(options.omitPayload ? {} : { payload: options.rawPayload ? payload : JSON.stringify(payload) }),
		stream: [stream],
	});
}

export function mastodonSseEvent(output: MastodonStreamOutput): string {
	const data = output.rawPayload ? String(output.payload) : JSON.stringify(output.payload);
	return `event: ${output.event}\ndata: ${data}\n\n`;
}

export function parseMastodonStreamSubscriptions(url: URL): MastodonStreamSubscription[] {
	const rawStreams = [...url.searchParams.getAll('stream'), ...url.searchParams.getAll('stream[]')];
	const suffix = url.pathname.slice('/api/v1/streaming/'.length);
	if (suffix !== url.pathname && suffix !== '') rawStreams.push(suffix.replaceAll('/', ':'));
	const onlyMedia = ['true', '1'].includes(url.searchParams.get('only_media') ?? '');
	const tags = [...url.searchParams.getAll('tag'), ...url.searchParams.getAll('tag[]')];
	const listId = url.searchParams.get('list') ?? url.searchParams.get('list_id') ?? undefined;
	return [...new Set(rawStreams)].map(rawStream => {
		let stream = rawStream;
		if (onlyMedia) {
			if (stream === 'public') stream = 'public:media';
			if (stream === 'public:local') stream = 'public:local:media';
			if (stream === 'public:remote') stream = 'public:remote:media';
		}
		if (!MASTODON_STREAMS.includes(stream as MastodonStreamName)) throw new TypeError(`Unsupported stream: ${stream}`);
		const normalizedTags = [...new Set(tags.map(tag => tag.normalize('NFKC').trim().replace(/^#+/u, '').toLowerCase()).filter(Boolean))].sort();
		if (stream.startsWith('hashtag')) {
			if (normalizedTags.length === 0) throw new TypeError('tag is required for hashtag streams');
			if (normalizedTags.length > 20) throw new TypeError('tag must contain at most 20 values');
			if (normalizedTags.some(tag => [...tag].length > 100 || !/^[\p{L}\p{M}\p{N}_]+$/u.test(tag))) throw new TypeError('Invalid hashtag name');
		}
		if (stream === 'list' && (listId == null || listId.trim() === '')) throw new TypeError('list is required for list streams');
		return {
			stream: stream as MastodonStreamName,
			...(stream.startsWith('hashtag') ? { tags: normalizedTags } : {}),
			...(stream === 'list' ? { listId } : {}),
		};
	});
}

@Injectable()
export class MastodonStreamingApiServerService {
	#wss: WebSocket.WebSocketServer | null = null;
	#server: http.Server | null = null;
	#connections = new Map<WebSocket.WebSocket, WebSocketContext>();
	#sessions = new Set<MastodonStreamSession>();
	#sseClosers = new Set<() => void>();
	#heartbeatInterval: NodeJS.Timeout | null = null;

	constructor(
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		private moduleRef: ModuleRef,
		private mastodonAuthenticateService: MastodonAuthenticateService,
		private mastodonScopeService: MastodonScopeService,
		private mastodonEntityService: MastodonEntityService,
		private mastodonFilterService: MastodonFilterService,
		private mastodonNotificationService: MastodonNotificationService,
		private mastodonUserFeatureService: MastodonUserFeatureService,
		private mastodonConversationService: MastodonConversationService,
	) {}

	@bindThis
	public attach(server: http.Server): void {
		this.#server = server;
		this.#wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: MAX_INCOMING_FRAME_BYTES });
		server.on('upgrade', this.onUpgrade);
		this.redisForSub.on('message', this.onRedisMessage);
		this.#wss.on('connection', (connection: WebSocket.WebSocket, _request: http.IncomingMessage, context: WebSocketContext, initial: MastodonStreamSubscription[]) => {
			this.#connections.set(connection, context);
			this.#sessions.add(context.session);
			connection.once('close', () => {
				context.session.dispose();
				this.#sessions.delete(context.session);
				this.#connections.delete(connection);
			});
			connection.on('error', () => {
				// Protocol errors (including maxPayload) are reflected by the close frame.
			});
			connection.on('pong', () => { context.lastPongAt = Date.now(); });
			context.messageTail = this.startSessionIfTokenActive(context.session, connection, initial).catch(() => {
				connection.terminate();
			});
			connection.on('message', data => {
				context.messageTail = context.messageTail
					.then(() => this.onMultiplexMessage(connection, context.session, data))
					.catch(() => {
						// onMultiplexMessage reports protocol errors; keep the per-connection queue usable.
					});
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
			if (!isMastodonStreamingPath(url.pathname) || url.pathname === '/api/v1/streaming/health') return;
			const auth = await this.authenticate(url, request.headers, true);
			const initial = parseMastodonStreamSubscriptions(url);
			this.assertInitialScopes(auth, initial);
			let connection!: WebSocket.WebSocket;
			const session = await this.createSession(auth, {
				send: output => this.sendWebSocket(connection, output),
				close: () => connection.terminate(),
			});
			const context: WebSocketContext = { session, lastPongAt: Date.now(), messageTail: Promise.resolve() };
			this.#wss!.handleUpgrade(request, socket, head, ws => {
				connection = ws;
				this.#wss!.emit('connection', ws, request, context, initial);
			});
		} catch (error) {
			const status = error instanceof MastodonApiError ? error.statusCode : error instanceof TypeError ? 400 : 401;
			this.reject(socket, status, status === 403 ? 'Forbidden' : status === 400 ? 'Bad Request' : 'Unauthorized');
		}
	}

	private async startSessionIfTokenActive(
		session: MastodonStreamSession,
		connection: WebSocket.WebSocket,
		initial: readonly MastodonStreamSubscription[],
	): Promise<void> {
		const context = this.#connections.get(connection);
		if (context == null) return;
		// Token and user IDs are captured by the session's close invalidations; revalidate after registration before native listeners start.
		const requestAuth = await this.authenticationForSession(session);
		const active = await this.mastodonAuthenticateService.isActiveUserToken(requestAuth.token.id, requestAuth.user.id);
		if (!active || connection.readyState !== WebSocket.WebSocket.OPEN) {
			connection.terminate();
			return;
		}
		await session.start();
		for (const subscription of initial) await session.subscribe(subscription);
	}

	private async authenticationForSession(session: MastodonStreamSession): Promise<MastodonUserAuth> {
		const stored = this.#sessionAuth.get(session);
		if (stored == null) throw new TypeError('Missing streaming authentication');
		return stored;
	}

	readonly #sessionAuth = new WeakMap<MastodonStreamSession, MastodonUserAuth>();

	private async createSession(
		auth: MastodonUserAuth,
		adapter: { send: (output: MastodonStreamOutput) => void; close: () => void },
	): Promise<MastodonStreamSession> {
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
		const session = new MastodonStreamSession({
			auth,
			subscriber: new EventEmitter(),
			nativeStream,
			mastodonScopeService: this.mastodonScopeService,
			mastodonEntityService: this.mastodonEntityService,
			mastodonFilterService: this.mastodonFilterService,
			mastodonNotificationService: this.mastodonNotificationService,
			mastodonUserFeatureService: this.mastodonUserFeatureService,
			mastodonConversationService: this.mastodonConversationService,
			send: adapter.send,
			close: adapter.close,
		});
		this.#sessionAuth.set(session, auth);
		return session;
	}

	private async authenticate(url: URL, headers: http.IncomingHttpHeaders, websocket: boolean): Promise<MastodonUserAuth> {
		const authorization = typeof headers.authorization === 'string' ? headers.authorization : undefined;
		const bearer = authorization?.match(/^Bearer[\t ]+(.+)$/iu)?.[1];
		const protocol = websocket && typeof headers['sec-websocket-protocol'] === 'string' ? headers['sec-websocket-protocol'] : null;
		const token = bearer != null
			? bearer
			: url.searchParams.get('access_token') ?? protocol;
		if (token == null || token === '') throw new MastodonApiError(401, 'unauthorized', 'Unauthorized');
		const auth = await this.mastodonAuthenticateService.authenticate(token);
		if (auth.kind === 'application') throw new MastodonApiError(401, 'unauthorized', 'Unauthorized');
		return auth;
	}

	private async onMultiplexMessage(connection: WebSocket.WebSocket, session: MastodonStreamSession, data: WebSocket.RawData): Promise<void> {
		try {
			const value = JSON.parse(data.toString()) as MultiplexMessage;
			if (value == null || typeof value !== 'object' || (value.type !== 'subscribe' && value.type !== 'unsubscribe')) {
				throw new TypeError('type must be subscribe or unsubscribe');
			}
			const subscription = this.multiplexSubscription(value);
			if (value.type === 'subscribe') await session.subscribe(subscription);
			else await session.unsubscribe(subscription);
		} catch (error) {
			if (connection.readyState !== WebSocket.WebSocket.OPEN) return;
			connection.send(JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid streaming message', status: 400 }));
		}
	}

	private multiplexSubscription(value: MultiplexMessage): MastodonStreamSubscription {
		if (typeof value.stream !== 'string') throw new TypeError('stream is required');
		let stream = value.stream;
		const onlyMedia = value.only_media === true || value.only_media === 'true' || value.only_media === 1 || value.only_media === '1';
		if (onlyMedia) {
			if (stream === 'public') stream = 'public:media';
			if (stream === 'public:local') stream = 'public:local:media';
			if (stream === 'public:remote') stream = 'public:remote:media';
		}
		if (!MASTODON_STREAMS.includes(stream as MastodonStreamName)) throw new TypeError(`Unsupported stream: ${stream}`);
		const rawTags = value.tag ?? value['tag[]'];
		const tags = Array.isArray(rawTags) ? rawTags : rawTags == null ? [] : [rawTags];
		if (tags.some(tag => typeof tag !== 'string')) throw new TypeError('tag must be a string');
		const rawListId = value.list ?? value.listId;
		if (rawListId != null && typeof rawListId !== 'string') throw new TypeError('list must be a string');
		return {
			stream: stream as MastodonStreamName,
			...(tags.length === 0 ? {} : { tags: tags as string[] }),
			...(rawListId == null ? {} : { listId: rawListId }),
		};
	}

	private assertInitialScopes(auth: MastodonUserAuth, subscriptions: readonly MastodonStreamSubscription[]): void {
		for (const subscription of subscriptions) {
			if (subscription.stream === 'user') this.mastodonScopeService.assertAny(auth.token.scopes, ['read:statuses', 'read:notifications']);
			else if (subscription.stream === 'user:notification') this.mastodonScopeService.assert(auth.token.scopes, 'read:notifications');
			else this.mastodonScopeService.assert(auth.token.scopes, 'read:statuses');
		}
	}

	private sendWebSocket(connection: WebSocket.WebSocket, output: MastodonStreamOutput): void {
		if (connection.readyState !== WebSocket.WebSocket.OPEN) return;
		if (connection.bufferedAmount > MAX_BUFFERED_BYTES) {
			connection.terminate();
			return;
		}
		connection.send(mastodonStreamEvent(output.event, output.payload, output.stream, {
			rawPayload: output.rawPayload,
			omitPayload: !Object.hasOwn(output, 'payload'),
		}));
	}

	public async handleSse(request: FastifyRequest, reply: FastifyReply): Promise<void> {
		const url = new URL(request.raw.url ?? request.url, 'http://localhost');
		const auth = await this.authenticate(url, request.headers, false);
		const initial = parseMastodonStreamSubscriptions(url);
		if (initial.length === 0) throw new MastodonApiError(400, 'invalid_request', 'stream is required for SSE');
		this.assertInitialScopes(auth, initial);
		let session: MastodonStreamSession | null = null;
		let heartbeat: NodeJS.Timeout | null = null;
		let resolveClosed!: () => void;
		const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
		let disposed = false;
		const cleanup = () => {
			if (disposed) return;
			disposed = true;
			request.raw.off('aborted', cleanup);
			request.raw.off('close', cleanup);
			reply.raw.off('close', cleanup);
			this.#sseClosers.delete(closeTransport);
			if (heartbeat != null) clearInterval(heartbeat);
			if (session != null) {
				session.dispose();
				this.#sessions.delete(session);
			}
			resolveClosed();
		};
		const closeTransport = () => {
			if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
			cleanup();
		};
		const write = (data: string): void => {
			if (disposed || reply.raw.destroyed || reply.raw.writableEnded) return;
			const bytes = Buffer.byteLength(data);
			if (reply.raw.writableLength + bytes > MAX_BUFFERED_BYTES) {
				reply.raw.end();
				cleanup();
				return;
			}
			const accepted = reply.raw.write(data);
			if (!accepted && reply.raw.writableLength > MAX_BUFFERED_BYTES) {
				reply.raw.end();
				cleanup();
			}
		};
		session = await this.createSession(auth, { send: output => write(mastodonSseEvent(output)), close: closeTransport });
		this.#sessions.add(session);
		this.#sseClosers.add(closeTransport);
		request.raw.once('aborted', cleanup);
		request.raw.once('close', cleanup);
		reply.raw.once('close', cleanup);
		let active: boolean;
		try {
			active = await this.mastodonAuthenticateService.isActiveUserToken(auth.token.id, auth.user.id);
		} catch (error) {
			cleanup();
			throw error;
		}
		if (disposed) return;
		if (!active) {
			cleanup();
			throw new MastodonApiError(401, 'unauthorized', 'Unauthorized');
		}
		reply.hijack();
		reply.raw.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'private, no-store',
			Connection: 'keep-alive',
		});
		try {
			await session.start();
			for (const subscription of initial) await session.subscribe(subscription);
		} catch {
			closeTransport();
			return;
		}
		if (disposed) return;
		heartbeat = setInterval(() => write(': heartbeat\n\n'), SSE_HEARTBEAT_MILLISECONDS);
		await closed;
	}

	@bindThis
	private onRedisMessage(_channel: string, data: string): void {
		let event: { channel?: string; message?: unknown };
		try {
			event = JSON.parse(data) as { channel?: string; message?: unknown };
		} catch {
			return;
		}
		for (const session of this.#sessions) void session.handleRedisEvent(event);
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
		for (const close of this.#sseClosers) close();
		for (const session of this.#sessions) session.dispose();
		this.#connections.clear();
		this.#sessions.clear();
		this.#sseClosers.clear();
		const wss = this.#wss;
		this.#wss = null;
		if (wss == null) return;
		await new Promise<void>(resolve => wss.close(() => resolve()));
	}
}
