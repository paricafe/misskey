/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonNotificationService } from './MastodonNotificationService.js';

describe(MastodonNotificationService, () => {
	function createService() {
		const redis = {
			zadd: vi.fn().mockResolvedValue(1),
			zremrangebyscore: vi.fn().mockResolvedValue(0),
			zremrangebyrank: vi.fn().mockResolvedValue(0),
			expire: vi.fn().mockResolvedValue(1),
			zscore: vi.fn().mockResolvedValue(null),
		};
		return { redis, service: new MastodonNotificationService(redis as never) };
	}

	test('maps Mastodon notification filters to Misskey types', () => {
		const { service } = createService();

		expect(service.toMisskeyTypes(['mention', 'favourite', 'reblog', 'follow_request'])).toEqual([
			'mention',
			'reply',
			'quote',
			'reaction',
			'reaction:grouped',
			'renote',
			'renote:grouped',
			'receiveFollowRequest',
		]);
		expect(service.toMisskeyTypes(['status'])).toEqual(['note']);
	});

	test('stores a bounded expiring user-scoped dismissal', async () => {
		const { redis, service } = createService();

		await service.dismiss('user-id', 'notification-id');

		expect(redis.zadd).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			expect.any(Number),
			'notification-id',
		);
		expect(redis.zremrangebyscore).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			0,
			expect.any(Number),
		);
		expect(redis.zremrangebyrank).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			0,
			-1001,
		);
		expect(redis.expire).toHaveBeenCalledWith(
			'mastodon-api:dismissed-notifications:user-id',
			90 * 24 * 60 * 60,
		);
	});

	test('filters only notifications dismissed by the same user', async () => {
		const { redis, service } = createService();
		redis.zscore.mockImplementation(async (key: string, id: string) => key.endsWith(':user-a') && id === 'dismissed' ? '1' : null);

		await expect(service.filterDismissed('user-a', [
			{ id: 'dismissed' },
			{ id: 'visible' },
		])).resolves.toEqual([{ id: 'visible' }]);
		await expect(service.filterDismissed('user-b', [
			{ id: 'dismissed' },
		])).resolves.toEqual([{ id: 'dismissed' }]);
	});
});
