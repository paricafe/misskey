/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import push from 'web-push';
import { PushNotificationService } from './PushNotificationService.js';

vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));

describe(PushNotificationService, () => {
	let service: PushNotificationService | undefined;

	afterEach(() => {
		service?.dispose();
		vi.clearAllMocks();
	});

	test('isolates Mastodon delivery failure while preserving native push delivery', async () => {
		vi.mocked(push.sendNotification).mockResolvedValue({} as never);
		const mastodonPushNotificationService = { pushNotification: vi.fn().mockRejectedValue(new Error('Mastodon endpoint unavailable')) };
		const redis = { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue('OK'), del: vi.fn() };
		const swSubscriptionsRepository = { findBy: vi.fn().mockResolvedValue([{
			userId: 'user-id', endpoint: 'https://native-push.example/subscription', auth: 'native-auth', publickey: 'native-public-key', sendReadMessage: false,
		}]) };
		service = new PushNotificationService(
			{ enableMastodonApi: true, url: 'https://misskey.example/', proxy: undefined } as never,
			{ enableServiceWorker: true, swPublicKey: 'public-key', swPrivateKey: 'private-key' } as never,
			redis as never,
			swSubscriptionsRepository as never,
			mastodonPushNotificationService as never,
		);
		const notification = { id: 'notification-id', type: 'mention', user: { id: 'actor-id' }, note: null } as never;

		await expect(service.pushNotification('user-id', 'notification', notification)).resolves.toBeUndefined();
		await Promise.resolve();

		expect(mastodonPushNotificationService.pushNotification).toHaveBeenCalledWith('user-id', notification);
		expect(push.sendNotification).toHaveBeenCalledTimes(1);
		expect(vi.mocked(push.sendNotification).mock.calls[0]?.[0]).toMatchObject({ endpoint: 'https://native-push.example/subscription' });
	});

	test('preserves native push without invoking compatibility delivery when disabled', async () => {
		vi.mocked(push.sendNotification).mockResolvedValue({} as never);
		const mastodonPushNotificationService = { pushNotification: vi.fn() };
		service = new PushNotificationService(
			{ enableMastodonApi: false, url: 'https://misskey.example/', proxy: undefined } as never,
			{ enableServiceWorker: true, swPublicKey: 'public-key', swPrivateKey: 'private-key' } as never,
			{ get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() } as never,
			{ findBy: vi.fn().mockResolvedValue([{
				userId: 'user-id', endpoint: 'https://native-push.example/subscription', auth: 'native-auth', publickey: 'native-public-key', sendReadMessage: false,
			}]) } as never,
			mastodonPushNotificationService as never,
		);

		await service.pushNotification('user-id', 'notification', { id: 'notification-id', type: 'mention', note: null } as never);

		expect(mastodonPushNotificationService.pushNotification).not.toHaveBeenCalled();
		expect(push.sendNotification).toHaveBeenCalledOnce();
		expect(vi.mocked(push.sendNotification).mock.calls[0]?.[0].endpoint).toBe('https://native-push.example/subscription');
	});
});
