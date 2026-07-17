/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter, once } from 'node:events';
import * as http from 'node:http';
import * as WebSocket from 'ws';
import { describe, expect, test, vi } from 'vitest';
import { MASTODON_4_6_USER_ROUTES } from './MastodonApiContract.js';
import {
	isMastodonStreamingPath,
	mastodonSseEvent,
	mastodonStreamEvent,
	parseMastodonStreamSubscriptions,
} from './MastodonStreamingApiServerService.js';
import { MastodonStreamingApiServerService } from './MastodonStreamingApiServerService.js';

describe('Mastodon streaming compatibility', () => {
	test('recognizes every documented Mastodon streaming contract path', () => {
		const routes = MASTODON_4_6_USER_ROUTES.filter(route => route.transport === 'websocket');
		expect(routes).toHaveLength(2);
		for (const route of routes) expect(isMastodonStreamingPath(route.samplePath)).toBe(true);
	});

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

	test('encodes raw deletes, payload-less filter invalidations, and exact SSE frames', () => {
		expect(JSON.parse(mastodonStreamEvent('delete', 'note-id', 'user', { rawPayload: true }))).toEqual({
			event: 'delete',
			payload: 'note-id',
			stream: ['user'],
		});
		expect(JSON.parse(mastodonStreamEvent('announcement.delete', 'announcement-id', 'user', { rawPayload: true }))).toEqual({
			event: 'announcement.delete',
			payload: 'announcement-id',
			stream: ['user'],
		});
		expect(JSON.parse(mastodonStreamEvent('filters_changed', undefined, 'user', { omitPayload: true }))).toEqual({
			event: 'filters_changed',
			stream: ['user'],
		});
		expect(mastodonSseEvent({ event: 'update', payload: { id: 'note-id' }, stream: 'public' })).toBe(
			'event: update\ndata: {"id":"note-id"}\n\n',
		);
		expect(mastodonSseEvent({ event: 'filters_changed', stream: 'user' })).toBe('event: filters_changed\ndata: undefined\n\n');
		expect(mastodonSseEvent({ event: 'delete', payload: 'note-id', rawPayload: true, stream: 'user' })).toBe('event: delete\ndata: note-id\n\n');
	});

	test('parses empty multiplex roots and normalizes all path/query stream variants', () => {
		expect(parseMastodonStreamSubscriptions(new URL('https://misskey.example/api/v1/streaming'))).toEqual([]);
		expect(parseMastodonStreamSubscriptions(new URL('https://misskey.example/api/v1/streaming/public?only_media=true'))).toEqual([
			{ stream: 'public:media' },
		]);
		expect(parseMastodonStreamSubscriptions(new URL('https://misskey.example/api/v1/streaming/public/local?only_media=true'))).toEqual([
			{ stream: 'public:local:media' },
		]);
		expect(parseMastodonStreamSubscriptions(new URL('https://misskey.example/api/v1/streaming/public/remote?only_media=true'))).toEqual([
			{ stream: 'public:remote:media' },
		]);
		expect(parseMastodonStreamSubscriptions(new URL('https://misskey.example/api/v1/streaming?stream=hashtag&tag=alpha&tag=beta'))).toEqual([
			{ stream: 'hashtag', tags: ['alpha', 'beta'] },
		]);
		expect(parseMastodonStreamSubscriptions(new URL('https://misskey.example/api/v1/streaming/list?list=list-id'))).toEqual([
			{ stream: 'list', listId: 'list-id' },
		]);
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
			disconnectChannel: vi.fn(),
			dispose: vi.fn(),
		};
		const isActiveUserToken = vi.fn().mockResolvedValue(true);
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(nativeStream) } as never,
			{ authenticate: vi.fn().mockResolvedValue({ kind: 'user', user: { id: 'user-id' }, token: { id: 'token-id', scopes: ['read'] } }), isActiveUserToken } as never,
			{ assert: vi.fn(), allows: vi.fn().mockReturnValue(true), toMisskeyPermissions: vi.fn().mockReturnValue(['read:account']) } as never,
			{ status: vi.fn(note => ({ id: note.id })), notification: vi.fn(value => value) } as never,
			{ apply: vi.fn(async (_userId, _context, statuses) => statuses) } as never,
			{ list: vi.fn(async (_userId, sources) => sources) } as never,
			{ listFollowedTags: vi.fn(async () => []) } as never,
			{ upsertLive: vi.fn() } as never,
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
			expect(isActiveUserToken).toHaveBeenCalledWith('token-id', 'user-id');
			expect(nativeStream.connectChannel).toHaveBeenCalledWith('mastodon-0', {}, 'globalTimeline');
			expect(nativeStream.connectChannel).toHaveBeenCalledWith('mastodon-1', {}, 'main');

			const updateMessage = once(client, 'message');
			nativeSocket!.send(JSON.stringify({
				type: 'channel',
				body: { id: 'mastodon-0', type: 'note', body: { id: 'note-id', user: { host: null }, files: [], visibility: 'public' } },
			}));
			const [updateData] = await updateMessage;
			expect(JSON.parse(updateData.toString())).toMatchObject({ event: 'update', payload: '{"id":"note-id"}', stream: ['public'] });

			const deleteMessage = once(client, 'message');
			redis.emit('message', 'misskey', JSON.stringify({ channel: 'noteStream:note-id', message: { type: 'deleted' } }));
			const [deleteData] = await deleteMessage;
			expect(JSON.parse(deleteData.toString())).toMatchObject({ event: 'delete', payload: 'note-id', stream: ['public'] });

			const notificationMessage = once(client, 'message');
			nativeSocket!.send(JSON.stringify({ type: 'channel', body: { id: 'mastodon-1', type: 'mention', body: { id: 'private-note' } } }));
			nativeSocket!.send(JSON.stringify({ type: 'channel', body: { id: 'mastodon-1', type: 'notification', body: { id: 'notification-id' } } }));
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

	test('does not start native channels when post-registration token revalidation fails', async () => {
		const redis = new EventEmitter();
		let resolveActiveToken: ((active: boolean) => void) | undefined;
		const activeToken = new Promise<boolean>(resolve => { resolveActiveToken = resolve; });
		const authenticate = vi.fn().mockResolvedValue({
			kind: 'user',
			user: { id: 'user-id' },
			token: { id: 'token-id', scopes: ['read'] },
		});
		const isActiveUserToken = vi.fn().mockReturnValue(activeToken);
		const nativeStream = {
			init: vi.fn(),
			listen: vi.fn(),
			connectChannel: vi.fn(),
			disconnectChannel: vi.fn(),
			dispose: vi.fn(),
		};
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(nativeStream) } as never,
			{ authenticate, isActiveUserToken } as never,
			{ assert: vi.fn(), assertAny: vi.fn(), allows: vi.fn(), toMisskeyPermissions: vi.fn().mockReturnValue(['read:account']) } as never,
			{ status: vi.fn(), notification: vi.fn() } as never,
			{ apply: vi.fn(async (_userId, _context, statuses) => statuses) } as never,
			{ list: vi.fn(async (_userId, sources) => sources) } as never,
			{ listFollowedTags: vi.fn(async () => []) } as never,
			{ upsertLive: vi.fn() } as never,
		);
		const server = http.createServer();
		service.attach(server);
		await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing test server address');
		const client = new WebSocket.WebSocket(`ws://127.0.0.1:${address.port}/api/v1/streaming?access_token=token&stream=user`);
		const closed = once(client, 'close');

		try {
			await once(client, 'open');
			await vi.waitFor(() => expect(isActiveUserToken).toHaveBeenCalledWith('token-id', 'user-id'));
			expect(authenticate).toHaveBeenCalledWith('token');
			expect(nativeStream.listen).not.toHaveBeenCalled();
			expect(nativeStream.connectChannel).not.toHaveBeenCalled();

			resolveActiveToken?.(false);
			await closed;

			expect(nativeStream.listen).not.toHaveBeenCalled();
			expect(nativeStream.connectChannel).not.toHaveBeenCalled();
			await vi.waitFor(() => expect(nativeStream.dispose).toHaveBeenCalledOnce());
		} finally {
			client.terminate();
			await service.detach();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('rejects application tokens before creating native streaming state', async () => {
		const redis = new EventEmitter();
		const registerRequestByContextId = vi.fn();
		const create = vi.fn();
		const assert = vi.fn();
		const authenticate = vi.fn().mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
		});
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId, create } as never,
			{ authenticate } as never,
			{ assert, allows: vi.fn(), toMisskeyPermissions: vi.fn() } as never,
			{ status: vi.fn(), notification: vi.fn() } as never,
			{ apply: vi.fn(async (_userId, _context, statuses) => statuses) } as never,
			{ list: vi.fn(async (_userId, sources) => sources) } as never,
			{ listFollowedTags: vi.fn(async () => []) } as never,
			{ upsertLive: vi.fn() } as never,
		);
		const server = http.createServer();
		service.attach(server);
		await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing test server address');
		const client = new WebSocket.WebSocket(`ws://127.0.0.1:${address.port}/api/v1/streaming?stream=public`, {
			headers: { authorization: 'Bearer app-token' },
		});
		client.on('error', () => {});

		try {
			const [, response] = await once(client, 'unexpected-response') as [http.ClientRequest, http.IncomingMessage];
			expect(response.statusCode).toBe(401);
			response.resume();
			expect(authenticate).toHaveBeenCalledWith('app-token');
			expect(assert).not.toHaveBeenCalled();
			expect(registerRequestByContextId).not.toHaveBeenCalled();
			expect(create).not.toHaveBeenCalled();
		} finally {
			client.terminate();
			await service.detach();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('uses auth-header, query, then whole subprotocol precedence and keeps invalid multiplex clients connected', async () => {
		const redis = new EventEmitter();
		const authenticate = vi.fn().mockResolvedValue({
			kind: 'user',
			user: { id: 'user-id' },
			token: { id: 'token-id', scopes: ['read'] },
		});
		const nativeStreams: Array<{
			listen: ReturnType<typeof vi.fn>;
			connectChannel: ReturnType<typeof vi.fn>;
			disconnectChannel: ReturnType<typeof vi.fn>;
			dispose: ReturnType<typeof vi.fn>;
		}> = [];
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{
				registerRequestByContextId: vi.fn(),
				create: vi.fn(async () => {
					const native = {
						init: vi.fn(),
						listen: vi.fn(),
						connectChannel: vi.fn(),
						disconnectChannel: vi.fn(),
						dispose: vi.fn(),
					};
					nativeStreams.push(native);
					return native;
				}),
			} as never,
			{ authenticate, isActiveUserToken: vi.fn().mockResolvedValue(true) } as never,
			{ assert: vi.fn(), assertAny: vi.fn(), allows: vi.fn().mockReturnValue(true), toMisskeyPermissions: vi.fn().mockReturnValue([]) } as never,
			{ status: vi.fn(note => ({ id: note.id })), notification: vi.fn(value => value) } as never,
			{ apply: vi.fn(async (_userId, _context, statuses) => statuses) } as never,
			{ list: vi.fn(async (_userId, sources) => sources) } as never,
			{ listFollowedTags: vi.fn(async () => []) } as never,
			{ upsertLive: vi.fn() } as never,
		);
		const server = http.createServer();
		service.attach(server);
		await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing test server address');
		const base = `ws://127.0.0.1:${address.port}/api/v1/streaming`;
		const headerClient = new WebSocket.WebSocket(`${base}?access_token=query-token`, 'protocol-token', {
			headers: { authorization: 'bEaReR\t header-token' },
		});
		let queryClient: WebSocket.WebSocket | undefined;
		let protocolClient: WebSocket.WebSocket | undefined;
		try {
			await once(headerClient, 'open');
			queryClient = new WebSocket.WebSocket(`${base}?access_token=query-token`, 'protocol-token');
			await once(queryClient, 'open');
			protocolClient = new WebSocket.WebSocket(base, 'protocol-token');
			await once(protocolClient, 'open');
			expect(authenticate.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['header-token', 'query-token', 'protocol-token']));
			await vi.waitFor(() => expect(nativeStreams).toHaveLength(3));
			expect(nativeStreams.every(native => native.connectChannel.mock.calls.length === 0)).toBe(true);

			const invalid = once(protocolClient, 'message');
			protocolClient.send(JSON.stringify({ type: 'wat', stream: 'public' }));
			const [invalidData] = await invalid;
			expect(JSON.parse(invalidData.toString())).toMatchObject({ status: 400, error: expect.any(String) });
			expect(protocolClient.readyState).toBe(WebSocket.WebSocket.OPEN);

			protocolClient.send(JSON.stringify({ type: 'subscribe', stream: 'public' }));
			await vi.waitFor(() => expect(nativeStreams[2]!.connectChannel).toHaveBeenCalledWith('mastodon-0', {}, 'globalTimeline'));
			protocolClient.send(JSON.stringify({ type: 'unsubscribe', stream: 'public' }));
			await vi.waitFor(() => expect(nativeStreams[2]!.disconnectChannel).toHaveBeenCalledWith('mastodon-0'));

			for (let index = 0; index < 32; index++) {
				protocolClient.send(JSON.stringify({ type: 'subscribe', stream: 'list', list: `list-${index}` }));
			}
			await vi.waitFor(() => expect(nativeStreams[2]!.connectChannel).toHaveBeenCalledTimes(33));
			const overflow = once(protocolClient, 'message');
			protocolClient.send(JSON.stringify({ type: 'subscribe', stream: 'list', list: 'overflow' }));
			const [overflowData] = await overflow;
			expect(JSON.parse(overflowData.toString())).toMatchObject({ status: 400, error: expect.stringContaining('Too many streaming') });
			expect(nativeStreams[2]!.connectChannel).toHaveBeenCalledTimes(33);

			const oversizedClose = once(protocolClient, 'close');
			protocolClient.send(Buffer.alloc(64 * 1024 + 1));
			const [code] = await oversizedClose;
			expect(code).toBe(1009);
		} finally {
			headerClient.terminate();
			queryClient?.terminate();
			protocolClient?.terminate();
			await service.detach();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('serializes an immediate multiplex subscribe behind session startup', async () => {
		const redis = new EventEmitter();
		let activate!: (active: boolean) => void;
		const active = new Promise<boolean>(resolve => { activate = resolve; });
		const nativeStream = {
			init: vi.fn(),
			listen: vi.fn(),
			connectChannel: vi.fn(),
			disconnectChannel: vi.fn(),
			dispose: vi.fn(),
		};
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(nativeStream) } as never,
			{
				authenticate: vi.fn().mockResolvedValue({
					kind: 'user',
					user: { id: 'user-id' },
					token: { id: 'token-id', scopes: ['read:statuses'] },
				}),
				isActiveUserToken: vi.fn(() => active),
			} as never,
			{ assert: vi.fn(), assertAny: vi.fn(), allows: vi.fn().mockReturnValue(true), toMisskeyPermissions: vi.fn().mockReturnValue([]) } as never,
			{ status: vi.fn(), notification: vi.fn() } as never,
			{ apply: vi.fn() } as never,
			{ list: vi.fn() } as never,
			{ listFollowedTags: vi.fn().mockResolvedValue([]) } as never,
			{ upsertLive: vi.fn() } as never,
		);
		const server = http.createServer();
		service.attach(server);
		await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
		const address = server.address();
		if (address == null || typeof address === 'string') throw new Error('Missing test server address');
		const client = new WebSocket.WebSocket(`ws://127.0.0.1:${address.port}/api/v1/streaming?access_token=user-token`);
		try {
			client.once('open', () => client.send(JSON.stringify({ type: 'subscribe', stream: 'public' })));
			await once(client, 'open');
			await new Promise(resolve => setTimeout(resolve, 0));
			expect(nativeStream.connectChannel).not.toHaveBeenCalled();

			activate(true);
			await vi.waitFor(() => expect(nativeStream.connectChannel).toHaveBeenCalledWith('mastodon-0', {}, 'globalTimeline'));
		} finally {
			client.terminate();
			await service.detach();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('streams authenticated SSE frames and heartbeats, then closes and disposes on backpressure', async () => {
		vi.useFakeTimers();
		const redis = new EventEmitter();
		let nativeSocket: { send: (data: string) => void } | undefined;
		const nativeStream = {
			init: vi.fn(),
			listen: vi.fn(async (_subscriber, socket) => { nativeSocket = socket; }),
			connectChannel: vi.fn(),
			disconnectChannel: vi.fn(),
			dispose: vi.fn(),
		};
		const authenticate = vi.fn().mockResolvedValue({
			kind: 'user',
			user: { id: 'user-id' },
			token: { id: 'token-id', scopes: ['read:statuses'] },
		});
		const assert = vi.fn();
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(nativeStream) } as never,
			{ authenticate, isActiveUserToken: vi.fn().mockResolvedValue(true) } as never,
			{ assert, assertAny: vi.fn(), allows: vi.fn().mockReturnValue(true), toMisskeyPermissions: vi.fn().mockReturnValue([]) } as never,
			{ status: vi.fn(value => ({ id: value.id })), notification: vi.fn(value => value) } as never,
			{ apply: vi.fn(async (_userId, _context, statuses) => statuses) } as never,
			{ list: vi.fn(async (_userId, sources) => sources) } as never,
			{ listFollowedTags: vi.fn(async () => []) } as never,
			{ upsertLive: vi.fn() } as never,
		);
		const requestRaw = Object.assign(new EventEmitter(), { url: '/api/v1/streaming/public?access_token=sse-token' });
		const writes: string[] = [];
		const responseRaw = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
			writableLength: 0,
			writeHead: vi.fn(),
			write: vi.fn((data: string) => { writes.push(data); return true; }),
			end: vi.fn(function(this: { writableEnded: boolean }) { this.writableEnded = true; }),
		});
		const reply = { raw: responseRaw, hijack: vi.fn() };
		const handling = service.handleSse({ raw: requestRaw, url: requestRaw.url, headers: {} } as never, reply as never);

		try {
			await vi.waitFor(() => expect(responseRaw.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
				'Content-Type': 'text/event-stream; charset=utf-8',
				'Cache-Control': 'private, no-store',
			})));
			expect(authenticate).toHaveBeenCalledWith('sse-token');
			expect(assert).toHaveBeenCalledWith(['read:statuses'], 'read:statuses');
			expect(nativeStream.connectChannel).toHaveBeenCalledWith('mastodon-0', {}, 'globalTimeline');
			nativeSocket!.send(JSON.stringify({
				type: 'channel',
				body: { id: 'mastodon-0', type: 'note', body: { id: 'note-id', text: null, cw: null, user: { host: null }, files: [], poll: null, renote: null, visibility: 'public' } },
			}));
			await vi.waitFor(() => expect(writes).toContain('event: update\ndata: {"id":"note-id"}\n\n'));
			expect(responseRaw.writeHead.mock.invocationCallOrder[0]).toBeLessThan(responseRaw.write.mock.invocationCallOrder[0]!);

			await vi.advanceTimersByTimeAsync(15_000);
			expect(writes).toContain(': heartbeat\n\n');

			responseRaw.writableLength = 1024 * 1024;
			nativeSocket!.send(JSON.stringify({
				type: 'channel',
				body: { id: 'mastodon-0', type: 'note', body: { id: 'overflow', text: null, cw: null, user: { host: null }, files: [], poll: null, renote: null, visibility: 'public' } },
			}));
			await vi.waitFor(() => expect(responseRaw.end).toHaveBeenCalled());
			await handling;
			expect(nativeStream.dispose).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	test('registers SSE invalidation before revalidation and never starts after an intervening revocation', async () => {
		const redis = new EventEmitter();
		let resolveActive!: (active: boolean) => void;
		const active = new Promise<boolean>(resolve => { resolveActive = resolve; });
		const nativeStream = {
			init: vi.fn(),
			listen: vi.fn(),
			connectChannel: vi.fn(),
			disconnectChannel: vi.fn(),
			dispose: vi.fn(),
		};
		const create = vi.fn().mockResolvedValue(nativeStream);
		const isActiveUserToken = vi.fn(() => active);
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create } as never,
			{
				authenticate: vi.fn().mockResolvedValue({
					kind: 'user',
					user: { id: 'user-id' },
					token: { id: 'token-id', scopes: ['read:statuses'] },
				}),
				isActiveUserToken,
			} as never,
			{ assert: vi.fn(), assertAny: vi.fn(), allows: vi.fn().mockReturnValue(true), toMisskeyPermissions: vi.fn().mockReturnValue([]) } as never,
			{ status: vi.fn(), notification: vi.fn() } as never,
			{ apply: vi.fn() } as never,
			{ list: vi.fn() } as never,
			{ listFollowedTags: vi.fn().mockResolvedValue([]) } as never,
			{ upsertLive: vi.fn(), refreshLive: vi.fn() } as never,
		);
		const server = http.createServer();
		service.attach(server);
		await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
		const requestRaw = Object.assign(new EventEmitter(), { url: '/api/v1/streaming/public?access_token=token' });
		const responseRaw = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
			writableLength: 0,
			writeHead: vi.fn(),
			write: vi.fn().mockReturnValue(true),
			end: vi.fn(function(this: { writableEnded: boolean }) { this.writableEnded = true; }),
		});
		const handling = service.handleSse(
			{ raw: requestRaw, url: requestRaw.url, headers: {} } as never,
			{ raw: responseRaw, hijack: vi.fn() } as never,
		);
		try {
			await vi.waitFor(() => expect(isActiveUserToken).toHaveBeenCalledWith('token-id', 'user-id'));
			expect(create).toHaveBeenCalledOnce();
			redis.emit('message', 'misskey', JSON.stringify({ channel: 'mastodonTokenRevoked:token-id', message: null }));
			await vi.waitFor(() => expect(responseRaw.end).toHaveBeenCalledOnce());

			resolveActive(true);
			await handling;
			expect(responseRaw.writeHead).not.toHaveBeenCalled();
			expect(responseRaw.write).not.toHaveBeenCalled();
			expect(nativeStream.listen).not.toHaveBeenCalled();
			expect(nativeStream.connectChannel).not.toHaveBeenCalled();
			expect(nativeStream.dispose).toHaveBeenCalledOnce();
		} finally {
			resolveActive(true);
			await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
			await new Promise(resolve => setImmediate(resolve));
			requestRaw.emit('aborted');
			await handling;
			await service.detach();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('cleans up a registered SSE session when revalidation fails', async () => {
		const redis = new EventEmitter();
		const nativeStream = {
			init: vi.fn(),
			listen: vi.fn(),
			connectChannel: vi.fn(),
			disconnectChannel: vi.fn(),
			dispose: vi.fn(),
		};
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(nativeStream) } as never,
			{
				authenticate: vi.fn().mockResolvedValue({
					kind: 'user',
					user: { id: 'user-id' },
					token: { id: 'token-id', scopes: ['read:statuses'] },
				}),
				isActiveUserToken: vi.fn().mockRejectedValue(new Error('database unavailable')),
			} as never,
			{ assert: vi.fn(), assertAny: vi.fn(), allows: vi.fn().mockReturnValue(true), toMisskeyPermissions: vi.fn().mockReturnValue([]) } as never,
			{ status: vi.fn(), notification: vi.fn() } as never,
			{ apply: vi.fn() } as never,
			{ list: vi.fn() } as never,
			{ listFollowedTags: vi.fn().mockResolvedValue([]) } as never,
			{ upsertLive: vi.fn(), refreshLive: vi.fn() } as never,
		);
		const requestRaw = Object.assign(new EventEmitter(), { url: '/api/v1/streaming/public?access_token=token' });
		const responseRaw = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
			writableLength: 0,
			writeHead: vi.fn(),
			write: vi.fn().mockReturnValue(true),
			end: vi.fn(),
		});

		await expect(service.handleSse(
			{ raw: requestRaw, url: requestRaw.url, headers: {} } as never,
			{ raw: responseRaw, hijack: vi.fn() } as never,
		)).rejects.toThrow('database unavailable');

		expect(nativeStream.dispose).toHaveBeenCalledOnce();
		expect(nativeStream.listen).not.toHaveBeenCalled();
		expect(responseRaw.writeHead).not.toHaveBeenCalled();
		expect(requestRaw.listenerCount('aborted')).toBe(0);
		expect(responseRaw.listenerCount('close')).toBe(0);
	});

	test('disposes an SSE session promptly when the request is aborted', async () => {
		const redis = new EventEmitter();
		let finishListening!: () => void;
		const listening = new Promise<void>(resolve => { finishListening = resolve; });
		const nativeStream = {
			init: vi.fn(),
			listen: vi.fn(() => listening),
			connectChannel: vi.fn(),
			disconnectChannel: vi.fn(),
			dispose: vi.fn(),
		};
		const service = new MastodonStreamingApiServerService(
			redis as never,
			{ registerRequestByContextId: vi.fn(), create: vi.fn().mockResolvedValue(nativeStream) } as never,
			{ authenticate: vi.fn().mockResolvedValue({ kind: 'user', user: { id: 'user-id' }, token: { id: 'token-id', scopes: ['read'] } }), isActiveUserToken: vi.fn().mockResolvedValue(true) } as never,
			{ assert: vi.fn(), assertAny: vi.fn(), allows: vi.fn().mockReturnValue(true), toMisskeyPermissions: vi.fn().mockReturnValue([]) } as never,
			{ status: vi.fn(), notification: vi.fn() } as never,
			{ apply: vi.fn(async (_userId, _context, statuses) => statuses) } as never,
			{ list: vi.fn(async (_userId, sources) => sources) } as never,
			{ listFollowedTags: vi.fn(async () => []) } as never,
			{ upsertLive: vi.fn() } as never,
		);
		const requestRaw = Object.assign(new EventEmitter(), { url: '/api/v1/streaming/user?access_token=token' });
		const responseRaw = Object.assign(new EventEmitter(), {
			destroyed: false,
			writableEnded: false,
			writableLength: 0,
			writeHead: vi.fn(),
			write: vi.fn().mockReturnValue(true),
			end: vi.fn(),
		});
		const handling = service.handleSse(
			{ raw: requestRaw, url: requestRaw.url, headers: {} } as never,
			{ raw: responseRaw, hijack: vi.fn() } as never,
		);
		await vi.waitFor(() => expect(responseRaw.writeHead).toHaveBeenCalled());
		requestRaw.emit('aborted');
		await vi.waitFor(() => expect(nativeStream.dispose).toHaveBeenCalledOnce());
		finishListening();
		await handling;
		expect(nativeStream.connectChannel).not.toHaveBeenCalled();
		expect(nativeStream.disconnectChannel).not.toHaveBeenCalled();
		expect(nativeStream.dispose).toHaveBeenCalledTimes(2);
		expect(responseRaw.end).toHaveBeenCalledOnce();
	});
});
