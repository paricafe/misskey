/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { MiUser } from '@/models/User.js';

@Injectable()
export class MastodonStreamingEventService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redisForPub)
		private redisForPub: Redis.Redis,
	) {}

	public filtersChanged(userId: MiUser['id']): void {
		this.publish(userId, 'filters_changed', null);
	}

	public notificationsMerged(userId: MiUser['id']): void {
		this.publish(userId, 'notifications_merged', null);
	}

	public followedTagChanged(
		userId: MiUser['id'],
		body: { action: 'follow' | 'unfollow'; tag: string },
	): void {
		this.publish(userId, 'followed_tag_changed', body);
	}

	private publish(userId: MiUser['id'], type: string, body: unknown): void {
		void this.redisForPub.publish(this.config.host, JSON.stringify({
			channel: `mastodonCompat:${userId}`,
			message: { type, body },
		})).catch(() => {
			// Compatibility invalidations are best-effort and must not fail a committed REST mutation.
		});
	}
}
