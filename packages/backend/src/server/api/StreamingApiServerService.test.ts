/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { describe, expect, test, vi } from 'vitest';
import { isNativeStreamingPath, StreamingApiServerService } from './StreamingApiServerService.js';
import type { Socket } from 'node:net';

describe('native streaming path isolation', () => {
	test('does not claim Mastodon WebSocket upgrades', () => {
		expect(isNativeStreamingPath('/streaming')).toBe(true);
		expect(isNativeStreamingPath('/streaming?i=token')).toBe(true);
		expect(isNativeStreamingPath('/api/v1/streaming')).toBe(false);
		expect(isNativeStreamingPath('http://[')).toBe(false);
	});
});

describe('native streaming shutdown', () => {
	async function setup(init: () => Promise<void> = async () => {}, authenticate = vi.fn().mockResolvedValue([null, null]), token?: string) {
		const redis = new EventEmitter();
		const stream = { init: vi.fn(init), listen: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() };
		const service = new StreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(stream) } as never,
			{ authenticate } as never,
			{ updateLastActiveDate: vi.fn() } as never,
		);
		const server = createServer();
		service.attach(server);
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing test server port');
		const client = new WebSocket(`ws://127.0.0.1:${address.port}/streaming${token ? `?i=${token}` : ''}`);
		client.on('error', () => {});
		return { redis, stream, service, server, client, authenticate };
	}

	test('closes only the revoked token and blocks events already in flight', async () => {
		const authenticate = vi.fn(async (token: string) => [{ id: 'alice' }, { id: token, permission: ['read:account'] }]);
		const { redis, stream, service, server, client } = await setup(undefined, authenticate, 'revoked');
		let second: WebSocket | undefined;
		try {
			await once(client, 'open');
			second = new WebSocket(client.url.replace('revoked', 'retained'));
			await once(second, 'open');
			const closed = once(client, 'close');
			redis.emit('message', 'test', JSON.stringify({ channel: 'internal', message: { type: 'accessTokenRevoked', body: { id: 'revoked', userId: 'alice' } } }));
			await closed;
			expect(second.readyState).toBe(WebSocket.OPEN);
			const revokedSocket = stream.listen.mock.calls[0][1] as WebSocket;
			expect(revokedSocket.readyState).not.toBe(WebSocket.OPEN);
		} finally {
			await service.detach();
			client.terminate();
			second?.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('rejects revocation while stream initialization is pending', async () => {
		let finishInitialization!: () => void;
		const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
		const authenticate = vi.fn().mockResolvedValue([{ id: 'alice' }, { id: 'token', permission: ['read:account'] }]);
		const { redis, stream, service, server, client } = await setup(() => initialization, authenticate, 'token');
		try {
			await vi.waitFor(() => expect(stream.init).toHaveBeenCalledOnce());
			const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
			redis.emit('message', 'test', JSON.stringify({ channel: 'internal', message: { type: 'accessTokenRevoked', body: { id: 'token', userId: 'alice' } } }));
			finishInitialization();
			await closed;
			await vi.waitFor(() => expect(stream.dispose).toHaveBeenCalledOnce());
			expect(stream.listen).not.toHaveBeenCalled();
		} finally {
			finishInitialization();
			await service.detach();
			client.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test.each([
		{ type: 'userTokenRegenerated', body: { id: 'alice', oldToken: 'credential', newToken: 'replacement' } },
		{ type: 'userChangeSuspendedState', body: { id: 'alice', isSuspended: true } },
		{ type: 'userChangeDeletedState', body: { id: 'alice', isDeleted: true } },
	])('closes active sessions on $type', async event => {
		const authenticate = vi.fn().mockResolvedValue([{ id: 'alice' }, null]);
		const { redis, service, server, client } = await setup(undefined, authenticate, 'credential');
		try {
			await once(client, 'open');
			const closed = once(client, 'close');
			redis.emit('message', 'test', JSON.stringify({ channel: 'internal', message: event }));
			await closed;
		} finally {
			await service.detach();
			client.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('checks fresh authorization again before completing the handshake', async () => {
		const authenticate = vi.fn().mockResolvedValueOnce([{ id: 'alice' }, { id: 'token', permission: ['read:account'] }])
			.mockRejectedValueOnce(new Error('token removed'));
		const { stream, service, server, client } = await setup(undefined, authenticate, 'token');
		try {
			await new Promise<void>(resolve => client.once('close', () => resolve()));
			expect(authenticate).toHaveBeenLastCalledWith('token', { fresh: true, updateLastUsedAt: false });
			expect(stream.listen).not.toHaveBeenCalled();
		} finally {
			await service.detach();
			client.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('does not reuse an authorization query started before a new handshake subscribed to revocations', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const valid = [{ id: 'alice' }, { id: 'token', permission: ['read:account'] }];
		const authenticate = vi.fn().mockResolvedValue(valid);
		const { service, server, client } = await setup(undefined, authenticate, 'token');
		let second: WebSocket | undefined;
		let finishOldCheck!: (value: unknown) => void;
		try {
			await once(client, 'open');
			authenticate.mockImplementationOnce(() => new Promise(resolve => { finishOldCheck = resolve; }));
			await vi.advanceTimersByTimeAsync(10_000);
			authenticate.mockResolvedValueOnce(valid).mockRejectedValueOnce(new Error('token removed'));
			second = new WebSocket(client.url);
			second.on('error', () => {});
			await new Promise<void>((resolve, reject) => {
				second!.once('open', () => reject(new Error('A revoked token completed a new handshake')));
				second!.once('close', () => resolve());
			});
			expect(authenticate).toHaveBeenCalledTimes(5);
		} finally {
			finishOldCheck?.(valid);
			await service.detach();
			vi.useRealTimers();
			client.terminate();
			second?.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('fails closed on periodic authorization failure without querying for each event', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const authenticate = vi.fn().mockResolvedValue([{ id: 'alice' }, { id: 'token', permission: ['read:account'] }]);
		const { redis, service, server, client } = await setup(undefined, authenticate, 'token');
		try {
			await once(client, 'open');
			const calls = authenticate.mock.calls.length;
			for (let i = 0; i < 100; i++) redis.emit('message', 'test', JSON.stringify({ channel: 'broadcast', message: { type: 'public' } }));
			expect(authenticate).toHaveBeenCalledTimes(calls);
			authenticate.mockRejectedValue(new Error('database unavailable'));
			const closed = once(client, 'close');
			await vi.advanceTimersByTimeAsync(10_000);
			await closed;
		} finally {
			await service.detach();
			vi.useRealTimers();
			client.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('closes connected clients and removes listeners before resolving detach', async () => {
		const { redis, stream, service, server, client } = await setup();
		try {
			await once(client, 'open');
			const closed = once(client, 'close');
			const detached = service.detach();
			expect(service.detach()).toBe(detached);
			await detached;
			expect((await closed)[0]).toBe(1001);
			expect(stream.dispose).toHaveBeenCalledOnce();
			expect(server.listenerCount('upgrade')).toBe(0);
			expect(redis.listenerCount('message')).toBe(0);
		} finally {
			client.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('terminates a client that does not acknowledge the close frame', async () => {
		const { service, server, client } = await setup();
		try {
			await once(client, 'open');
			(client as unknown as { _socket: Socket })._socket.pause();
			await service.detach();
		} finally {
			client.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('cleans up a stream whose authentication/init was still pending at shutdown', async () => {
		let finishInitialization!: () => void;
		const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
		const { stream, service, server, client } = await setup(() => initialization);
		try {
			await vi.waitFor(() => expect(stream.init).toHaveBeenCalledOnce());
			const detached = service.detach();
			finishInitialization();
			await detached;
			expect(stream.listen).not.toHaveBeenCalled();
			expect(stream.dispose).toHaveBeenCalledOnce();
		} finally {
			client.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('routes targeted messages and broadcasts to the correct WebSocket subscribers', async () => {
		const { redis, stream, service, server, client } = await setup();
		let next = 0;
		stream.listen.mockImplementation(async (subscriber: EventEmitter, socket: WebSocket) => {
			const channel = `mainStream:${next++}`;
			const send = (message: unknown) => socket.send(JSON.stringify(message));
			subscriber.on(channel, send);
			subscriber.on('broadcast', send);
		});
		let second: WebSocket | undefined;
		try {
			await once(client, 'open');
			second = new WebSocket(client.url);
			await once(second, 'open');
			const firstMessages: unknown[] = [];
			const secondMessages: unknown[] = [];
			client.on('message', data => firstMessages.push(JSON.parse(data.toString())));
			second.on('message', data => secondMessages.push(JSON.parse(data.toString())));
			redis.emit('message', 'test', JSON.stringify({ channel: 'mainStream:0', message: { type: 'private' } }));
			redis.emit('message', 'test', JSON.stringify({ channel: 'broadcast', message: { type: 'public' } }));
			await vi.waitFor(() => {
				expect(firstMessages).toEqual([{ type: 'private' }, { type: 'public' }]);
				expect(secondMessages).toEqual([{ type: 'public' }]);
			});
		} finally {
			await service.detach();
			client.terminate();
			second?.terminate();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
