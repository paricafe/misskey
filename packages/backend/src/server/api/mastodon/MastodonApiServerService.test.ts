/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '@/server/api/error.js';
import { MastodonApiError } from './errors.js';
import { MastodonApiServerService } from './MastodonApiServerService.js';
import { MastodonNotificationService } from './MastodonNotificationService.js';

describe(MastodonApiServerService, () => {
	const servers: ReturnType<typeof Fastify>[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map(server => server.close()));
	});

	function createServer(meta: Record<string, unknown> = {}) {
		const auth = { kind: 'user', user: { id: 'user-id' }, token: { id: 'token-id', scopes: ['read'] } };
		const dismissedNotifications = new Set<string>();
		const authenticate = vi.fn().mockResolvedValue(auth);
		const assert = vi.fn();
		const nativeInvoke = vi.fn(async (name: string, data: Record<string, unknown>, _viewer?: unknown, _request?: unknown): Promise<unknown> => {
			if (name === 'i') return { id: 'user-id', username: 'alice' };
			if (name === 'emojis') return {
				emojis: [{
					name: 'blobcat',
					url: 'https://misskey.example/files/blobcat.png',
					category: 'Animals',
				}],
			};
			if (name === 'notes/timeline') return [{ id: 'note-id' }];
			if (name === 'users/show') return { id: data.userId, username: data.userId };
			if (name === 'notes/show') return data.noteId === 'note-with-poll'
				? {
					id: data.noteId,
					poll: {
						expiresAt: null,
						multiple: false,
						choices: [{ text: 'A', votes: 2, isVoted: false }],
					},
				}
				: { id: data.noteId ?? 'note-id' };
			if (name === 'notes/create') return { createdNote: { id: 'created-note-id' } };
			return [];
		});
		const publicInvoke = vi.fn((name: string, data: Record<string, unknown>, viewer: unknown, request: unknown) => nativeInvoke(name, data, viewer, request));
		const registerApplication = vi.fn().mockResolvedValue({ client_id: 'client-id', client_secret: 'client-secret' });
		const getApplication = vi.fn().mockResolvedValue({ id: 'client-id', name: 'Elk' });
		const redis = {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue('OK'),
			del: vi.fn().mockResolvedValue(1),
			incr: vi.fn().mockResolvedValue(1),
			expire: vi.fn().mockResolvedValue(1),
			zadd: vi.fn(async (_key: string, _score: number, id: string) => {
				dismissedNotifications.add(id);
				return 1;
			}),
			zremrangebyscore: vi.fn().mockResolvedValue(0),
			zremrangebyrank: vi.fn().mockResolvedValue(0),
			zscore: vi.fn(async (_key: string, id: string) => dismissedNotifications.has(id) ? '1' : null),
		};
		const notesRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const noteFavoritesRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const userNotePiningsRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const mastodonNotificationService = new MastodonNotificationService(redis as never);
		const service = new MastodonApiServerService(
			{ url: 'https://misskey.example/', host: 'misskey.example', version: '2026.7.0', maxFileSize: 10_000_000 } as never,
			{
				name: 'Misskey Test',
				description: 'Test instance',
				langs: ['en'],
				bannerUrl: null,
				iconUrl: null,
				serverRules: ['Be kind'],
				policies: { pinLimit: 5 },
				...meta,
			} as never,
			notesRepository as never,
			noteFavoritesRepository as never,
			userNotePiningsRepository as never,
			{ registerApplication, getApplication } as never,
			{ authenticate } as never,
			{ assert } as never,
			{ invoke: nativeInvoke, invokePublic: publicInvoke } as never,
			{
				account: vi.fn(value => ({ id: value.id, username: value.username })),
				credentialAccount: vi.fn(value => ({ id: value.id, username: value.username })),
				status: vi.fn(value => ({
					id: value.id,
					media_attachments: value.files ?? [],
					poll: value.poll ?? null,
				})),
				poll: vi.fn((noteId, poll) => ({ id: noteId, votes_count: poll.choices.reduce((total: number, choice: { votes: number }) => total + choice.votes, 0) })),
				notification: vi.fn(value => value.user == null ? null : {
					id: value.id,
					type: value.type ?? 'mention',
					account: { id: value.user.id },
				}),
			} as never,
			{
				toMisskey: vi.fn().mockReturnValue({ limit: 20 }),
				linkHeader: vi.fn().mockReturnValue('<next>; rel="next"'),
			} as never,
			mastodonNotificationService,
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
			publicInvoke,
			registerApplication,
			getApplication,
			redis,
			notesRepository,
			noteFavoritesRepository,
			userNotePiningsRepository,
		};
	}

	test('maps and applies notification type and account filters', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [
			{ id: 'notification-a', type: 'mention', user: { id: 'account-a' } },
			{ id: 'notification-b', type: 'mention', user: { id: 'account-b' } },
		] : []);

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/notifications?types[]=mention&types[]=favourite&exclude_types[]=follow&exclude_types[]=reblog&account_id=account-a',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([
			expect.objectContaining({ id: 'notification-a', account: { id: 'account-a' } }),
		]);
		expect(nativeInvoke).toHaveBeenCalledWith('i/notifications', {
			limit: 20,
			markAsRead: false,
			includeTypes: ['mention', 'reply', 'note', 'quote', 'reaction'],
			excludeTypes: ['follow', 'followRequestAccepted', 'renote'],
		}, expect.any(Object), expect.any(Object));
	});

	test('dismisses one notification without deleting native notifications', async () => {
		const { fastify, assert, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [
			{ id: 'notification-a', type: 'mention', user: { id: 'account-a' } },
			{ id: 'notification-b', type: 'mention', user: { id: 'account-b' } },
		] : []);
		const headers = { authorization: 'Bearer user-token' };

		const dismissed = await fastify.inject({
			method: 'POST',
			url: '/api/v1/notifications/notification-a/dismiss',
			headers,
		});
		const list = await fastify.inject({ method: 'GET', url: '/api/v1/notifications', headers });
		const single = await fastify.inject({ method: 'GET', url: '/api/v1/notifications/notification-a', headers });

		expect(dismissed.statusCode).toBe(200);
		expect(dismissed.json()).toEqual({});
		expect(list.statusCode).toBe(200);
		expect(list.json()).toEqual([
			expect.objectContaining({ id: 'notification-b' }),
		]);
		expect(single.statusCode).toBe(404);
		expect(assert).toHaveBeenCalledWith(['read'], 'write:notifications');
		expect(nativeInvoke).not.toHaveBeenCalledWith(expect.stringContaining('delete'), expect.anything(), expect.anything(), expect.anything());
	});

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

	test('serves batch accounts and statuses publicly in input order', async () => {
		const { fastify, authenticate, publicInvoke } = createServer();
		const accounts = await fastify.inject({ method: 'GET', url: '/api/v1/accounts?id[]=user-a&id[]=user-b' });
		const statuses = await fastify.inject({ method: 'GET', url: '/api/v1/statuses?id[]=note-a&id[]=note-b' });

		expect(accounts.statusCode).toBe(200);
		expect(accounts.json()).toEqual([
			expect.objectContaining({ id: 'user-a' }),
			expect.objectContaining({ id: 'user-b' }),
		]);
		expect(statuses.statusCode).toBe(200);
		expect(statuses.json()).toEqual([
			expect.objectContaining({ id: 'note-a' }),
			expect.objectContaining({ id: 'note-b' }),
		]);
		expect(authenticate).not.toHaveBeenCalled();
		expect(publicInvoke).toHaveBeenCalledWith('users/show', { userId: 'user-a' }, null, expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-a' }, null, expect.any(Object));
	});

	test('fetches batch IDs once while preserving duplicates and omitting inaccessible records', async () => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name !== 'users/show') return [];
			if (data.userId === 'missing') throw new ApiError({
				message: 'No such user.',
				code: 'NO_SUCH_USER',
				id: 'missing-user',
				httpStatusCode: 404,
			});
			if (data.userId === 'hidden') throw new ApiError({
				message: 'Content restricted.',
				code: 'CONTENT_RESTRICTED_BY_USER',
				id: 'hidden-user',
			});
			return { id: data.userId, username: data.userId };
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts?id[]=user-a&id[]=missing&id[]=hidden&id[]=user-a&id[]=user-b',
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([
			expect.objectContaining({ id: 'user-a' }),
			expect.objectContaining({ id: 'user-a' }),
			expect.objectContaining({ id: 'user-b' }),
		]);
		expect(publicInvoke).toHaveBeenCalledTimes(4);
	});

	test('caps the original batch sequence at 40 positions before de-duplicating fetches', async () => {
		const { fastify, publicInvoke } = createServer();
		const cappedIds = ['user-a', 'user-a', ...Array.from({ length: 38 }, (_, index) => `user-${index}`)];
		const ids = [...cappedIds, 'outside-cap'];
		const query = ids.map(id => `id[]=${id}`).join('&');

		const response = await fastify.inject({ method: 'GET', url: `/api/v1/accounts?${query}` });

		expect(response.statusCode).toBe(200);
		expect(response.json().map((account: { id: string }) => account.id)).toEqual(cappedIds);
		expect(publicInvoke).toHaveBeenCalledTimes(39);
		expect(publicInvoke).not.toHaveBeenCalledWith('users/show', { userId: 'outside-cap' }, expect.anything(), expect.anything());
	});

	test.each([500, 429])('rethrows %i failures from batch requests', async statusCode => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockRejectedValue(new MastodonApiError(statusCode, 'server_error', 'Failure'));

		const response = await fastify.inject({ method: 'GET', url: '/api/v1/statuses?id[]=note-a&id[]=note-b' });

		expect(response.statusCode).toBe(statusCode);
	});

	test('searches accounts with the authenticated native endpoint mapping', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockResolvedValueOnce([{ id: 'user-a', username: 'alice' }]);
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/search?q=alice&limit=5',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([expect.objectContaining({ id: 'user-a', username: 'alice' })]);
		expect(nativeInvoke).toHaveBeenCalledWith('users/search', {
			query: 'alice',
			limit: 5,
			offset: 0,
		}, expect.any(Object), expect.any(Object));
	});

	test('retrieves a poll publicly through its note', async () => {
		const { fastify, authenticate, publicInvoke } = createServer();
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/polls/note-with-poll' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ id: 'note-with-poll', votes_count: 2 });
		expect(authenticate).not.toHaveBeenCalled();
		expect(publicInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-with-poll' }, null, expect.any(Object));
	});

	test('deletes media with a user token', async () => {
		const { fastify, assert, nativeInvoke } = createServer();
		const response = await fastify.inject({
			method: 'DELETE',
			url: '/api/v1/media/file-id',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({});
		expect(assert).toHaveBeenCalledWith(['read'], 'write:media');
		expect(nativeInvoke).toHaveBeenCalledWith('drive/files/delete', { fileId: 'file-id' }, expect.any(Object), expect.any(Object));
	});

	test('maps public account status media and pinned filters', async () => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();
		const media = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?only_media=true' });

		expect(media.statusCode).toBe(200);
		expect(publicInvoke).toHaveBeenCalledWith('users/notes', expect.objectContaining({
			userId: 'user-id',
			withFiles: true,
		}), null, expect.any(Object));

		publicInvoke.mockClear();
		nativeInvoke.mockResolvedValueOnce({
			id: 'user-id',
			username: 'alice',
			pinnedNotes: [{ id: 'pinned-a' }, { id: 'pinned-b' }],
		});
		const pinned = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?pinned=true' });

		expect(pinned.statusCode).toBe(200);
		expect(pinned.json()).toEqual([
			expect.objectContaining({ id: 'pinned-a' }),
			expect.objectContaining({ id: 'pinned-b' }),
		]);
		expect(publicInvoke).toHaveBeenCalledWith('users/show', { userId: 'user-id' }, null, expect.any(Object));
		expect(publicInvoke).not.toHaveBeenCalledWith('users/notes', expect.anything(), expect.anything(), expect.anything());
	});

	test('maps supported public and hashtag timeline filters', async () => {
		const { fastify, publicInvoke } = createServer();
		const publicTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/public?only_media=true' });
		const hashtagTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/tag/fediverse?only_media=true&local=true' });

		expect(publicTimeline.statusCode).toBe(200);
		expect(hashtagTimeline.statusCode).toBe(200);
		expect(publicInvoke).toHaveBeenCalledWith('notes/global-timeline', expect.objectContaining({ withFiles: true }), null, expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('notes/search-by-tag', expect.objectContaining({
			tag: 'fediverse',
			withFiles: true,
			localHostOnly: true,
		}), null, expect.any(Object));
	});

	test('rejects unsupported remote-only public and hashtag timelines', async () => {
		const { fastify, publicInvoke } = createServer();
		const publicTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/public?remote=true' });
		const hashtagTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/tag/fediverse?remote=true' });

		expect(publicTimeline.statusCode).toBe(422);
		expect(hashtagTimeline.statusCode).toBe(422);
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('rejects scheduled statuses before creating a native note', async () => {
		const { fastify, nativeInvoke } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
			payload: { status: 'later', scheduled_at: '2099-01-01T00:00:00.000Z' },
		});

		expect(response.statusCode).toBe(422);
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/create', expect.anything(), expect.anything(), expect.anything());
	});

	test('returns deleted status text while preserving media attachments and poll', async () => {
		const { fastify, nativeInvoke } = createServer();
		const media = [{ id: 'file-id' }];
		const poll = { choices: [{ text: 'A', votes: 1 }] };
		nativeInvoke.mockImplementation(async name => name === 'notes/show'
			? { id: 'note-id', text: 'plain text', files: media, poll }
			: undefined);
		const response = await fastify.inject({
			method: 'DELETE',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			id: 'note-id',
			text: 'plain text',
			media_attachments: media,
			poll,
		});
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

	test('publishes truthful Mastodon instance discovery without authentication', async () => {
		const { fastify, authenticate } = createServer();
		const v1 = await fastify.inject({ method: 'GET', url: '/api/v1/instance' });
		const v2 = await fastify.inject({ method: 'GET', url: '/api/v2/instance' });

		expect(v1.statusCode).toBe(200);
		expect(v1.json()).toMatchObject({
			version: '4.3.0 (compatible; Misskey 2026.7.0)',
			thumbnail: 'https://misskey.example/favicon.ico',
			rules: [{ id: '1', text: 'Be kind', hint: '' }],
		});
		expect(v2.statusCode).toBe(200);
		expect(v2.json()).toMatchObject({
			domain: 'misskey.example',
			title: 'Misskey Test',
			version: '4.3.0 (compatible; Misskey 2026.7.0)',
			api_versions: { mastodon: 1 },
			thumbnail: { url: 'https://misskey.example/favicon.ico' },
			configuration: {
				accounts: { max_pinned_statuses: 5 },
				urls: { streaming: 'wss://misskey.example/api/v1/streaming' },
			},
			rules: [{ id: '1', text: 'Be kind', hint: '' }],
		});
		expect(authenticate).not.toHaveBeenCalled();
	});

	test('uses the instance icon as the discovery image when no banner is configured', async () => {
		const { fastify } = createServer({
			bannerUrl: null,
			iconUrl: 'https://misskey.example/files/icon.png',
		});
		const v1 = await fastify.inject({ method: 'GET', url: '/api/v1/instance' });
		const v2 = await fastify.inject({ method: 'GET', url: '/api/v2/instance' });

		expect(v1.json().thumbnail).toBe('https://misskey.example/files/icon.png');
		expect(v2.json().thumbnail.url).toBe('https://misskey.example/files/icon.png');
	});

	test('maps public instance rules and custom emojis from Misskey', async () => {
		const { fastify, authenticate, publicInvoke } = createServer();
		const rules = await fastify.inject({ method: 'GET', url: '/api/v1/instance/rules' });
		const emojis = await fastify.inject({ method: 'GET', url: '/api/v1/custom_emojis' });

		expect(rules.statusCode).toBe(200);
		expect(rules.json()).toEqual([
			{ id: '1', text: 'Be kind', hint: '' },
		]);
		expect(emojis.statusCode).toBe(200);
		expect(emojis.json()).toEqual([
			{
				shortcode: 'blobcat',
				url: 'https://misskey.example/files/blobcat.png',
				static_url: 'https://misskey.example/files/blobcat.png',
				visible_in_picker: true,
				category: 'Animals',
			},
		]);
		expect(authenticate).not.toHaveBeenCalled();
		expect(publicInvoke).toHaveBeenCalledWith('emojis', {}, null, expect.any(Object));
	});

	test.each(['/api/v1/instance/rules', '/api/v1/custom_emojis'])('rejects invalid Authorization on public discovery route %s', async url => {
		const { fastify, authenticate, publicInvoke } = createServer();
		authenticate.mockRejectedValue(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));

		const response = await fastify.inject({
			method: 'GET',
			url,
			headers: { authorization: 'Bearer invalid-token' },
		});

		expect(response.statusCode).toBe(401);
		expect(authenticate).toHaveBeenCalledWith('invalid-token');
		expect(publicInvoke).not.toHaveBeenCalled();
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
