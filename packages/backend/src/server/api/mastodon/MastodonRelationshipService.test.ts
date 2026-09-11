/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '@/server/api/error.js';
import { MastodonRelationshipService } from './MastodonRelationshipService.js';

describe(MastodonRelationshipService, () => {
	const auth = { user: { id: 'viewer' }, token: { id: 'token', scopes: ['write:follows', 'write:mutes'] } } as never;
	const request = {} as never;
	afterEach(() => vi.restoreAllMocks());

	function createService() {
		type Row = { id: string; userId: string; kind: string; key: string; value: unknown };
		const rows = new Map<string, Row>();
		const key = (userId: string, kind: string, targetId: string) => `${userId}:${kind}:${targetId}`;
		const state = {
			get: vi.fn(async (userId: string, kind: string, targetId: string) => rows.get(key(userId, kind, targetId)) ?? null),
			getMany: vi.fn(async (userId: string, kind: string, targetIds: string[]) => new Map([...rows.values()].filter(row => row.userId === userId && row.kind === kind && targetIds.includes(row.key)).map(row => [row.key, row]))),
			list: vi.fn(async (userId: string, kind: string) => [...rows.values()].filter(row => row.userId === userId && row.kind === kind)),
			put: vi.fn(async (input: { userId: string; kind: string; key: string; value: unknown }) => {
				const row = { id: `row-${rows.size}`, ...input };
				rows.set(key(input.userId, input.kind, input.key), row);
				return row;
			}),
			delete: vi.fn(async (userId: string, kind: string, targetId: string) => rows.delete(key(userId, kind, targetId))),
			withUserKindLock: vi.fn(async (_userId: string, _kind: string, work: (transaction: unknown) => Promise<unknown>) => await work(state)),
		};
		const user = { id: 'target', username: 'target', host: null as string | null, isLocked: false, isFollowing: true, isMuted: false, isBlocking: false, isRenoteMuted: false, hasPendingFollowRequestFromYou: false, notify: 'none' };
		const api = {
			invoke: vi.fn(async (endpoint: string, data: { notify?: string }) => {
				if (endpoint === 'users/show') return { ...user };
				if (endpoint === 'following/create') {
					if (user.isFollowing) throw new ApiError({ code: 'ALREADY_FOLLOWING', message: 'Already following', id: 'already' });
					user.isFollowing = true;
				}
				if (endpoint === 'following/update') user.notify = data.notify!;
				if (endpoint === 'following/delete') {
					if (!user.isFollowing) throw new ApiError({ code: 'NOT_FOLLOWING', message: 'Not following', id: 'not-following' });
					user.isFollowing = false;
				}
				if (endpoint === 'following/requests/cancel') user.hasPendingFollowRequestFromYou = false;
				if (endpoint === 'mute/delete') user.isMuted = false;
				if (endpoint === 'blocking/create') {
					if (user.isBlocking) throw new ApiError({ code: 'ALREADY_BLOCKING', message: 'Already blocking', id: 'already-blocking' });
					user.isBlocking = true;
				}
				if (endpoint === 'blocking/delete') {
					if (!user.isBlocking) throw new ApiError({ code: 'NOT_BLOCKING', message: 'Not blocking', id: 'not-blocking' });
					user.isBlocking = false;
				}
				return undefined;
			}),
		};
		const rate = { limit: vi.fn(async (): Promise<unknown> => null) };
		const service = new MastodonRelationshipService(state as never, api as never, rate as never, { getUserPolicies: async () => ({ rateLimitFactor: 1 }) } as never);
		return { service, api, state, user, rate, rows };
	}

	test('updates an existing follow with explicit notification settings and isolated feed preferences', async () => {
		const { service, api, user } = createService();
		await service.action('follow', 'target', { reblogs: false, notify: true, languages: ['en', 'ja'] }, auth, request);
		expect(api.invoke).toHaveBeenCalledWith('following/update', { userId: 'target', notify: 'normal' }, auth, request);
		expect(user.isRenoteMuted).toBe(false);
		expect(await service.relationship('viewer', user as never, { following: true, showing_reblogs: true })).toMatchObject({ showing_reblogs: false, languages: ['en', 'ja'] });
		const statuses = [
			{ id: 'boost', account: { id: 'target' }, reblog: { account: { id: 'other' } } },
			{ id: 'german', account: { id: 'target' }, language: 'de' },
			{ id: 'english', account: { id: 'target' }, language: 'en' },
			{ id: 'unknown', account: { id: 'target' }, language: null },
			{ id: 'unrelated', account: { id: 'other' }, language: 'de' },
		];
		expect((await service.filterStatuses('viewer', statuses, 'home')).map(status => status.id)).toEqual(['english', 'unknown', 'unrelated']);
		expect(await service.filterStatuses('viewer', statuses, 'public')).toEqual(statuses);
	});

	test('repeated follows preserve omitted preferences and do not reset native notifications', async () => {
		const { service, api, user } = createService();
		user.notify = 'normal';
		await service.action('follow', 'target', { reblogs: false, 'languages[]': 'en' }, auth, request);
		await service.action('follow', 'target', {}, auth, request);
		expect(api.invoke.mock.calls.some(([endpoint]) => endpoint === 'following/update')).toBe(false);
		expect(user.notify).toBe('normal');
		expect(user.isFollowing).toBe(true);
		expect(await service.relationship('viewer', user as never, {})).toMatchObject({ showing_reblogs: false, languages: ['en'] });
	});

	test('enables notifications in the same request that follows an unlocked local account', async () => {
		const { service, api, user } = createService();
		user.isFollowing = false;
		await expect(service.action('follow', 'target', { notify: true }, auth, request)).resolves.toMatchObject({ isFollowing: true, notify: 'normal' });
		expect(api.invoke.mock.calls.map(([endpoint]) => endpoint)).toEqual(['users/show', 'following/create', 'users/show', 'following/update', 'users/show']);
	});

	test.each(['none', 'normal'])('keeps native notification value %s when a new follow omits notify', async notify => {
		const { service, api, user } = createService();
		user.isFollowing = false;
		user.notify = notify;
		await service.action('follow', 'target', {}, auth, request);
		expect(user.notify).toBe(notify);
		expect(api.invoke.mock.calls.some(([endpoint]) => endpoint === 'following/update')).toBe(false);
	});

	test.each([
		{ host: null, isLocked: true, hasPendingFollowRequestFromYou: false },
		{ host: 'remote.example', isLocked: false, hasPendingFollowRequestFromYou: false },
		{ host: null, isLocked: false, hasPendingFollowRequestFromYou: true },
	])('rejects notification opt-in before creating a potentially pending follow: %s', async flags => {
		const { service, api, user, state } = createService();
		Object.assign(user, flags, { isFollowing: false });
		await expect(service.action('follow', 'target', { notify: true }, auth, request)).rejects.toMatchObject({ statusCode: 422 });
		expect(api.invoke.mock.calls.every(([endpoint]) => endpoint === 'users/show')).toBe(true);
		expect(state.put).not.toHaveBeenCalled();
	});

	test('requires an accepted follow before a bot opts into notifications', async () => {
		const { service, api, user } = createService();
		user.isFollowing = false;
		const botAuth = { user: { id: 'viewer', isBot: true } } as never;
		await expect(service.action('follow', 'target', { notify: true }, botAuth, request)).rejects.toMatchObject({ statusCode: 422 });
		expect(api.invoke.mock.calls.every(([endpoint]) => endpoint === 'users/show')).toBe(true);
		user.isFollowing = true;
		await expect(service.action('follow', 'target', { notify: true }, botAuth, request)).resolves.toMatchObject({ notify: 'normal' });
	});

	test('keeps accepted remote follows idempotent while updating explicit notifications', async () => {
		const { service, user } = createService();
		user.host = 'remote.example';
		user.isLocked = true;
		await service.action('follow', 'target', { notify: true }, auth, request);
		await expect(service.action('follow', 'target', { notify: true }, auth, request)).resolves.toMatchObject({ isFollowing: true, notify: 'normal' });
		await expect(service.action('follow', 'target', { notify: false }, auth, request)).resolves.toMatchObject({ isFollowing: true, notify: 'none' });
	});

	test('does not resend pending follow requests and cancels them on an idempotent unfollow', async () => {
		const { service, api, user } = createService();
		user.isFollowing = false;
		user.hasPendingFollowRequestFromYou = true;
		await service.action('follow', 'target', {}, auth, request);
		expect(api.invoke.mock.calls.some(([endpoint]) => endpoint === 'following/create')).toBe(false);
		await service.action('unfollow', 'target', {}, auth, request);
		await service.action('unfollow', 'target', {}, auth, request);
		expect(user.hasPendingFollowRequestFromYou).toBe(false);
		expect(await service.relationship('viewer', user as never, {})).not.toHaveProperty('languages');
	});

	test('stores a status-only mute without muting native notifications or the native account', async () => {
		const { service, api, user } = createService();
		await service.action('mute', 'target', { notifications: false }, auth, request);
		expect(api.invoke.mock.calls.every(([endpoint]) => endpoint === 'users/show')).toBe(true);
		expect(user.isMuted).toBe(false);
		expect(await service.relationship('viewer', user as never, {})).toMatchObject({ muting: true, muting_notifications: false });
		const statuses = [{ id: 'post', account: { id: 'target' } }, { id: 'boost', account: { id: 'other' }, reblog: { account: { id: 'target' } } }];
		expect(await service.filterStatuses('viewer', statuses, 'home')).toEqual([]);
		expect(await service.filterStatuses('viewer', statuses, 'notifications')).toEqual(statuses);
		expect(await service.filterNotifications('viewer', statuses)).toEqual(statuses);
		await service.action('mute', 'target', { notifications: true }, auth, request);
		expect(await service.filterNotifications('viewer', statuses)).toEqual([statuses[1]]);
		expect(await service.filterStatuses('viewer', statuses, 'notifications')).toEqual([]);
	});

	test('updates expiry on repeated mutes and stops filtering as soon as the duration expires', async () => {
		const { service, user } = createService();
		const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
		await service.action('mute', 'target', { duration: 60 }, auth, request);
		expect(await service.listMutes('viewer')).toEqual([{ id: 'row-0', accountId: 'target' }]);
		now.mockReturnValue(1_010_000);
		await service.action('mute', 'target', { duration: 5 }, auth, request);
		now.mockReturnValue(1_015_001);
		expect(await service.relationship('viewer', user as never, {})).toMatchObject({ muting: false, muting_notifications: false });
		expect(await service.listMutes('viewer')).toEqual([]);
		expect(await service.filterStatuses('viewer', [{ account: { id: 'target' } }], 'home')).toHaveLength(1);
	});

	test('does not silently weaken an existing native mute when changing compatibility settings', async () => {
		const { service, user, state, api } = createService();
		user.isMuted = true;
		await expect(service.action('mute', 'target', { notifications: false }, auth, request)).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.action('mute', 'target', { duration: 10 }, auth, request)).rejects.toMatchObject({ statusCode: 422 });
		expect(state.put).not.toHaveBeenCalled();
		await service.action('unmute', 'target', {}, auth, request);
		expect(api.invoke).toHaveBeenCalledWith('mute/delete', { userId: 'target' }, auth, request);
		expect(user.isMuted).toBe(false);
	});

	test('keeps block and unblock idempotent while preserving non-idempotent native errors', async () => {
		const { service, api } = createService();
		await service.action('block', 'target', {}, auth, request);
		await service.action('block', 'target', {}, auth, request);
		await service.action('unblock', 'target', {}, auth, request);
		await service.action('unblock', 'target', {}, auth, request);
		api.invoke.mockRejectedValueOnce(new ApiError({ code: 'NO_SUCH_USER', message: 'Missing', id: 'missing' }));
		await expect(service.action('follow', 'missing', {}, auth, request)).rejects.toMatchObject({ code: 'NO_SUCH_USER' });
	});

	test.each([
		['follow', { reblogs: 'invalid' }],
		['follow', { languages: ['not-a-language'] }],
		['follow', { notify: [] }],
		['mute', { notifications: 'invalid' }],
		['mute', { duration: -1 }],
	] as const)('validates %s parameters before writing any state', async (action, body) => {
		const { service, api, state } = createService();
		await expect(service.action(action, 'target', body, auth, request)).rejects.toBeInstanceOf(Error);
		expect(api.invoke.mock.calls.every(([endpoint]) => endpoint === 'users/show')).toBe(true);
		expect(state.put).not.toHaveBeenCalled();
	});

	test('does not claim notifications are enabled for an unaccepted follow', async () => {
		const { service, user, state } = createService();
		user.isFollowing = false;
		user.hasPendingFollowRequestFromYou = true;
		await expect(service.action('follow', 'target', { notify: true }, auth, request)).rejects.toMatchObject({ statusCode: 422 });
		expect(state.put).not.toHaveBeenCalled();
	});

	test('keeps native rate and moved-account protections for compatibility mutes', async () => {
		const { service, state, rate } = createService();
		rate.limit.mockResolvedValueOnce({ info: { resetMs: 60_000 } });
		await expect(service.action('mute', 'target', {}, auth, request)).rejects.toMatchObject({ httpStatusCode: 429 });
		await expect(service.action('mute', 'target', {}, { user: { id: 'viewer', movedToUri: 'https://other.example/@viewer' } } as never, request)).rejects.toMatchObject({ statusCode: 403 });
		expect(state.put).not.toHaveBeenCalled();
	});
});
