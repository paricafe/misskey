/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiNotification } from '@/models/Notification.js';
import { NotificationEntityService } from './NotificationEntityService.js';

describe('NotificationEntityService followeeId filtering and notifier reuse', () => {
	function createService(activeFollowRequests: Array<{ followerId: string; followeeId: string }>) {
		const usersRepository = {
			find: vi.fn().mockResolvedValue([
				{ id: 'requester', isSuspended: false },
				{ id: 'liker', isSuspended: false },
			]),
		};
		const followRequestsRepository = {
			find: vi.fn(async ({ where }: { where: { followeeId: string; followerId: { value: string[] } } }) => {
				const followerIds = where.followerId.value;
				return activeFollowRequests
					.filter(r => r.followeeId === where.followeeId && followerIds.includes(r.followerId))
					.map(r => ({ followerId: r.followerId }));
			}),
		};
		const userEntityService = {
			packMany: vi.fn(async (users: Array<{ id: string }>) => users.map(u => ({ id: u.id, username: u.id }))),
		};
		const noteEntityService = {
			packMany: vi.fn(async (notes: Array<{ id: string }>) => notes.map(n => ({ id: n.id }))),
		};
		const services: Record<string, unknown> = {
			UserEntityService: userEntityService,
			NoteEntityService: noteEntityService,
			RoleEntityService: {},
			ChatEntityService: {},
		};
		const moduleRef = { get: (name: string) => services[name] };

		const service = new NotificationEntityService(
			moduleRef as never,
			{ find: vi.fn().mockResolvedValue([{ id: 'note-1' }]) } as never,
			usersRepository as never,
			followRequestsRepository as never,
			{
				userBlockedCache: { fetch: vi.fn().mockResolvedValue(new Set()) },
				userBlockingCache: { fetch: vi.fn().mockResolvedValue(new Set()) },
				userMutingsCache: { fetch: vi.fn().mockResolvedValue(new Set()) },
				userProfileCache: { fetch: vi.fn().mockResolvedValue({ mutedInstances: [] }) },
			} as never,
		);
		service.onModuleInit();

		return { service, usersRepository, followRequestsRepository, userEntityService };
	}

	test('filters withdrawn receiveFollowRequest per followeeId in both packMany and packGroupedMany', async () => {
		const { service, usersRepository, followRequestsRepository } = createService([
			{ followerId: 'requester', followeeId: 'user-b' },
		]);

		const notification: MiNotification = {
			id: 'notif-1',
			createdAt: '2026-01-01T00:00:00.000Z',
			type: 'receiveFollowRequest',
			notifierId: 'requester',
		};

		const packedForA = await service.packMany([notification], 'user-a');
		const packedForB = await service.packMany([notification], 'user-b');
		const groupedForA = await service.packGroupedMany([notification], 'user-a');
		const groupedForB = await service.packGroupedMany([notification], 'user-b');

		expect(packedForA).toEqual([]);
		expect(groupedForA).toEqual([]);
		expect(packedForB).toHaveLength(1);
		expect(groupedForB).toHaveLength(1);
		expect(followRequestsRepository.find).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({ followeeId: 'user-a' }),
			select: { followerId: true },
		}));
		expect(usersRepository.find).toHaveBeenCalledTimes(4);
	});

	test('reuses notifier entities from #filterValidNotifier without querying usersRepository a second time', async () => {
		const { service, usersRepository, userEntityService } = createService([]);

		const notifications: MiNotification[] = [
			{
				id: 'notif-1',
				createdAt: '2026-01-01T00:00:00.000Z',
				type: 'follow',
				notifierId: 'requester',
			},
			{
				id: 'notif-2',
				createdAt: '2026-01-01T00:00:01.000Z',
				type: 'follow',
				notifierId: 'liker',
			},
		];

		const packed = await service.packMany(notifications, 'user-a');

		expect(packed).toHaveLength(2);
		expect(usersRepository.find).toHaveBeenCalledTimes(1);
		expect(userEntityService.packMany).toHaveBeenCalledTimes(1);
	});
});
