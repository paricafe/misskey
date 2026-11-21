/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import push from 'web-push';
import { PushNotificationService } from './PushNotificationService.js';

test('delivery workers discard a removed subscription even while delivery workers miss credential events', async () => {
	const endpoint = 'https://localhost/push/removed';
	const kept = 'https://localhost/push/kept';
	let endpoints = [endpoint, kept];
	const primary = { withRepository: () => ({ findBy: async () => endpoints.map(url => ({ endpoint: url, sendReadMessage: true })) }) };
	const subscriptions = { manager: { dataSource: { createQueryRunner: () => ({ manager: primary, release: vi.fn() }) } } };
	const send = vi.spyOn(push, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
	const vapid = vi.spyOn(push, 'setVapidDetails').mockImplementation(() => {});
	const workers = Array.from({ length: 2 }, () => new PushNotificationService(
		{ url: 'https://localhost' } as never,
		{ enableServiceWorker: true, swPublicKey: 'key', swPrivateKey: 'key' } as never,
		subscriptions as never, { getAgentForHttps: vi.fn() } as never,
	));
	try {
		for (const worker of workers) await worker.pushNotification('alice', 'readAllNotifications', undefined);
		expect(send.mock.calls.map(([s]) => s.endpoint)).toEqual([endpoint, kept, endpoint, kept]);
		send.mockClear();
		endpoints = [kept];
		for (const worker of workers) await worker.pushNotification('alice', 'readAllNotifications', undefined);
		expect(send.mock.calls.map(([s]) => s.endpoint)).toEqual([kept, kept]);
	} finally {
		send.mockRestore();
		vapid.mockRestore();
	}
});
