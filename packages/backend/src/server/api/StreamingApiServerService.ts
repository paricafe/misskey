/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import * as WebSocket from 'ws';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { DI } from '@/di-symbols.js';
import type { MiAccessToken } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser } from '@/models/User.js';
import { UserService } from '@/core/UserService.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { AuthenticateService, AuthenticationError } from './AuthenticateService.js';
import MainStreamConnection, { ConnectionRequest } from './stream/Connection.js';
import { ChannelEventBus } from './stream/ChannelEventBus.js';
import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import type { EventEmitter } from 'node:events';

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
	#authorizations = new Map<WebSocket.WebSocket, () => Promise<void>>();
	#authorizationChecks = new Map<string, Promise<[MiLocalUser | null, MiAccessToken | null]>>();
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
				[user, app] = await this.authenticateService.authenticate(token);

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
			if (user) ev.on(`authorization:${user.id}`, (event: GlobalEvents['internal']['payload']) => {
				if ((event.type === 'accessTokenRevoked' && event.body.id === app?.id)
					|| (event.type === 'userTokenRegenerated' && event.body.oldToken === token)
					|| (event.type === 'userChangeSuspendedState' && event.body.id === user.id && event.body.isSuspended)
					|| (event.type === 'userChangeDeletedState' && event.body.id === user.id && event.body.isDeleted)) invalidate();
			});
			const authorize = async (reusePending = true) => {
				if (!user || !token || invalidated || this.#detaching) return;
				try {
					const [currentUser, currentApp] = await this.authenticateFresh(token, reusePending);
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
				await authorize(false);
				if (invalidated || this.#detaching || socket.destroyed) return;
				this.#wss.handleUpgrade(request, socket, head, (ws) => {
					connection = ws;
					adopted = true;
					if (user) this.#authorizations.set(ws, authorize);
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
				this.#authorizations.delete(connection);
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
		this.#authorizationIntervalId = setInterval(() => {
			for (const authorize of this.#authorizations.values()) void authorize();
		}, 10_000);
	}

	private authenticateFresh(token: string, reusePending: boolean): Promise<[MiLocalUser | null, MiAccessToken | null]> {
		const pending = reusePending ? this.#authorizationChecks.get(token) : undefined;
		if (pending) return pending;
		let timeout: NodeJS.Timeout;
		const check = Promise.race([
			this.authenticateService.authenticate(token, { fresh: true, updateLastUsedAt: false }),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new AuthenticationError('Authorization check timed out')), 10_000);
				timeout.unref();
			}),
		]).finally(() => {
			clearTimeout(timeout);
			if (this.#authorizationChecks.get(token) === check) this.#authorizationChecks.delete(token);
		});
		if (reusePending) this.#authorizationChecks.set(token, check);
		return check;
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
