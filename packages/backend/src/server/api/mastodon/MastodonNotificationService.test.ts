/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonNotificationService } from './MastodonNotificationService.js';

describe(MastodonNotificationService, () => {
	function createService() {
		const redis = {
			zadd: vi.fn().mockResolvedValue(1),
			zremrangebyscore: vi.fn().mockResolvedValue(0),
			zremrangebyrank: vi.fn().mockResolvedValue(0),
			expire: vi.fn().mockResolvedValue(1),
			zscore: vi.fn().mockResolvedValue(null),
		};
		const rows = new Map<string, Record<string, unknown>>();
		let id = 0;
		const state = {
			get: vi.fn(async (userId: string, kind: string, key: string) => rows.get(`${userId}:${kind}:${key}`) ?? null),
			getMany: vi.fn(async (userId: string, kind: string, keys: string[]) => new Map(keys.flatMap(key => {
				const row = rows.get(`${userId}:${kind}:${key}`);
				return row == null ? [] : [[key, row] as const];
			}))),
			getById: vi.fn(async (rowId: string) => [...rows.values()].find(row => row.id === rowId) ?? null),
			put: vi.fn(async (input: { userId: string; kind: string; key: string; value: unknown; expiresAt?: Date | null }) => {
				const stateKey = `${input.userId}:${input.kind}:${input.key}`;
				const previous = rows.get(stateKey);
				const row = { id: previous?.id ?? `state-${++id}`, ...input, version: Number(previous?.version ?? 0) + 1, updatedAt: new Date() };
				rows.set(stateKey, row);
				return row;
			}),
			createWithId: vi.fn(async (input: { id: string; userId: string; kind: string; key: string; value: unknown }) => {
				const row = { ...input, version: 1, updatedAt: new Date() };
				rows.set(`${input.userId}:${input.kind}:${input.key}`, row);
				return row;
			}),
			withUserKindLock: vi.fn(async (_userId: string, _kind: string, callback: (service: unknown) => Promise<unknown>) => await callback(state)),
			withUserKindLocks: vi.fn(async (_locks: unknown[], callback: (service: unknown) => Promise<unknown>) => await callback(state)),
		};
		const idService = { gen: vi.fn(() => `public-${++id}`), parse: vi.fn(() => ({ date: new Date(0) })) };
		const roleService = { getUserPolicies: vi.fn().mockResolvedValue({ canPublicNote: true }) };
		const usersRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const followingsRepository = { findBy: vi.fn().mockResolvedValue([]) };
		return {
			redis,
			state,
			idService,
			roleService,
			usersRepository,
			followingsRepository,
			service: new MastodonNotificationService(redis as never, state as never, idService as never, roleService as never, usersRepository as never, followingsRepository as never),
		};
	}

	test('maps Mastodon notification filters to Misskey types', () => {
		const { service } = createService();

		expect(service.toMisskeyTypes(['mention', 'favourite', 'reblog', 'follow_request'])).toEqual([
			'mention',
			'reply',
			'quote',
			'reaction',
			'reaction:grouped',
			'renote',
			'renote:grouped',
			'receiveFollowRequest',
		]);
		expect(service.toMisskeyTypes(['status'])).toEqual(['note']);
	});

	test('stores a bounded expiring user-scoped dismissal', async () => {
		const { redis, service } = createService();

		await service.dismiss('user-id', 'notification-id');

		expect(redis.zadd).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			expect.any(Number),
			'notification-id',
		);
		expect(redis.zremrangebyscore).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			0,
			expect.any(Number),
		);
		expect(redis.zremrangebyrank).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			0,
			-1001,
		);
		expect(redis.expire).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			90 * 24 * 60 * 60,
		);
	});

	test('stores at most 100 individual dismissals in one Redis write', async () => {
		const { redis, service } = createService();

		await service.dismissMany('user-id', ['notification-a', 'notification-b', 'notification-a']);

		expect(redis.zadd).toHaveBeenCalledTimes(1);
		expect(redis.zadd).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			expect.any(Number),
			'notification-a',
			expect.any(Number),
			'notification-b',
		);
		await expect(service.dismissMany('user-id', Array.from({ length: 101 }, (_, index) => `notification-${index}`))).rejects.toMatchObject({ statusCode: 422 });
	});

	test('filters only notifications dismissed by the same user', async () => {
		const { redis, service } = createService();
		redis.zscore.mockImplementation(async (key: string, id: string) => key.endsWith(':user-a') && id === 'dismissed' ? '1' : null);

		await expect(service.filterDismissed('user-a', [
			{ id: 'dismissed' },
			{ id: 'visible' },
		])).resolves.toEqual([{ id: 'visible' }]);
		await expect(service.filterDismissed('user-b', [
			{ id: 'dismissed' },
		])).resolves.toEqual([{ id: 'dismissed' }]);
	});

	test('builds the exact grouped notifications wrapper with bounded samples and ungrouped fallbacks', async () => {
		const { service, state } = createService();
		const grouped = service as MastodonNotificationService & {
			grouped: (userId: string, notifications: unknown[], options: { groupedTypes: string[]; limit: number }) => Promise<Record<string, unknown>>;
		};
		const status = { id: 'status-1' };
		const result = await grouped.grouped('user-id', [
			{ native: { id: '103', createdAt: '2026-07-17T10:45:00.000Z' }, entity: { id: '103', type: 'favourite', created_at: '2026-07-17T10:45:00.000Z', account: { id: 'account-b' }, status } },
			{ native: { id: '102', createdAt: '2026-07-17T10:15:00.000Z' }, entity: { id: '102', type: 'favourite', created_at: '2026-07-17T10:15:00.000Z', account: { id: 'account-a' }, status } },
			{ native: { id: '101', createdAt: '2026-07-17T09:59:00.000Z' }, entity: { id: '101', type: 'reblog', created_at: '2026-07-17T09:59:00.000Z', account: { id: 'account-a' }, status } },
			{ native: { id: '100', createdAt: '2026-07-17T09:00:00.000Z' }, entity: { id: '100', type: 'mention', created_at: '2026-07-17T09:00:00.000Z', account: { id: 'account-c' }, status: { id: 'mention-status' } } },
		], { groupedTypes: ['favourite'], limit: 40 });

		const hour = Math.floor(Date.parse('2026-07-17T10:45:00.000Z') / 3_600_000);
		expect(result).toEqual({
			accounts: [{ id: 'account-b' }, { id: 'account-a' }, { id: 'account-c' }],
			statuses: [{ id: 'status-1' }, { id: 'mention-status' }],
			notification_groups: [
				{
					group_key: `favourite-status-1-${hour}`,
					notifications_count: 2,
					type: 'favourite',
					most_recent_notification_id: '103',
					page_min_id: '102',
					page_max_id: '103',
					latest_page_notification_at: '2026-07-17T10:45:00.000Z',
					sample_account_ids: ['account-b', 'account-a'],
					status_id: 'status-1',
				},
				expect.objectContaining({
					group_key: 'ungrouped-101',
					notifications_count: 1,
					most_recent_notification_id: '101',
				}),
				expect.objectContaining({
					group_key: 'ungrouped-100',
					type: 'mention',
					most_recent_notification_id: '100',
				}),
			],
		});
		expect(state.withUserKindLock).not.toHaveBeenCalled();
	});

	test('stops consuming notifications when the group page reaches the next new group', async () => {
		const { service } = createService();
		const source = (id: string, statusId: string) => ({
			native: { id, createdAt: '2026-07-17T10:00:00.000Z' },
			entity: { id, type: 'favourite', created_at: '2026-07-17T10:00:00.000Z', account: { id: `actor-${id}` }, status: { id: statusId } },
		});

		const result = await service.grouped('user-id', [source('103', 'status-a'), source('102', 'status-b'), source('101', 'status-a')], { limit: 1 });

		expect(result.notification_groups).toEqual([expect.objectContaining({
			notifications_count: 1,
			most_recent_notification_id: '103',
			page_min_id: '103',
			page_max_id: '103',
		})]);
	});

	test('returns canonical upstream policy defaults and validates partial updates', async () => {
		const { service } = createService();
		const policyService = service as MastodonNotificationService & {
			getPolicy: (userId: string) => Promise<Record<string, unknown>>;
			updatePolicy: (userId: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
		};

		await expect(policyService.getPolicy('user-id')).resolves.toEqual({
			for_not_following: 'accept',
			for_not_followers: 'accept',
			for_new_accounts: 'accept',
			for_private_mentions: 'drop',
			for_limited_accounts: 'filter',
			summary: { pending_requests_count: 0, pending_notifications_count: 0 },
		});
		await expect(policyService.updatePolicy('user-id', { for_not_following: 'filter' })).resolves.toMatchObject({ for_not_following: 'filter' });
		await expect(policyService.updatePolicy('user-id', { for_new_accounts: 'invalid' })).rejects.toMatchObject({ statusCode: 422 });
	});

	test('creates a durable actor request with a public state-row id and exact entity shape', async () => {
		const { service } = createService();
		const requestService = service as MastodonNotificationService & {
			requests: (userId: string, notifications: unknown[], options: { limit: number }) => Promise<Record<string, unknown>[]>;
		};
		const requests = await requestService.requests('user-id', [
			{ native: { id: '202', createdAt: '2026-07-17T11:00:00.000Z' }, entity: { id: '202', type: 'mention', created_at: '2026-07-17T11:00:00.000Z', account: { id: 'actor-a' }, status: { id: 'status-new' } }, policy: 'filter' },
			{ native: { id: '201', createdAt: '2026-07-17T10:00:00.000Z' }, entity: { id: '201', type: 'mention', created_at: '2026-07-17T10:00:00.000Z', account: { id: 'actor-a' }, status: { id: 'status-old' } }, policy: 'filter' },
		], { limit: 40 });

		expect(requests).toEqual([{
			id: expect.any(String),
			created_at: '2026-07-17T10:00:00.000Z',
			updated_at: '2026-07-17T11:00:00.000Z',
			notifications_count: '2',
			account: { id: 'actor-a' },
			last_status: { id: 'status-new' },
		}]);
	});

	test('persists group dismissal watermarks per user and revives only on newer activity', async () => {
		const { service, state } = createService();
		const source = (id: string) => ({
			native: { id, createdAt: '2026-07-17T10:45:00.000Z' },
			entity: { id, type: 'favourite', created_at: '2026-07-17T10:45:00.000Z', account: { id: 'actor-a' }, status: { id: 'status-1' } },
		});
		const first = await service.grouped('user-a', [source('103')], { groupedTypes: ['favourite'], limit: 40 });
		const key = first.notification_groups[0]!.group_key;

		await expect(service.dismissGroup('user-a', [source('103')], key, ['favourite'])).resolves.toEqual({});
		expect(state.put).toHaveBeenCalledWith(expect.objectContaining({
			userId: 'user-a',
			kind: 'notification_group_dismissed',
			expiresAt: expect.any(Date),
		}));
		const expiresAt = state.put.mock.calls.find(([input]) => input.kind === 'notification_group_dismissed')?.[0].expiresAt as Date;
		expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(89 * 24 * 60 * 60 * 1000);
		await expect(service.group('user-a', [source('103')], key, ['favourite'])).rejects.toMatchObject({ statusCode: 404 });
		await expect(service.group('user-b', [source('103')], key, ['favourite'])).resolves.toMatchObject({
			notification_groups: [expect.objectContaining({ most_recent_notification_id: '103' })],
		});
		await expect(service.group('user-a', [source('104'), source('103')], key, ['favourite'])).resolves.toMatchObject({
			notification_groups: [expect.objectContaining({ notifications_count: 1, most_recent_notification_id: '104' })],
		});
	});

	test('uses canonical proper-group watermarks across grouping modes without watermarking ungrouped dismissals', async () => {
		const { service, state } = createService();
		const source = (id: string) => ({
			native: { id, createdAt: '2026-07-17T10:00:00.000Z' },
			entity: { id, type: 'favourite', created_at: '2026-07-17T10:00:00.000Z', account: { id: `actor-${id}` }, status: { id: 'status-1' } },
			policy: 'accept' as const,
		});
		const proper = await service.grouped('user-a', [source('103')], { limit: 40 });
		await service.dismissGroup('user-a', [source('103')], proper.notification_groups[0]!.group_key);

		await expect(service.list('user-a', [source('100')], { includeFiltered: false, groupedTypes: [] })).resolves.toEqual([]);
		state.put.mockClear();
		await service.dismissGroup('user-b', [source('103')], 'ungrouped-103');
		expect(state.put).not.toHaveBeenCalled();
	});

	test('clears canonical proper groups even when the request grouping mode would ungroup them', async () => {
		const { service } = createService();
		const source = (id: string) => ({
			native: { id, createdAt: '2026-07-17T10:00:00.000Z' },
			entity: { id, type: 'favourite', created_at: '2026-07-17T10:00:00.000Z', account: { id: `actor-${id}` }, status: { id: 'status-1' } },
			policy: 'accept' as const,
		});

		await service.clearGroups('user-id', [source('103')], []);

		await expect(service.list('user-id', [source('101')], { includeFiltered: false, groupedTypes: [] })).resolves.toEqual([]);
	});

	test('keeps all bounded group accounts while limiting only sample_account_ids to eight', async () => {
		const { service } = createService();
		const notifications = Array.from({ length: 10 }, (_, index) => {
			const id = (200 - index).toString();
			return {
				native: { id, createdAt: '2026-07-17T10:45:00.000Z' },
				entity: { id, type: 'favourite', created_at: '2026-07-17T10:45:00.000Z', account: { id: `actor-${index}` }, status: { id: 'status-1' } },
			};
		});
		const grouped = await service.grouped('user-id', notifications, { limit: 40 });
		const key = grouped.notification_groups[0]!.group_key;

		expect(key).toMatch(/^favourite-status-1-/u);
		expect(grouped.notification_groups[0]!.sample_account_ids).toHaveLength(8);
		await expect(service.groupAccounts('user-id', notifications, key)).resolves.toHaveLength(10);
		await expect(service.group('user-id', notifications, key)).resolves.toMatchObject({ accounts: expect.arrayContaining(notifications.map(value => value.entity.account)) });
	});

	test('locates an ungrouped notification beyond the external 80-group page inside the bounded source', async () => {
		const { service } = createService();
		const notifications = Array.from({ length: 100 }, (_, index) => {
			const id = (500 - index).toString();
			return {
				native: { id, createdAt: '2026-07-17T10:00:00.000Z' },
				entity: { id, type: 'mention', created_at: '2026-07-17T10:00:00.000Z', account: { id: `actor-${index}` } },
			};
		});
		const target = notifications.at(-1)!;

		await expect(service.group('user-id', notifications, `ungrouped-${target.entity.id}`)).resolves.toMatchObject({
			notification_groups: [expect.objectContaining({ most_recent_notification_id: target.entity.id })],
		});
	});

	test('counts only marker-new visible notifications and optionally includes policy-filtered entries', async () => {
		const { redis, service } = createService();
		redis.zscore.mockImplementation(async (_key: string, id: string) => id === '104' ? '1' : null);
		const source = (id: string, policy: 'accept' | 'filter' | 'drop') => ({
			native: { id, createdAt: '2026-07-17T10:00:00.000Z' },
			entity: { id, type: 'follow', created_at: '2026-07-17T10:00:00.000Z', account: { id: `actor-${id}` } },
			policy,
		});
		const notifications = [source('105', 'accept'), source('104', 'accept'), source('103', 'filter'), source('102', 'drop'), source('099', 'accept')];

		await expect(service.unreadCount('user-id', notifications, { lastReadId: '100', includeFiltered: false, limit: 100 })).resolves.toEqual({ count: 1 });
		await expect(service.unreadCount('user-id', notifications, { lastReadId: '100', includeFiltered: true, limit: 100 })).resolves.toEqual({ count: 2 });
	});

	test('counts notification groups for v2 unread count but individual notifications for v1', async () => {
		const { service } = createService();
		const source = (id: string, actorId: string) => ({
			native: { id, createdAt: '2026-07-17T10:00:00.000Z' },
			entity: { id, type: 'favourite', created_at: '2026-07-17T10:00:00.000Z', account: { id: actorId }, status: { id: 'status-1' } },
			policy: 'accept' as const,
		});
		const notifications = [source('105', 'actor-a'), source('104', 'actor-b')];

		await expect(service.unreadCount('user-id', notifications, { includeFiltered: false, limit: 100, grouped: false })).resolves.toEqual({ count: 2 });
		await expect(service.unreadCount('user-id', notifications, { includeFiltered: false, limit: 100, grouped: true })).resolves.toEqual({ count: 1 });
	});

	test('evaluates policy conditions with batched users and followings and picks the strictest action', async () => {
		const { service, state, usersRepository, followingsRepository, idService, roleService } = createService();
		usersRepository.findBy.mockResolvedValue([{ id: 'actor-a' }]);
		idService.parse.mockReturnValue({ date: new Date() });
		roleService.getUserPolicies.mockResolvedValue({ canPublicNote: false });
		followingsRepository.findBy
			.mockResolvedValueOnce([{ followerId: 'user-id', followeeId: 'actor-a' }])
			.mockResolvedValueOnce([]);
		const source = {
			native: { id: '200', createdAt: '2026-07-17T10:00:00.000Z', type: 'mention', user: { id: 'actor-a' }, note: { visibility: 'specified', userId: 'actor-a' } },
			entity: { id: '200', type: 'mention', created_at: '2026-07-17T10:00:00.000Z', account: { id: 'actor-a' }, status: { id: 'status-1' } },
		};

		const [evaluated] = await service.evaluatePolicy('user-id', [source]);

		expect(evaluated?.policy).toBe('filter');
		expect(usersRepository.findBy).toHaveBeenCalledTimes(1);
		expect(followingsRepository.findBy).toHaveBeenCalledTimes(2);
		expect(state.withUserKindLocks).not.toHaveBeenCalled();
	});

	test('exempts bounded nested user-started private mention threads and terminates safely on cycles', async () => {
		const { service } = createService();
		const root = { id: 'root', userId: 'user-id' };
		const middle = { id: 'middle', userId: 'other-user', reply: root };
		const cycleA: Record<string, unknown> = { id: 'cycle-a', userId: 'other-user' };
		const cycleB: Record<string, unknown> = { id: 'cycle-b', userId: 'other-user', reply: cycleA };
		cycleA.reply = cycleB;
		const source = (id: string, reply: Record<string, unknown>) => ({
			native: { id, createdAt: '2026-07-17T10:00:00.000Z', note: { visibility: 'specified', userId: 'actor-a', reply } },
			entity: { id, type: 'mention', created_at: '2026-07-17T10:00:00.000Z', account: { id: 'actor-a' }, status: { id: `status-${id}` } },
		});

		const [nested, cyclic] = await service.evaluatePolicy('user-id', [source('nested', middle), source('cyclic', cycleA)]);

		expect(nested?.policy).toBe('accept');
		expect(cyclic?.policy).toBe('drop');
	});

	test('uses indexed request ownership guards and dismissal watermarks, then accepts the actor durably', async () => {
		const { service, state } = createService();
		const source = (id: string) => ({
			native: { id, createdAt: `2026-07-17T${id === '202' ? '11' : id === '203' ? '12' : '10'}:00:00.000Z` },
			entity: { id, type: 'mention', created_at: `2026-07-17T${id === '202' ? '11' : id === '203' ? '12' : '10'}:00:00.000Z`, account: { id: 'actor-a' }, status: { id: `status-${id}` } },
			policy: 'filter' as const,
		});
		const [request] = await service.requests('user-a', [source('202'), source('201')], { limit: 40 });
		state.put.mockClear();
		await expect(service.requests('user-a', [source('202'), source('201')], { limit: 40 })).resolves.toHaveLength(1);
		expect(state.put).not.toHaveBeenCalled();

		await expect(service.getRequest('user-b', [source('202')], request!.id)).rejects.toMatchObject({ statusCode: 404 });
		await expect(service.dismissRequest('user-a', request!.id)).resolves.toEqual({});
		await expect(service.requests('user-a', [source('202')], { limit: 40 })).resolves.toEqual([]);
		const [revived] = await service.requests('user-a', [source('203'), source('202')], { limit: 40 });
		expect(revived?.id).toBe(request!.id);
		await expect(service.acceptRequests('user-a', [request!.id])).resolves.toEqual({ merged: true });
		await expect(service.requests('user-a', [source('203')], { limit: 40 })).resolves.toEqual([]);
		expect(state.getById).toHaveBeenCalledWith(request!.id);
	});

		test('uses public request ids for max/min/since cursors and one policy/request transaction per reconciliation', async () => {
		const { service, state } = createService();
		const source = (id: string, actorId: string) => ({
			native: { id, createdAt: '2026-07-17T10:00:00.000Z' },
			entity: { id, type: 'mention', created_at: '2026-07-17T10:00:00.000Z', account: { id: actorId } },
			policy: 'filter' as const,
		});
		const notifications = [source('303', 'actor-c'), source('302', 'actor-b'), source('301', 'actor-a')];
		const all = await service.requests('user-id', notifications, { limit: 40 });
		const [high, middle, low] = all.map(value => value.id);

		await expect(service.requests('user-id', notifications, { limit: 40, maxId: high })).resolves.toEqual([
			expect.objectContaining({ id: middle }),
			expect.objectContaining({ id: low }),
		]);
		await expect(service.requests('user-id', notifications, { limit: 40, minId: low })).resolves.toEqual([
			expect.objectContaining({ id: high }),
			expect.objectContaining({ id: middle }),
		]);
		await expect(service.requests('user-id', notifications, { limit: 40, sinceId: middle })).resolves.toEqual([
			expect.objectContaining({ id: high }),
		]);
		expect(state.withUserKindLocks).toHaveBeenCalledWith([
			{ userId: 'user-id', kind: 'notification_policy' },
			{ userId: 'user-id', kind: 'notification_request' },
		], expect.any(Function));
		expect(state.getMany).toHaveBeenCalledWith('user-id', 'notification_request', ['actor-c', 'actor-b', 'actor-a']);
	});

	test('bounds request source reconciliation and bulk mutations', async () => {
		const { service } = createService();
		const notifications = Array.from({ length: 101 }, (_, index) => ({
			native: { id: (500 - index).toString(), createdAt: '2026-07-17T10:00:00.000Z' },
			entity: { id: (500 - index).toString(), type: 'follow', created_at: '2026-07-17T10:00:00.000Z', account: { id: `actor-${index}` } },
			policy: 'filter' as const,
		}));

		await expect(service.requests('user-id', notifications, { limit: 100 })).resolves.toHaveLength(100);
		await expect(service.acceptRequests('user-id', Array.from({ length: 81 }, (_, index) => `request-${index}`))).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.dismissRequests('user-id', Array.from({ length: 81 }, (_, index) => `request-${index}`))).rejects.toMatchObject({ statusCode: 422 });
	});

	test('shows a request outside the external 80-item page from the same bounded 100-source window', async () => {
		const { service } = createService();
		const notifications = Array.from({ length: 100 }, (_, index) => ({
			native: { id: (500 - index).toString(), createdAt: '2026-07-17T10:00:00.000Z' },
			entity: { id: (500 - index).toString(), type: 'follow', created_at: '2026-07-17T10:00:00.000Z', account: { id: `actor-${index}` } },
			policy: 'filter' as const,
		}));
		const requests = await service.requests('user-id', notifications, { limit: 100 });
		const outsideFirstPage = requests.at(-1)!;

		await expect(service.getRequest('user-id', notifications, outsideFirstPage.id)).resolves.toMatchObject({ id: outsideFirstPage.id });
	});
});
