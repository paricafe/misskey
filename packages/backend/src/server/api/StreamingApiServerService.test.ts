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
	async function setup(init: () => Promise<void> = async () => {}) {
		const redis = new EventEmitter();
		const stream = { init: vi.fn(init), listen: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() };
		const service = new StreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(stream) } as never,
			{ authenticate: vi.fn().mockResolvedValue([null, null]) } as never,
			{ updateLastActiveDate: vi.fn() } as never,
		);
		const server = createServer();
		service.attach(server);
		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing test server port');
		const client = new WebSocket(`ws://127.0.0.1:${address.port}/streaming`);
		client.on('error', () => {});
		return { redis, stream, service, server, client };
	}

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
});
