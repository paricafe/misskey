/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MastodonApiError } from './errors.js';
import { MastodonApiServerService } from './MastodonApiServerService.js';

describe(MastodonApiServerService, () => {
	const servers: ReturnType<typeof Fastify>[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map(server => server.close()));
	});

	function createServer() {
		const auth = { kind: 'user', user: { id: 'user-id' }, token: { id: 'token-id', scopes: ['read'] } };
		const authenticate = vi.fn().mockResolvedValue(auth);
		const assert = vi.fn();
		const nativeInvoke = vi.fn(async name => {
			if (name === 'i') return { id: 'user-id', username: 'alice' };
			if (name === 'notes/timeline') return [{ id: 'note-id' }];
			if (name === 'notes/show') return { id: 'note-id' };
			if (name === 'notes/create') return { createdNote: { id: 'created-note-id' } };
			return [];
		});
		const registerApplication = vi.fn().mockResolvedValue({ client_id: 'client-id', client_secret: 'client-secret' });
		const getApplication = vi.fn().mockResolvedValue({ id: 'client-id', name: 'Elk' });
		const redis = {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue('OK'),
			del: vi.fn().mockResolvedValue(1),
			incr: vi.fn().mockResolvedValue(1),
			expire: vi.fn().mockResolvedValue(1),
		};
		const notesRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const noteFavoritesRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const userNotePiningsRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const service = new MastodonApiServerService(
			{ url: 'https://misskey.example/', host: 'misskey.example', version: '2026.7.0', maxFileSize: 10_000_000 } as never,
			{ name: 'Misskey Test', description: 'Test instance', langs: ['en'], bannerUrl: null } as never,
			notesRepository as never,
			noteFavoritesRepository as never,
			userNotePiningsRepository as never,
			{ registerApplication, getApplication } as never,
			{ authenticate } as never,
			{ assert } as never,
			{ invoke: nativeInvoke, invokePublic: nativeInvoke } as never,
			{
				account: vi.fn(value => ({ id: value.id, username: value.username })),
				credentialAccount: vi.fn(value => ({ id: value.id, username: value.username })),
				status: vi.fn(value => ({ id: value.id })),
			} as never,
			{
				toMisskey: vi.fn().mockReturnValue({ limit: 20 }),
				linkHeader: vi.fn().mockReturnValue('<next>; rel="next"'),
			} as never,
			redis as never,
		);
		const fastify = Fastify();
		fastify.register(service.createServer);
		servers.push(fastify);

		return {
			fastify,
			authenticate,
			assert,
			nativeInvoke,
			registerApplication,
			getApplication,
			redis,
			notesRepository,
			noteFavoritesRepository,
			userNotePiningsRepository,
		};
	}

	test('registers Mastodon applications from JSON', async () => {
		const { fastify, registerApplication } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/apps',
			payload: { client_name: 'Elk', redirect_uris: 'https://elk.example/callback', scopes: 'read write' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ client_id: 'client-id', client_secret: 'client-secret' });
		expect(registerApplication).toHaveBeenCalledWith(expect.objectContaining({ client_name: 'Elk' }));
	});

	test('rejects query-string bearer tokens on REST routes', async () => {
		const { fastify, authenticate } = createServer();
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/verify_credentials?access_token=secret' });

		expect(response.statusCode).toBe(401);
		expect(authenticate).not.toHaveBeenCalled();
	});

	test('accepts an application token for app verification', async () => {
		const { fastify, authenticate, getApplication, assert } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
		});
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/apps/verify_credentials',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(getApplication).toHaveBeenCalledWith('client-id');
		expect(assert).not.toHaveBeenCalled();
	});

	test('rejects an application token on user-only routes', async () => {
		const { fastify, authenticate } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
		});
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/verify_credentials',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(422);
	});

	test('serves public routes anonymously when Authorization is absent', async () => {
		const { fastify, authenticate, nativeInvoke, notesRepository, noteFavoritesRepository, userNotePiningsRepository } = createServer();
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/statuses/note-id' });

		expect(response.statusCode).toBe(200);
		expect(authenticate).not.toHaveBeenCalled();
		expect(nativeInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-id' }, null, expect.any(Object));
		expect(notesRepository.findBy).not.toHaveBeenCalled();
		expect(noteFavoritesRepository.findBy).not.toHaveBeenCalled();
		expect(userNotePiningsRepository.findBy).not.toHaveBeenCalled();
	});

	test('uses a user token and viewer state on public routes', async () => {
		const { fastify, authenticate, assert, nativeInvoke, notesRepository, noteFavoritesRepository, userNotePiningsRepository } = createServer();
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'bEaReR mastodon-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(authenticate).toHaveBeenCalledWith('mastodon-token');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
		expect(nativeInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-id' }, expect.objectContaining({ kind: 'user' }), expect.any(Object));
		expect(notesRepository.findBy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-id' }));
		expect(noteFavoritesRepository.findBy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-id' }));
		expect(userNotePiningsRepository.findBy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-id' }));
	});

	test('treats an application token as anonymous on public routes', async () => {
		const { fastify, authenticate, assert, nativeInvoke, notesRepository } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
		});
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-id' }, null, expect.any(Object));
		expect(assert).not.toHaveBeenCalled();
		expect(notesRepository.findBy).not.toHaveBeenCalled();
	});

	test('rejects malformed and invalid Authorization on public routes', async () => {
		const { fastify, authenticate, nativeInvoke } = createServer();
		const malformed = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Basic mastodon-token' },
		});
		expect(malformed.statusCode).toBe(401);
		expect(authenticate).not.toHaveBeenCalled();

		authenticate.mockRejectedValueOnce(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));
		const invalid = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer invalid-token' },
		});

		expect(invalid.statusCode).toBe(401);
		expect(nativeInvoke).not.toHaveBeenCalled();
	});

	test('rejects unknown and recipient-less direct visibility instead of publishing publicly', async () => {
		const { fastify, nativeInvoke } = createServer();
		const headers = { authorization: 'Bearer mastodon-token', 'content-type': 'application/json' };
		const unknown = await fastify.inject({ method: 'POST', url: '/api/v1/statuses', headers, payload: { status: 'private', visibility: 'friends' } });
		const direct = await fastify.inject({ method: 'POST', url: '/api/v1/statuses', headers, payload: { status: 'secret', visibility: 'direct' } });

		expect(unknown.statusCode).toBe(422);
		expect(direct.statusCode).toBe(422);
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/create', expect.anything(), expect.anything(), expect.anything());
	});

	test('maps account status filters and media sensitivity to native parameters', async () => {
		const { fastify, nativeInvoke } = createServer();
		const headers = { authorization: 'Bearer mastodon-token' };
		await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?exclude_replies=true&exclude_reblogs=true', headers });
		await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { ...headers, 'content-type': 'application/json' },
			payload: { status: 'sensitive', visibility: 'private', sensitive: true, media_ids: ['file-id'] },
		});

		expect(nativeInvoke).toHaveBeenCalledWith('users/notes', expect.objectContaining({ withReplies: false, withRenotes: false }), expect.anything(), expect.anything());
		expect(nativeInvoke).toHaveBeenCalledWith('drive/files/update', { fileId: 'file-id', isSensitive: true }, expect.anything(), expect.anything());
		expect(nativeInvoke).toHaveBeenCalledWith('notes/create', expect.objectContaining({ visibility: 'followers', fileIds: ['file-id'] }), expect.anything(), expect.anything());
	});

	test('preserves attachments on text-only edits and never clears file sensitivity', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => {
			if (name === 'notes/show') return { id: 'note-id', text: 'old', fileIds: ['existing-file'] };
			if (name === 'notes/update') return { updatedNote: { id: 'note-id' } };
			return [];
		});
		const response = await fastify.inject({
			method: 'PUT',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer mastodon-token', 'content-type': 'application/json' },
			payload: { status: 'edited', sensitive: false },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/update', expect.objectContaining({ fileIds: ['existing-file'], text: 'edited' }), expect.anything(), expect.anything());
		expect(nativeInvoke).not.toHaveBeenCalledWith('drive/files/update', expect.anything(), expect.anything(), expect.anything());
	});

	test('orders thread ancestors from root to immediate parent', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'notes/conversation'
			? [{ id: 'parent' }, { id: 'root' }]
			: name === 'notes/children'
				? []
				: []);
		const response = await fastify.inject({
			method: 'GET', url: '/api/v1/statuses/note-id/context', headers: { authorization: 'Bearer mastodon-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json().ancestors).toEqual([
			expect.objectContaining({ id: 'root' }),
			expect.objectContaining({ id: 'parent' }),
		]);
	});

	test('unreblogs only pure renotes and preserves quote posts', async () => {
		const { fastify, nativeInvoke, notesRepository } = createServer();
		notesRepository.findBy.mockResolvedValue([
			{ id: 'quote-id', text: 'my quote', cw: null, fileIds: [], hasPoll: false, replyId: null, renoteId: 'target-id' },
			{ id: 'pure-id', text: null, cw: null, fileIds: [], hasPoll: false, replyId: null, renoteId: 'target-id' },
		]);
		nativeInvoke.mockImplementation(async name => name === 'notes/show' ? { id: 'target-id' } : undefined);
		const response = await fastify.inject({
			method: 'POST', url: '/api/v1/statuses/target-id/unreblog', headers: { authorization: 'Bearer mastodon-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/delete', { noteId: 'pure-id' }, expect.anything(), expect.anything());
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/delete', { noteId: 'quote-id' }, expect.anything(), expect.anything());
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/unrenote', expect.anything(), expect.anything(), expect.anything());
	});

	test('rate limits dynamic application registration', async () => {
		const { fastify, registerApplication, redis } = createServer();
		redis.incr.mockResolvedValue(61);
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/apps',
			payload: { client_name: 'Elk', redirect_uris: 'https://elk.example/callback' },
		});

		expect(response.statusCode).toBe(429);
		expect(registerApplication).not.toHaveBeenCalled();
	});

	test('publishes a Mastodon v2 instance document without authentication', async () => {
		const { fastify, authenticate } = createServer();
		const response = await fastify.inject({ method: 'GET', url: '/api/v2/instance' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			domain: 'misskey.example',
			title: 'Misskey Test',
			api_versions: { mastodon: 4 },
			configuration: { urls: { streaming: 'wss://misskey.example/api/v1/streaming' } },
		});
		expect(authenticate).not.toHaveBeenCalled();
	});

	test('authenticates, checks scope, and reuses native endpoints', async () => {
		const { fastify, authenticate, assert, nativeInvoke } = createServer();
		const verify = await fastify.inject({
			method: 'GET', url: '/api/v1/accounts/verify_credentials', headers: { authorization: 'Bearer mastodon-token' },
		});
		const timeline = await fastify.inject({
			method: 'GET', url: '/api/v1/timelines/home', headers: { authorization: 'Bearer mastodon-token' },
		});

		expect(verify.statusCode).toBe(200);
		expect(verify.json()).toEqual({ id: 'user-id', username: 'alice' });
		expect(timeline.statusCode).toBe(200);
		expect(timeline.json()).toEqual([expect.objectContaining({ id: 'note-id' })]);
		expect(timeline.headers.link).toBe('<next>; rel="next"');
		expect(authenticate).toHaveBeenCalledWith('mastodon-token');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:accounts');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
		expect(nativeInvoke).toHaveBeenCalledWith('i', {}, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('notes/timeline', { limit: 20 }, expect.any(Object), expect.any(Object));
	});
});
