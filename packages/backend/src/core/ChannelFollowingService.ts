/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { ChannelFollowingsRepository, ChannelsRepository, MiUser } from '@/models/_.js';
import { MiChannel } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEvents, GlobalEventService } from '@/core/GlobalEventService.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser } from '@/models/User.js';
import { RedisKVCache } from '@/misc/cache.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import { trackPromise } from '@/misc/promise-tracker.js';

@Injectable()
export class ChannelFollowingService implements OnModuleDestroy {
	public userFollowingChannelsCache: RedisKVCache<Set<string>>;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,
		@Inject(DI.channelsRepository)
		private channelsRepository: ChannelsRepository,
		@Inject(DI.channelFollowingsRepository)
		private channelFollowingsRepository: ChannelFollowingsRepository,
		private idService: IdService,
		private globalEventService: GlobalEventService,
	) {
		this.userFollowingChannelsCache = new RedisKVCache<Set<string>>(this.redisClient, 'userFollowingChannels', {
			lifetime: 1000 * 60 * 30,
			memoryCacheLifetime: 1000 * 60,
			fetcher: (key) => this.channelFollowingsRepository.find({
				where: { followerId: key },
				select: { followeeId: true },
			}).then(xs => new Set(xs.map(x => x.followeeId))),
			toRedisConverter: (value) => JSON.stringify(Array.from(value)),
			fromRedisConverter: (value) => new Set(JSON.parse(value)),
		});

		this.redisForSub.on('message', this.onMessage);
	}

	onModuleDestroy() {
		this.dispose();
	}

	@bindThis
	public async list(
		params: {
			requestUserId: MiUser['id'],
		},
		opts?: {
			idOnly?: boolean;
			joinUser?: boolean;
			joinBannerFile?: boolean;
		},
	): Promise<MiChannel[]> {
		if (opts?.idOnly) {
			const q = this.channelFollowingsRepository.createQueryBuilder('channel_following')
				.select('channel_following.followeeId')
				.where('channel_following.followerId = :userId', { userId: params.requestUserId });

			return q
				.getRawMany<{ channel_following_followeeId: string }>()
				.then(xs => xs.map(x => ({ id: x.channel_following_followeeId } as MiChannel)));
		} else {
			const q = this.channelsRepository.createQueryBuilder('channel')
				.innerJoin('channel_following', 'channel_following', 'channel_following.followeeId = channel.id')
				.where('channel_following.followerId = :userId', { userId: params.requestUserId });

			if (opts?.joinUser) {
				q.innerJoinAndSelect('channel.user', 'user');
			}

			if (opts?.joinBannerFile) {
				q.leftJoinAndSelect('channel.banner', 'drive_file');
			}

			return q.getMany();
		}
	}

	@bindThis
	public async follow(
		requestUser: MiLocalUser,
		targetChannel: MiChannel,
	): Promise<void> {
		try {
			await this.channelFollowingsRepository.insert({
				id: this.idService.gen(),
				followerId: requestUser.id,
				followeeId: targetChannel.id,
			});
		} catch (e) {
			if (isDuplicateKeyValueError(e)) {
				throw new IdentifiableError('6e335e39-0203-4418-a936-b3f2dc987845', 'already following');
			}
			throw e;
		}

		this.globalEventService.publishInternalEvent('followChannel', {
			userId: requestUser.id,
			channelId: targetChannel.id,
		});
	}

	@bindThis
	public async unfollow(
		requestUser: MiLocalUser,
		targetChannel: MiChannel,
	): Promise<void> {
		await this.channelFollowingsRepository.delete({
			followerId: requestUser.id,
			followeeId: targetChannel.id,
		});

		this.globalEventService.publishInternalEvent('unfollowChannel', {
			userId: requestUser.id,
			channelId: targetChannel.id,
		});
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'followChannel': {
					trackPromise(this.userFollowingChannelsCache.refresh(body.userId));
					break;
				}
				case 'unfollowChannel': {
					trackPromise(this.userFollowingChannelsCache.delete(body.userId));
					break;
				}
			}
		}
	}

	@bindThis
	public dispose(): void {
		this.redisForSub.off('message', this.onMessage);
		this.userFollowingChannelsCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
