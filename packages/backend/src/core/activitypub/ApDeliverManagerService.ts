/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { FollowingsRepository } from '@/models/_.js';
import type { MiLocalUser, MiRemoteUser, MiUser } from '@/models/User.js';
import { QueueService } from '@/core/QueueService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import type { IActivity } from '@/core/activitypub/type.js';
import { ThinUser } from '@/queue/types.js';

interface IRecipe {
	type: string;
}

interface IFollowersRecipe extends IRecipe {
	type: 'Followers';
}

interface IDirectRecipe extends IRecipe {
	type: 'Direct';
	to: MiRemoteUser;
}

const isFollowers = (recipe: IRecipe): recipe is IFollowersRecipe =>
	recipe.type === 'Followers';

const isDirect = (recipe: IRecipe): recipe is IDirectRecipe =>
	recipe.type === 'Direct';

class DeliverManager {
	private actor: ThinUser;
	private activity: IActivity | null;
	private recipes: IRecipe[] = [];

	constructor(
		private userEntityService: UserEntityService,
		private followingsRepository: FollowingsRepository,
		private queueService: QueueService,

		actor: { id: MiUser['id']; host: null; },
		activity: IActivity | null,
	) {
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (actor.host != null) throw new Error('actor.host must be null');

		this.actor = {
			id: actor.id,
		};
		this.activity = activity;
	}

	@bindThis
	public addFollowersRecipe(): void {
		const deliver: IFollowersRecipe = {
			type: 'Followers',
		};

		this.addRecipe(deliver);
	}

	@bindThis
	public addDirectRecipe(to: MiRemoteUser): void {
		const recipe: IDirectRecipe = {
			type: 'Direct',
			to,
		};

		this.addRecipe(recipe);
	}

	@bindThis
	public addRecipe(recipe: IRecipe): void {
		this.recipes.push(recipe);
	}

	@bindThis
	public async execute(): Promise<void> {
		const inboxes = new Map<string, boolean>();

		if (this.recipes.some(r => isFollowers(r))) {
			const inbox = 'COALESCE(following."followerSharedInbox", following."followerInbox")';
			const followers = await this.followingsRepository.createQueryBuilder('following')
				.select(inbox, 'inbox')
				.addSelect('BOOL_OR(following."followerSharedInbox" IS NOT NULL)', 'isSharedInbox')
				.where('following."followeeId" = :followeeId', { followeeId: this.actor.id })
				.andWhere('following."followerHost" IS NOT NULL')
				.groupBy(inbox)
				.getRawMany<{ inbox: string | null; isSharedInbox: boolean }>();

			for (const following of followers) {
				if (following.inbox === null) throw new Error('inbox is null');
				inboxes.set(following.inbox, following.isSharedInbox);
			}
		}

		for (const recipe of this.recipes.filter(isDirect)) {
			if (recipe.to.sharedInbox !== null && inboxes.has(recipe.to.sharedInbox)) continue;

			if (recipe.to.inbox === null) continue;

			inboxes.set(recipe.to.inbox, false);
		}

		await this.queueService.deliverMany(this.actor, this.activity, inboxes);
	}
}

@Injectable()
export class ApDeliverManagerService {
	constructor(
		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private userEntityService: UserEntityService,
		private queueService: QueueService,
	) {
	}

	@bindThis
	public async deliverToFollowers(actor: { id: MiLocalUser['id']; host: null; }, activity: IActivity): Promise<void> {
		const manager = new DeliverManager(
			this.userEntityService,
			this.followingsRepository,
			this.queueService,
			actor,
			activity,
		);
		manager.addFollowersRecipe();
		await manager.execute();
	}

	@bindThis
	public async deliverToUser(actor: { id: MiLocalUser['id']; host: null; }, activity: IActivity, to: MiRemoteUser): Promise<void> {
		const manager = new DeliverManager(
			this.userEntityService,
			this.followingsRepository,
			this.queueService,
			actor,
			activity,
		);
		manager.addDirectRecipe(to);
		await manager.execute();
	}

	@bindThis
	public async deliverToUsers(actor: { id: MiLocalUser['id']; host: null; }, activity: IActivity, targets: MiRemoteUser[]): Promise<void> {
		const manager = new DeliverManager(
			this.userEntityService,
			this.followingsRepository,
			this.queueService,
			actor,
			activity,
		);
		for (const to of targets) manager.addDirectRecipe(to);
		await manager.execute();
	}

	@bindThis
	public createDeliverManager(actor: { id: MiUser['id']; host: null; }, activity: IActivity | null): DeliverManager {
		return new DeliverManager(
			this.userEntityService,
			this.followingsRepository,
			this.queueService,

			actor,
			activity,
		);
	}
}
