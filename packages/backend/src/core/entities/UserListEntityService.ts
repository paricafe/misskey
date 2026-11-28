/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { In } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MiUserListMembership, UserListMembershipsRepository, UserListsRepository } from '@/models/_.js';
import type { Packed } from '@/misc/json-schema.js';
import type { } from '@/models/Blocking.js';
import type { MiUserList } from '@/models/UserList.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { UserEntityService } from './UserEntityService.js';

@Injectable()
export class UserListEntityService {
	constructor(
		@Inject(DI.userListsRepository)
		private userListsRepository: UserListsRepository,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		private userEntityService: UserEntityService,
		private idService: IdService,
	) {
	}

	@bindThis
	public async pack(
		src: MiUserList['id'] | MiUserList,
	): Promise<Packed<'UserList'>> {
		const userList = typeof src === 'object' ? src : await this.userListsRepository.findOneByOrFail({ id: src });

		const users = await this.userListMembershipsRepository.findBy({
			userListId: userList.id,
		});

		return {
			id: userList.id,
			createdAt: this.idService.parse(userList.id).date.toISOString(),
			name: userList.name,
			userIds: users.map(x => x.userId),
			isPublic: userList.isPublic,
		};
	}

	@bindThis
	public async packMany(
		srcs: (MiUserList['id'] | MiUserList)[],
	): Promise<Packed<'UserList'>[]> {
		if (srcs.length === 0) return [];

		const loadedById = new Map<MiUserList['id'], MiUserList>();
		const missingIds = new Set<MiUserList['id']>();
		for (const src of srcs) {
			if (typeof src === 'object') {
				loadedById.set(src.id, src);
				missingIds.delete(src.id);
			} else if (!loadedById.has(src)) {
				missingIds.add(src);
			}
		}

		if (missingIds.size > 0) {
			const fetched = await this.userListsRepository.findBy({
				id: In([...missingIds]),
			});
			for (const list of fetched) {
				loadedById.set(list.id, list);
			}
		}

		const userLists: MiUserList[] = [];
		for (const src of srcs) {
			const list = typeof src === 'object' ? src : loadedById.get(src);
			if (list != null) userLists.push(list);
		}
		if (userLists.length === 0) return [];

		const memberships = await this.userListMembershipsRepository.find({
			where: {
				userListId: In([...new Set(userLists.map(x => x.id))]),
			},
			select: {
				userListId: true,
				userId: true,
			},
		});

		const userIdsByListId = new Map<MiUserList['id'], MiUserListMembership['userId'][]>();
		for (const membership of memberships) {
			let listUserIds = userIdsByListId.get(membership.userListId);
			if (listUserIds == null) {
				listUserIds = [];
				userIdsByListId.set(membership.userListId, listUserIds);
			}
			listUserIds.push(membership.userId);
		}

		return userLists.map(userList => ({
			id: userList.id,
			createdAt: this.idService.parse(userList.id).date.toISOString(),
			name: userList.name,
			userIds: userIdsByListId.get(userList.id) ?? [],
			isPublic: userList.isPublic,
		}));
	}

	@bindThis
	public async packMembershipsMany(
		memberships: MiUserListMembership[],
	) {
		const _users = memberships.map(({ user, userId }) => user ?? userId);
		const _userMap = await this.userEntityService.packMany(_users)
			.then(users => new Map(users.map(u => [u.id, u])));
		return Promise.all(memberships.map(async x => ({
			id: x.id,
			createdAt: this.idService.parse(x.id).date.toISOString(),
			userId: x.userId,
			user: _userMap.get(x.userId) ?? await this.userEntityService.pack(x.userId),
			withReplies: x.withReplies,
		})));
	}
}

