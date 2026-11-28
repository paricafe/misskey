/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import { MiMeta } from '@/models/Meta.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { bindThis } from '@/decorators.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { subscribeInternalEvent } from '@/misc/redis-pubsub-bus.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import type { OnApplicationShutdown } from '@nestjs/common';

@Injectable()
export class MetaService implements OnApplicationShutdown {
	private cache: MiMeta | undefined;
	private intervalId: NodeJS.Timeout;
	private unsubscribeInternal?: () => void;

	constructor(
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.db)
		private db: DataSource,

		private featuredService: FeaturedService,
		private globalEventService: GlobalEventService,
	) {
		if (process.env.NODE_ENV !== 'test') {
			this.intervalId = setInterval(() => {
				this.fetch(true).then(meta => {
					this.cache = meta;
				});
			}, 1000 * 60 * 5);
		}

		this.unsubscribeInternal = subscribeInternalEvent(this.redisForSub, this.onInternalEvent);
	}

	@bindThis
	private async onInternalEvent(event: GlobalEvents['internal']['payload']): Promise<void> {
		const { type, body } = event;
		switch (type) {
			case 'metaUpdated': {
				this.cache = {
					...(body.after),
					rootUser: null,
				};
				break;
			}
			default:
				break;
		}
	}

	@bindThis
	public async fetch(noCache = false): Promise<MiMeta> {
		if (!noCache && this.cache) return this.cache;

		return await this.db.transaction(async transactionalEntityManager => {
			const metas = await transactionalEntityManager.find(MiMeta, {
				order: {
					id: 'DESC',
				},
			});

			const meta = metas[0];

			if (meta) {
				this.cache = meta;
				return meta;
			} else {
				const saved = await transactionalEntityManager
					.upsert(
						MiMeta,
						{
							id: 'x',
						},
						['id'],
					)
					.then((x) => transactionalEntityManager.findOneByOrFail(MiMeta, x.identifiers[0]));

				this.cache = saved;
				return saved;
			}
		});
	}

	@bindThis
	public async update(data: Partial<MiMeta>): Promise<MiMeta> {
		let before: MiMeta | undefined;

		const updated = await this.db.transaction(async transactionalEntityManager => {
			const metas = await transactionalEntityManager.find(MiMeta, {
				order: {
					id: 'DESC',
				},
			});

			before = metas[0];

			if (before) {
				await transactionalEntityManager.update(MiMeta, before.id, data);
			} else {
				await transactionalEntityManager.save(MiMeta, {
					...data,
					id: 'x',
				});
			}

			const afters = await transactionalEntityManager.find(MiMeta, {
				order: {
					id: 'DESC',
				},
			});

			return afters[0];
		});

		if (data.hiddenTags) {
			process.nextTick(() => {
				const hiddenTags = new Set<string>(data.hiddenTags);
				if (before) {
					for (const previousHiddenTag of before.hiddenTags) {
						hiddenTags.delete(previousHiddenTag);
					}
				}

				for (const hiddenTag of hiddenTags) {
					this.featuredService.removeHashtagsFromRanking(hiddenTag);
				}
			});
		}

		this.globalEventService.publishInternalEvent('metaUpdated', { before, after: updated });

		return updated;
	}

	@bindThis
	public dispose(): void {
		clearInterval(this.intervalId);
		this.unsubscribeInternal?.();
		this.unsubscribeInternal = undefined;
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
