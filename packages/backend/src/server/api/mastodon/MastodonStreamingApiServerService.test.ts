/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter, once } from 'node:events';
import * as http from 'node:http';
import * as WebSocket from 'ws';
import { describe, expect, test, vi } from 'vitest';
import { isMastodonStreamingPath, mastodonStreamEvent } from './MastodonStreamingApiServerService.js';
import { MastodonStreamingApiServerService } from './MastodonStreamingApiServerService.js';

describe('Mastodon streaming compatibility', () => {
	test('accepts only Mastodon streaming paths', () => {
		expect(isMastodonStreamingPath('/api/v1/streaming')).toBe(true);
		expect(isMastodonStreamingPath('/api/v1/streaming/user')).toBe(true);
		expect(isMastodonStreamingPath('/streaming')).toBe(false);
		expect(isMastodonStreamingPath('/api/v1/streaming-evil')).toBe(false);
	});

	test('encodes Mastodon events with a JSON payload and stream name', () => {
		expect(JSON.parse(mastodonStreamEvent('update', { id: 'note-id' }, 'user'))).toEqual({
			event: 'update',
			payload: '{"id":"note-id"}',
			stream: ['user'],
		});
	});

	test('bridges native channels, emits deletes, and closes revoked tokens', async () => {
		const redis = new EventEmitter();
		let nativeSocket: { send: (data: string) => void } | undefined;
		let nativeReadyResolve: (() => void) | undefined;
		const nativeReady = new Promise<void>(resolve => { nativeReadyResolve = resolve; });
		const nativeStream = {
			init: vi.fn(),
			listen: vi.fn((_subscriber, socket) => {
				nativeSocket = socket;
				nativeReadyResolve?.();
			}),
			connectChannel: vi.fn(),
			dispose: vi.fn(),
		};
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(nativeStream) } as never,
			{ authenticate: vi.fn().mockResolvedValue({ user: { id: 'user-id' }, token: { id: 'token-id', scopes: ['read'] } }) } as never,
			{ assert: vi.fn(), allows: vi.fn().mockReturnValue(true), toMisskeyPermissions: vi.fn().mockReturnValue(['read:account']) } as never,
			{ status: vi.fn(note => ({ id: note.id })), notification: vi.fn(value => value) } as never,
		);
		const server = http.createServer();
		service.attach(server);
		await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing test server address');
		const client = new WebSocket.WebSocket(`ws://127.0.0.1:${address.port}/api/v1/streaming?access_token=token&stream=public&stream=user:notification`);

		try {
			await once(client, 'open');
			await nativeReady;
			await new Promise(resolve => setImmediate(resolve));
			expect(nativeStream.connectChannel).toHaveBeenCalledWith('mastodon-0', {}, 'main');
			expect(nativeStream.connectChannel).toHaveBeenCalledWith('mastodon-1', {}, 'globalTimeline');

			const updateMessage = once(client, 'message');
			nativeSocket!.send(JSON.stringify({
				type: 'channel',
				body: { id: 'mastodon-1', type: 'note', body: { id: 'note-id', user: { host: null }, files: [], visibility: 'public' } },
			}));
			const [updateData] = await updateMessage;
			expect(JSON.parse(updateData.toString())).toMatchObject({ event: 'update', payload: '{"id":"note-id"}', stream: ['public'] });

			const deleteMessage = once(client, 'message');
			redis.emit('message', 'misskey', JSON.stringify({ channel: 'noteStream:note-id', message: { type: 'deleted' } }));
			const [deleteData] = await deleteMessage;
			expect(JSON.parse(deleteData.toString())).toMatchObject({ event: 'delete', payload: '"note-id"', stream: ['public'] });

			const notificationMessage = once(client, 'message');
			nativeSocket!.send(JSON.stringify({ type: 'channel', body: { id: 'mastodon-0', type: 'mention', body: { id: 'private-note' } } }));
			nativeSocket!.send(JSON.stringify({ type: 'channel', body: { id: 'mastodon-0', type: 'notification', body: { id: 'notification-id' } } }));
			const [notificationData] = await notificationMessage;
			expect(JSON.parse(notificationData.toString())).toMatchObject({ event: 'notification', stream: ['user:notification'] });

			const closed = once(client, 'close');
			redis.emit('message', 'misskey', JSON.stringify({ channel: 'mastodonTokenRevoked:token-id', message: null }));
			await closed;
			await vi.waitFor(() => expect(nativeStream.dispose).toHaveBeenCalled());
		} finally {
			client.terminate();
			await service.detach();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
