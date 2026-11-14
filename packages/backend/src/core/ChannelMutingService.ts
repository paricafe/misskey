/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Brackets, In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { ChannelMutingRepository, ChannelsRepository, MiChannel, MiChannelMuting, MiUser } from '@/models/_.js';
import { IdService } from '@/core/IdService.js';
import { GlobalEvents, GlobalEventService } from '@/core/GlobalEventService.js';
import { bindThis } from '@/decorators.js';
import { RedisKVCache } from '@/misc/cache.js';

@Injectable()
export class ChannelMutingService {
	public mutingChannelsCache: RedisKVCache<Set<string>>;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,
		@Inject(DI.channelsRepository)
		private channelsRepository: ChannelsRepository,
		@Inject(DI.channelMutingRepository)
		private channelMutingRepository: ChannelMutingRepository,
		private idService: IdService,
		private globalEventService: GlobalEventService,
	) {
		this.mutingChannelsCache = new RedisKVCache<Set<string>>(this.redisClient, 'channelMutingChannels', {
			lifetime: 1000 * 60 * 30,
			memoryCacheLifetime: 1000 * 60,
			fetcher: (userId) => this.channelMutingRepository.find({
				where: { userId: userId },
				select: { channelId: true },
			}).then(xs => new Set(xs.map(x => x.channelId))),
			toRedisConverter: (value) => JSON.stringify(Array.from(value)),
			fromRedisConverter: (value) => new Set(JSON.parse(value)),
		});

		this.redisForSub.on('message', this.onMessage);
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
			const q = this.channelMutingRepository.createQueryBuilder('channel_muting')
				.select('channel_muting.channelId')
				.where('channel_muting.userId = :userId', { userId: params.requestUserId })
				.andWhere(new Brackets(qb => {
					qb.where('channel_muting.expiresAt IS NULL')
						.orWhere('channel_muting.expiresAt > :now', { now: new Date() });
				}));

			return q
				.getRawMany<{ channel_muting_channelId: string }>()
				.then(xs => xs.map(x => ({ id: x.channel_muting_channelId } as MiChannel)));
		} else {
			const q = this.channelsRepository.createQueryBuilder('channel')
				.innerJoin('channel_muting', 'channel_muting', 'channel_muting.channelId = channel.id')
				.where('channel_muting.userId = :userId', { userId: params.requestUserId })
				.andWhere(new Brackets(qb => {
					qb.where('channel_muting.expiresAt IS NULL')
						.orWhere('channel_muting.expiresAt > :now', { now: new Date() });
				}));

			if (opts?.joinUser) {
				q.innerJoinAndSelect('channel.user', 'user');
			}

			if (opts?.joinBannerFile) {
				q.leftJoinAndSelect('channel.banner', 'drive_file');
			}

			return q.getMany();
		}
	}

	public async findExpiredMutings(opts?: {
		joinUser?: boolean;
		joinChannel?: boolean;
	}): Promise<MiChannelMuting[]> {
		const now = new Date();
		const q = this.channelMutingRepository.createQueryBuilder('channel_muting')
			.where('channel_muting.expiresAt < :now', { now });

		if (opts?.joinUser) {
			q.innerJoinAndSelect('channel_muting.user', 'user');
		}

		if (opts?.joinChannel) {
			q.leftJoinAndSelect('channel_muting.channel', 'channel');
		}

		return q.getMany();
	}

	@bindThis
	public async isMuted(params: {
		requestUserId: MiUser['id'],
		targetChannelId: MiChannel['id'],
	}): Promise<boolean> {
		const mutedChannels = await this.mutingChannelsCache.get(params.requestUserId);
		return (mutedChannels?.has(params.targetChannelId) ?? false);
	}

	@bindThis
	public async mute(params: {
		requestUserId: MiUser['id'],
		targetChannelId: MiChannel['id'],
		expiresAt?: Date | null,
	}): Promise<void> {
		await this.channelMutingRepository.insert({
			id: this.idService.gen(),
			userId: params.requestUserId,
			channelId: params.targetChannelId,
			expiresAt: params.expiresAt,
		});

		this.globalEventService.publishInternalEvent('muteChannel', {
			userId: params.requestUserId,
			channelId: params.targetChannelId,
		});
	}

	@bindThis
	public async unmute(params: {
		requestUserId: MiUser['id'],
		targetChannelId: MiChannel['id'],
	}): Promise<void> {
		await this.channelMutingRepository.delete({
			userId: params.requestUserId,
			channelId: params.targetChannelId,
		});

		this.globalEventService.publishInternalEvent('unmuteChannel', {
			userId: params.requestUserId,
			channelId: params.targetChannelId,
		});
	}

	@bindThis
	public async eraseExpiredMutings(): Promise<void> {
		const expiredMutings = await this.findExpiredMutings();
		await this.channelMutingRepository.delete({ id: In(expiredMutings.map(x => x.id)) });

		const userIds = [...new Set(expiredMutings.map(x => x.userId))];
		for (const userId of userIds) {
			this.mutingChannelsCache.refresh(userId).then();
		}
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body } = obj.message as GlobalEvents['internal']['payload'];
			switch (type) {
				case 'muteChannel': {
					this.mutingChannelsCache.refresh(body.userId).then();
					break;
				}
				case 'unmuteChannel': {
					this.mutingChannelsCache.delete(body.userId).then();
					break;
				}
			}
		}
	}

	@bindThis
	public dispose(): void {
		this.mutingChannelsCache.dispose();
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
