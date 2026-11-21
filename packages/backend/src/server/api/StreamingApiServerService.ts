/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import * as WebSocket from 'ws';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { DI } from '@/di-symbols.js';
import type { MiAccessToken } from '@/models/_.js';
import { nativeTokenFingerprint } from '@/misc/token.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser } from '@/models/User.js';
import { UserService } from '@/core/UserService.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { AuthenticateService, AuthenticationError, type StreamingCredential } from './AuthenticateService.js';
import MainStreamConnection, { ConnectionRequest } from './stream/Connection.js';
import { ChannelEventBus } from './stream/ChannelEventBus.js';
import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import type { EventEmitter } from 'node:events';

const AUTHORIZATION_INTERVAL = 10_000;
const AUTHORIZATION_BUCKETS = 40;
const AUTHORIZATION_BATCH_SIZE = 128;
const AUTHORIZATION_MAX_STALENESS = 3 * AUTHORIZATION_INTERVAL;
type StreamingSessions = { credential: StreamingCredential; sockets: Set<WebSocket.WebSocket>; expiry: NodeJS.Timeout };

class AuthorizationQueue {
	private pending = new Set<() => void>();
	private active = 0;

	public run<T>(lookup: (timeoutMs: number) => Promise<T>): Promise<T> {
		const deadline = performance.now() + AUTHORIZATION_INTERVAL;
		return new Promise<T>((resolve, reject) => {
			const run = () => {
				this.active++;
				lookup(Math.max(1, Math.floor(deadline - performance.now()))).then(resolve, reject).finally(() => {
					clearTimeout(timeout);
					// A timed-out query still occupies a database connection until it settles.
					this.active--;
					this.runNext();
				});
			};
			const timeout = setTimeout(() => {
				this.pending.delete(run);
				reject(new Error('Authorization check timed out'));
			}, AUTHORIZATION_INTERVAL);
			timeout.unref();
			this.pending.add(run);
			this.runNext();
		});
	}

	private runNext(): void {
		if (this.active >= 2) return;
		const next = this.pending.values().next();
		if (!next.done) {
			this.pending.delete(next.value);
			next.value();
		}
	}
}

export function isNativeStreamingPath(url: string): boolean {
	try {
		return new URL(url, 'http://localhost').pathname === '/streaming';
	} catch {
		return false;
	}
}

@Injectable()
export class StreamingApiServerService {
	#wss: WebSocket.WebSocketServer;
	#connections = new Map<WebSocket.WebSocket, number>();
	#cleanConnectionsIntervalId: NodeJS.Timeout | null = null;
	#authorizationIntervalId: NodeJS.Timeout | null = null;
	#authorizationBuckets = Array.from({ length: AUTHORIZATION_BUCKETS }, () => new Map<string, StreamingSessions>());
	#handshakes = new AuthorizationQueue();
	#periodicChecks = new AuthorizationQueue();
	#server?: http.Server;
	#upgradeListener?: (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
	#redisListener?: (channel: string, data: string) => void;
	#pendingUpgrades = new Set<Duplex>();
	#pendingInitializations = new Set<Promise<void>>();
	#detaching = false;
	#detachPromise?: Promise<void>;
	#activeUsers = new Map<MiLocalUser['id'], { connections: number; intervalId: NodeJS.Timeout; }>();

	constructor(
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		private moduleRef: ModuleRef,
		private authenticateService: AuthenticateService,
		private usersService: UserService,
	) {
	}

	@bindThis
	public attach(server: http.Server): void {
		this.#server = server;
		this.#wss = new WebSocket.WebSocketServer({
			noServer: true,
			maxPayload: 1024 * 1024,
			perMessageDeflate: false,
		});
		const events = new ChannelEventBus();

		const handleUpgrade = async (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
			if (request.url == null) {
				socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
				socket.destroy();
				return;
			}
			if (!isNativeStreamingPath(request.url)) return;

			const q = new URL(request.url, `http://${request.headers.host}`).searchParams;

			let user: MiLocalUser | null = null;
			let app: MiAccessToken | null = null;

			const token = request.headers.authorization?.startsWith('Bearer ')
				? request.headers.authorization.slice(7)
				: q.get('i');

			try {
				if (token != null) [user, app] = await this.#handshakes.run(timeoutMs => this.authenticateService.authenticate(token, { timeoutMs }));

				if (app !== null && !app.permission.some(p => p === 'read:account')) {
					throw new AuthenticationError('Your app does not have necessary permissions to use websocket API.');
				}
			} catch (e) {
				if (e instanceof AuthenticationError) {
					socket.write([
						'HTTP/1.1 401 Unauthorized',
						'WWW-Authenticate: Bearer realm="Misskey", error="invalid_token", error_description="Failed to authenticate"',
					].join('\r\n') + '\r\n\r\n');
				} else {
					socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
				}
				socket.destroy();
				return;
			}

			if (user?.isSuspended || user?.isDeleted) {
				socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
				socket.destroy();
				return;
			}
			const ev = events.createSubscriber();
			let connection: WebSocket.WebSocket | undefined;
			let invalidated = false;
			const invalidate = () => {
				invalidated = true;
				if (connection) connection.terminate();
				else socket.destroy();
			};
			const tokenHash = user && !app && token ? nativeTokenFingerprint(token) : null;
			if (user) ev.on(`authorization:${user.id}`, (event: GlobalEvents['internal']['payload']) => {
				if ((event.type === 'accessTokenRevoked' && event.body.id === app?.id)
					|| (event.type === 'userTokenRegenerated' && tokenHash != null && ('oldTokenHash' in event.body
						? event.body.oldTokenHash === tokenHash : event.body.oldToken === token))
					|| (event.type === 'userChangeSuspendedState' && event.body.id === user.id && event.body.isSuspended)
					|| (event.type === 'userChangeDeletedState' && event.body.id === user.id && event.body.isDeleted)) invalidate();
			});
			const authorize = async () => {
				if (!user || !token || invalidated || this.#detaching) return;
				try {
					const [currentUser, currentApp] = await this.#handshakes.run(timeoutMs => this.authenticateService.authenticate(token, { fresh: true, updateLastUsedAt: false, timeoutMs }));
					if (currentUser?.id !== user.id || currentUser.isSuspended || currentUser.isDeleted
						|| currentApp?.id !== app?.id
						|| (app && app.permission.some(permission => !currentApp?.permission.includes(permission)))) invalidate();
				} catch {
					invalidate();
				}
			};

			const contextId = ContextIdFactory.create();
			this.moduleRef.registerRequestByContextId<ConnectionRequest>({
				user,
				token: app,
			}, contextId);
			let stream: MainStreamConnection | undefined;
			let adopted = false;
			try {
				stream = await this.moduleRef.create(MainStreamConnection, contextId);
				await stream.init();
				await authorize();
				if (invalidated || this.#detaching || socket.destroyed) return;
				this.#wss.handleUpgrade(request, socket, head, (ws) => {
					connection = ws;
					adopted = true;
					if (user && token) this.watchAuthorization(ws, {
						token, userId: user.id, accessTokenId: app?.id ?? null, permissions: app?.permission ?? [],
					});
					this.#wss.emit('connection', ws, request, {
						stream, user, app, ev,
					});
				});
			} finally {
				if (!adopted) {
					ev.removeAllListeners();
					stream?.dispose();
				}
			}
		};
		this.#upgradeListener = (request, socket, head) => {
			if (request.url != null && !isNativeStreamingPath(request.url)) return;
			if (this.#detaching) { socket.destroy(); return; }
			this.#pendingUpgrades.add(socket);
			const initialization = handleUpgrade(request, socket, head).catch(() => socket.destroy()).then(() => undefined).finally(() => {
				this.#pendingUpgrades.delete(socket);
				this.#pendingInitializations.delete(initialization);
			});
			this.#pendingInitializations.add(initialization);
		};
		server.on('upgrade', this.#upgradeListener);

		this.#redisListener = (_: string, data: string) => {
			const parsed = JSON.parse(data);
			if (parsed.channel === 'internal') {
				const event = parsed.message as GlobalEvents['internal']['payload'];
				if (event.type === 'accessTokenRevoked') events.emit(`authorization:${event.body.userId}`, event);
				else if (event.type === 'userTokenRegenerated' || event.type === 'userChangeSuspendedState' || event.type === 'userChangeDeletedState') {
					events.emit(`authorization:${event.body.id}`, event);
				} else if (event.type === 'chatRoomMemberLeft') {
					events.emit(`chatRoomMembership:${event.body.roomId}:${event.body.userId}`, event);
				}
			}
			events.emit(parsed.channel, parsed.message);
		};
		this.redisForSub.on('message', this.#redisListener);

		this.#wss.on('connection', async (connection: WebSocket.WebSocket, request: http.IncomingMessage, ctx: {
			stream: MainStreamConnection,
			user: MiLocalUser | null;
			app: MiAccessToken | null
			ev: EventEmitter;
		}) => {
			const { stream, user, ev } = ctx;

			this.#connections.set(connection, Date.now());

			if (user) this.onUserConnected(user);

			connection.once('close', () => {
				ev.removeAllListeners();
				stream.dispose();
				this.#connections.delete(connection);
				if (user) this.onUserDisconnected(user);
			});

			connection.on('pong', () => {
				this.#connections.set(connection, Date.now());
			});
			await stream.listen(ev, connection);
		});

		this.#cleanConnectionsIntervalId = setInterval(() => {
			const now = Date.now();
			for (const [connection, lastActive] of this.#connections.entries()) {
				if (now - lastActive > 1000 * 60 * 2) {
					connection.terminate();
					this.#connections.delete(connection);
				} else {
					connection.ping();
				}
			}
		}, 1000 * 60);
		const bucketDuration = AUTHORIZATION_INTERVAL / AUTHORIZATION_BUCKETS;
		const started = performance.now();
		let processedTicks = 0;
		this.#authorizationIntervalId = setInterval(() => {
			const elapsedTicks = Math.floor((performance.now() - started) / bucketDuration);
			const dueTicks = Math.max(processedTicks + 1, elapsedTicks);
			for (let tick = Math.max(processedTicks, dueTicks - AUTHORIZATION_BUCKETS); tick < dueTicks; tick++) {
				const groups = [...this.#authorizationBuckets[tick % AUTHORIZATION_BUCKETS].values()];
				for (let offset = 0; offset < groups.length; offset += AUTHORIZATION_BATCH_SIZE) {
					void this.checkSessions(groups.slice(offset, offset + AUTHORIZATION_BATCH_SIZE));
				}
			}
			processedTicks = dueTicks;
		}, bucketDuration);
	}

	private watchAuthorization(ws: WebSocket.WebSocket, credential: StreamingCredential): void {
		const index = createHash('sha256').update(credential.token).digest().readUInt32BE() % AUTHORIZATION_BUCKETS;
		const bucket = this.#authorizationBuckets[index];
		const key = JSON.stringify(credential);
		let group = bucket.get(key);
		if (group == null) {
			const sockets = new Set<WebSocket.WebSocket>();
			const expiry = setTimeout(() => {
				for (const socket of sockets) socket.terminate();
			}, AUTHORIZATION_MAX_STALENESS).unref();
			group = { credential, sockets, expiry };
			bucket.set(key, group);
		} else {
			group.expiry.refresh();
		}
		group.sockets.add(ws);
		ws.once('close', () => {
			group.sockets.delete(ws);
			if (!group.sockets.size) {
				clearTimeout(group.expiry);
				bucket.delete(key);
			}
		});
	}

	private async checkSessions(groups: StreamingSessions[]): Promise<void> {
		const sockets = groups.map(group => [...group.sockets]);
		const credentials = groups.map(group => group.credential);
		const valid = await this.#periodicChecks.run(timeoutMs => this.authenticateService.verifyStreamingCredentials(credentials, timeoutMs))
			.catch(() => null);
		if (!valid) return;
		for (const [index, connections] of sockets.entries()) {
			if (valid.has(index)) {
				const group = groups[index];
				if (group.sockets.size) group.expiry.refresh();
			} else {
				for (const ws of connections) ws.terminate();
			}
		}
	}

	@bindThis
	private onUserConnected(user: MiLocalUser): void {
		const activeUser = this.#activeUsers.get(user.id);
		if (activeUser) {
			activeUser.connections++;
			return;
		}

		this.usersService.updateLastActiveDate(user);
		this.#activeUsers.set(user.id, {
			connections: 1,
			intervalId: setInterval(() => {
				this.usersService.updateLastActiveDate(user);
			}, 1000 * 60 * 5),
		});
	}

	@bindThis
	private onUserDisconnected(user: MiLocalUser): void {
		const activeUser = this.#activeUsers.get(user.id);
		if (!activeUser) return;

		activeUser.connections--;
		if (activeUser.connections <= 0) {
			clearInterval(activeUser.intervalId);
			this.#activeUsers.delete(user.id);
		}
	}

	@bindThis
	public detach(): Promise<void> {
		if (this.#detachPromise) return this.#detachPromise;
		this.#detaching = true;
		if (this.#upgradeListener) this.#server?.off('upgrade', this.#upgradeListener);
		if (this.#redisListener) this.redisForSub.off('message', this.#redisListener);
		if (this.#cleanConnectionsIntervalId) {
			clearInterval(this.#cleanConnectionsIntervalId);
			this.#cleanConnectionsIntervalId = null;
		}
		if (this.#authorizationIntervalId) {
			clearInterval(this.#authorizationIntervalId);
			this.#authorizationIntervalId = null;
		}
		for (const socket of this.#pendingUpgrades) socket.destroy();
		const close = new Promise<void>(resolve => {
			const timeout = setTimeout(() => {
				for (const connection of this.#wss.clients) connection.terminate();
			}, 1_000);
			this.#wss.close(() => {
				clearTimeout(timeout);
				resolve();
			});
			for (const connection of this.#wss.clients) connection.close(1001, 'Server shutting down');
		});
		this.#detachPromise = Promise.all([close, Promise.allSettled(this.#pendingInitializations)]).then(() => undefined);
		return this.#detachPromise;
	}
}
