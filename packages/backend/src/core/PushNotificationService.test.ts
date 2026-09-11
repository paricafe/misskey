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

	test('delivers native push notifications', async () => {
		vi.mocked(push.sendNotification).mockResolvedValue({} as never);
		service = new PushNotificationService(
			{ url: 'https://misskey.example/', proxy: undefined } as never,
			{ enableServiceWorker: true, swPublicKey: 'public-key', swPrivateKey: 'private-key' } as never,
			{ get: vi.fn().mockResolvedValue(null), set: vi.fn(), del: vi.fn() } as never,
			{ findBy: vi.fn().mockResolvedValue([{
				userId: 'user-id', endpoint: 'https://native-push.example/subscription', auth: 'native-auth', publickey: 'native-public-key', sendReadMessage: false,
			}]) } as never,
		);

		await service.pushNotification('user-id', 'notification', { id: 'notification-id', type: 'mention', note: null } as never);

		expect(push.sendNotification).toHaveBeenCalledOnce();
		expect(vi.mocked(push.sendNotification).mock.calls[0]?.[0].endpoint).toBe('https://native-push.example/subscription');
	});
});
