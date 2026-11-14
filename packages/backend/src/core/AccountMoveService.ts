/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { IsNull, In, MoreThan, Not } from 'typeorm';

import { bindThis } from '@/decorators.js';
import { DI } from '@/di-symbols.js';
import type { MiLocalUser, MiRemoteUser, MiUser } from '@/models/User.js';
import type { BlockingsRepository, FollowingsRepository, InstancesRepository, MiMeta, MutingsRepository, UserListMembershipsRepository, UsersRepository } from '@/models/_.js';
import type { RelationshipJobData, ThinUser } from '@/queue/types.js';

import { IdService } from '@/core/IdService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { QueueService } from '@/core/QueueService.js';
import { RelayService } from '@/core/RelayService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import PerUserFollowingChart from '@/core/chart/charts/per-user-following.js';
import { SystemAccountService } from '@/core/SystemAccountService.js';
import { RoleService } from '@/core/RoleService.js';
import { AntennaService } from '@/core/AntennaService.js';

@Injectable()
export class AccountMoveService {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private userEntityService: UserEntityService,
		private idService: IdService,
		private apPersonService: ApPersonService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
		private globalEventService: GlobalEventService,
		private perUserFollowingChart: PerUserFollowingChart,
		private federatedInstanceService: FederatedInstanceService,
		private instanceChart: InstanceChart,
		private relayService: RelayService,
		private queueService: QueueService,
		private systemAccountService: SystemAccountService,
		private roleService: RoleService,
		private antennaService: AntennaService,
	) {
	}

	@bindThis
	public async moveFromLocal(src: MiLocalUser, dst: MiLocalUser | MiRemoteUser): Promise<unknown> {
		const _srcUri = this.userEntityService.getUserUri(src);
		const dstUri = this.userEntityService.getUserUri(dst);

		const update = {} as Partial<MiLocalUser>;
		update.alsoKnownAs = src.alsoKnownAs?.includes(dstUri) ? src.alsoKnownAs : src.alsoKnownAs?.concat([dstUri]) ?? [dstUri];
		update.movedToUri = dstUri;
		update.movedAt = new Date();
		await this.usersRepository.update(src.id, update);
		Object.assign(src, update);

		this.globalEventService.publishInternalEvent('localUserUpdated', src);

		const srcPerson = await this.apRendererService.renderPerson(src);
		const updateAct = this.apRendererService.addContext(this.apRendererService.renderUpdate(srcPerson, src));
		await this.apDeliverManagerService.deliverToFollowers(src, updateAct);
		this.relayService.deliverToRelays(src, updateAct);

		const moveAct = this.apRendererService.addContext(this.apRendererService.renderMove(src, dst));
		await this.apDeliverManagerService.deliverToFollowers(src, moveAct);

		const iObj = await this.userEntityService.pack(src.id, src, { schema: 'MeDetailed', includeSecrets: true });
		this.globalEventService.publishMainStream(src.id, 'meUpdated', iObj);

		const followings = await this.followingsRepository.findBy({
			followerId: src.id,
		});
		this.queueService.createDelayedUnfollowJob(followings.map(following => ({
			from: { id: src.id },
			to: { id: following.followeeId },
		})), process.env.NODE_ENV === 'test' ? 10000 : 1000 * 60 * 60 * 24);

		await this.postMoveProcess(src, dst);

		return iObj;
	}

	@bindThis
	public async postMoveProcess(src: MiUser, dst: MiUser): Promise<void> {
		try {
			await Promise.all([
				this.copyBlocking(src, dst),
				this.copyMutings(src, dst),
				this.copyRoles(src, dst),
				this.updateLists(src, dst),
				this.antennaService.onMoveAccount(src, dst),
			]);
		} catch {
		}

		const proxy = await this.systemAccountService.fetch('proxy');
		const followings = await this.followingsRepository.findBy({
			followeeId: src.id,
			followerHost: IsNull(),
			followerId: Not(proxy.id),
		});
		const followJobs = followings.map(following => ({
			from: { id: following.followerId },
			to: { id: dst.id },
		})) as RelationshipJobData[];

		try {
			await this.adjustFollowingCounts(followJobs.map(job => job.from.id), src);
		} catch {
		}

		this.queueService.createFollowJob(followJobs);
	}

	@bindThis
	public async copyBlocking(src: ThinUser, dst: ThinUser): Promise<void> {
		const srcBlockings = await this.blockingsRepository.findBy({ blockeeId: src.id });
		const dstBlockings = await this.blockingsRepository.findBy({ blockeeId: dst.id });
		const blockerIds = dstBlockings.map(blocking => blocking.blockerId);
		const blockJobs: RelationshipJobData[] = [];
		for (const blocking of srcBlockings) {
			if (blockerIds.includes(blocking.blockerId)) continue;
			blockJobs.push({ from: { id: blocking.blockerId }, to: { id: dst.id } });
		}
		this.queueService.createBlockJob(blockJobs);
	}

	@bindThis
	public async copyMutings(src: ThinUser, dst: ThinUser): Promise<void> {
		const oldMutings = await this.mutingsRepository.findBy([
			{ muteeId: src.id, expiresAt: IsNull() },
			{ muteeId: src.id, expiresAt: MoreThan(new Date()) },
		]);
		if (oldMutings.length === 0) return;

		const existingMutingsMuterUserIds = await this.mutingsRepository.findBy(
			{ muteeId: dst.id, expiresAt: IsNull() },
		).then(mutings => mutings.map(muting => muting.muterId));

		const newMutings: Map<string, { muterId: string; muteeId: string; expiresAt: Date | null; }> = new Map();

		const genId = (): string => {
			let id: string;
			do {
				id = this.idService.gen();
			} while (newMutings.has(id));
			return id;
		};
		for (const muting of oldMutings) {
			if (existingMutingsMuterUserIds.includes(muting.muterId)) continue;
			newMutings.set(genId(), {
				...muting,
				muteeId: dst.id,
			});
		}

		const arrayToInsert = Array.from(newMutings.entries()).map(entry => ({ ...entry[1], id: entry[0] }));
		await this.mutingsRepository.insert(arrayToInsert);
	}

	@bindThis
	public async copyRoles(src: ThinUser, dst: ThinUser): Promise<void> {
		const [oldRoleAssignments, roles] = await Promise.all([
			this.roleService.getUserAssigns(src.id),
			this.roleService.getRoles(),
		]);

		if (oldRoleAssignments.length === 0) return;

		for (const oldRoleAssignment of oldRoleAssignments) {
			const role = roles.find(x => x.id === oldRoleAssignment.roleId);
			if (role == null) continue;
			if (!role.preserveAssignmentOnMoveAccount) continue;

			try {
				await this.roleService.assign(dst.id, role.id, oldRoleAssignment.expiresAt);
			} catch (e) {
				if (e instanceof RoleService.AlreadyAssignedError) continue;
				throw e;
			}
		}
	}

	@bindThis
	public async updateLists(src: ThinUser, dst: MiUser): Promise<void> {
		const oldMemberships = await this.userListMembershipsRepository.find({
			where: {
				userId: src.id,
			},
		});
		if (oldMemberships.length === 0) return;

		const existingUserListIds = await this.userListMembershipsRepository.find({
			where: {
				userId: dst.id,
			},
		}).then(memberships => memberships.map(membership => membership.userListId));

		const newMemberships: Map<string, { userId: string; userListId: string; userListUserId: string; }> = new Map();

		const genId = (): string => {
			let id: string;
			do {
				id = this.idService.gen();
			} while (newMemberships.has(id));
			return id;
		};
		for (const membership of oldMemberships) {
			if (existingUserListIds.includes(membership.userListId)) continue;
			newMemberships.set(genId(), {
				userId: dst.id,
				userListId: membership.userListId,
				userListUserId: membership.userListUserId,
			});
		}

		const arrayToInsert = Array.from(newMemberships.entries()).map(entry => ({ ...entry[1], id: entry[0] }));
		await this.userListMembershipsRepository.insert(arrayToInsert);

		if (this.userEntityService.isRemoteUser(dst)) {
			const proxy = await this.systemAccountService.fetch('proxy');
			this.queueService.createFollowJob([{ from: { id: proxy.id }, to: { id: dst.id } }]);
		}
	}

	@bindThis
	private async adjustFollowingCounts(localFollowerIds: string[], oldAccount: MiUser): Promise<void> {
		if (localFollowerIds.length === 0) return;

		await this.usersRepository.update({ id: oldAccount.id }, { followersCount: 0, followingCount: 0 });

		await this.usersRepository.decrement({ id: In(localFollowerIds) }, 'followingCount', 1);

		const oldFollowings = await this.followingsRepository.findBy({ followerId: oldAccount.id });
		if (oldFollowings.length > 0) {
			await this.usersRepository.decrement({ id: In(oldFollowings.map(following => following.followeeId)) }, 'followersCount', 1);
		}

		if (this.meta.enableStatsForFederatedInstances) {
			if (this.userEntityService.isRemoteUser(oldAccount)) {
				this.federatedInstanceService.fetchOrRegister(oldAccount.host).then(async i => {
					this.instancesRepository.decrement({ id: i.id }, 'followersCount', localFollowerIds.length);
					if (this.meta.enableChartsForFederatedInstances) {
						this.instanceChart.updateFollowers(i.host, false);
					}
				});
			}
		}

		for (const followerId of localFollowerIds) {
			this.perUserFollowingChart.update({ id: followerId, host: null }, oldAccount, false);
		}
	}

	@bindThis
	public async validateAlsoKnownAs(
		dst: MiLocalUser | MiRemoteUser,
		check: (oldUser: MiLocalUser | MiRemoteUser | null, newUser: MiLocalUser | MiRemoteUser) => boolean | Promise<boolean> = () => true,
		instant = false,
	): Promise<MiLocalUser | MiRemoteUser | null> {
		let resultUser: MiLocalUser | MiRemoteUser | null = null;

		if (this.userEntityService.isRemoteUser(dst)) {
			if (Date.now() - (dst.lastFetchedAt?.getTime() ?? 0) > 10 * 1000) {
				await this.apPersonService.updatePerson(dst.uri);
			}
			dst = await this.apPersonService.fetchPerson(dst.uri) ?? dst;
		}

		if (!dst.alsoKnownAs || dst.alsoKnownAs.length === 0) return null;

		const dstUri = this.userEntityService.getUserUri(dst);

		for (const srcUri of dst.alsoKnownAs) {
			try {
				let src = await this.apPersonService.fetchPerson(srcUri);
				if (!src) continue;

				if (this.userEntityService.isRemoteUser(dst)) {
					if (Date.now() - (src.lastFetchedAt?.getTime() ?? 0) > 10 * 1000) {
						await this.apPersonService.updatePerson(srcUri);
					}

					src = await this.apPersonService.fetchPerson(srcUri) ?? src;
				}

				if (src.movedToUri === dstUri) {
					if (await check(resultUser, src)) {
						resultUser = src;
					}
					if (instant && resultUser) return resultUser;
				}
			} catch {
			}
		}

		return resultUser;
	}
}
