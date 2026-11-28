/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiUserList } from '@/models/UserList.js';
import { UserListEntityService } from './UserListEntityService.js';

describe('UserListEntityService.packMany', () => {
	function createService() {
		const userListsRepository = {
			findBy: vi.fn().mockResolvedValue([]),
			findOneByOrFail: vi.fn(),
		};
		const userListMembershipsRepository = {
			find: vi.fn().mockResolvedValue([]),
			findBy: vi.fn(),
		};
		const idService = {
			parse: () => ({ date: new Date('2026-01-01T00:00:00.000Z') }),
		};

		const service = new UserListEntityService(
			userListsRepository as never,
			userListMembershipsRepository as never,
			{} as never,
			idService as never,
		);

		return { service, userListsRepository, userListMembershipsRepository };
	}

	test('batches memberships for 50 preloaded lists into one query without cross-list leakage', async () => {
		const { service, userListsRepository, userListMembershipsRepository } = createService();
		const lists = Array.from({ length: 50 }, (_, i) => ({
			id: `list-${i}`,
			name: `List ${i}`,
			isPublic: i % 2 === 0,
		})) as MiUserList[];

		userListMembershipsRepository.find.mockResolvedValue([
			{ userListId: 'list-0', userId: 'u-a' },
			{ userListId: 'list-0', userId: 'u-b' },
			{ userListId: 'list-49', userId: 'u-z' },
		]);

		const packed = await service.packMany(lists);

		expect(userListsRepository.findBy).not.toHaveBeenCalled();
		expect(userListMembershipsRepository.find).toHaveBeenCalledTimes(1);
		expect(userListMembershipsRepository.findBy).not.toHaveBeenCalled();
		expect(packed).toHaveLength(50);
		expect(packed[0].userIds).toEqual(['u-a', 'u-b']);
		expect(packed[1].userIds).toEqual([]);
		expect(packed[49].userIds).toEqual(['u-z']);
	});

	test('returns empty array with zero queries for empty input and at most two queries for IDs', async () => {
		const { service, userListsRepository, userListMembershipsRepository } = createService();

		await expect(service.packMany([])).resolves.toEqual([]);
		expect(userListsRepository.findBy).not.toHaveBeenCalled();
		expect(userListMembershipsRepository.find).not.toHaveBeenCalled();

		userListsRepository.findBy.mockResolvedValue([
			{ id: 'list-b', name: 'B', isPublic: false },
			{ id: 'list-a', name: 'A', isPublic: true },
		]);
		userListMembershipsRepository.find.mockResolvedValue([
			{ userListId: 'list-a', userId: 'u1' },
		]);

		const packed = await service.packMany(['list-a', 'list-b']);
		expect(userListsRepository.findBy).toHaveBeenCalledTimes(1);
		expect(userListMembershipsRepository.find).toHaveBeenCalledTimes(1);
		expect(packed.map(x => [x.id, x.userIds])).toEqual([
			['list-a', ['u1']],
			['list-b', []],
		]);
	});
});
