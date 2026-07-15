/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiGroupedNotification } from '@/models/Notification.js';

const DISMISSAL_TTL_SECONDS = 90 * 24 * 60 * 60;
const DISMISSAL_TTL_MILLISECONDS = DISMISSAL_TTL_SECONDS * 1000;

@Injectable()
export class MastodonNotificationService {
	private readonly misskeyTypes: Readonly<Record<string, MiGroupedNotification['type'][]>> = {
		mention: ['mention', 'reply', 'note', 'quote'],
		status: ['note'],
		reblog: ['renote', 'renote:grouped'],
		favourite: ['reaction', 'reaction:grouped'],
		follow: ['follow', 'followRequestAccepted'],
		follow_request: ['receiveFollowRequest'],
		poll: ['pollEnded'],
	};

	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,
	) {}

	public toMisskeyTypes(types: readonly string[]): MiGroupedNotification['type'][] {
		return types.flatMap(type => this.misskeyTypes[type] ?? []);
	}

	public async dismiss(userId: string, notificationId: string): Promise<void> {
		const key = this.key(userId);
		const now = Date.now();
		await this.redis.zadd(key, now, notificationId);
		await this.redis.zremrangebyscore(key, 0, now - DISMISSAL_TTL_MILLISECONDS);
		await this.redis.zremrangebyrank(key, 0, -1001);
		await this.redis.expire(key, DISMISSAL_TTL_SECONDS);
	}

	public async filterDismissed<T extends { id: string }>(userId: string, values: readonly T[]): Promise<T[]> {
		const key = this.key(userId);
		const scores = await Promise.all(values.map(value => this.redis.zscore(key, value.id)));
		return values.filter((_value, index) => scores[index] == null);
	}

	private key(userId: string): string {
		return `mastodon-api:dismissed-notifications:${userId}`;
	}
}
