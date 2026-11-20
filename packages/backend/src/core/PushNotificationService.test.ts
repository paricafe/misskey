/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import push from 'web-push';
import { PushNotificationService } from './PushNotificationService.js';

test('delivery workers discard a removed subscription after token rotation', async () => {
	const endpoint = 'https://localhost/push/removed';
	const kept = 'https://localhost/push/kept';
	let endpoints = [endpoint, kept];
	const subscriptions = { findBy: async () => endpoints.map(url => ({ endpoint: url, sendReadMessage: true })) };
	const values = new Map<string, string>();
	const redis = {
		get: async (key: string) => values.get(key),
		set: async (key: string, value: string) => values.set(key, value),
		del: async (key: string) => values.delete(key),
	};
	const events = new EventEmitter();
	const send = vi.spyOn(push, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
	const vapid = vi.spyOn(push, 'setVapidDetails').mockImplementation(() => {});
	const workers = Array.from({ length: 2 }, () => new PushNotificationService(
		{ url: 'https://localhost' } as never,
		{ enableServiceWorker: true, swPublicKey: 'key', swPrivateKey: 'key' } as never,
		redis as never, events as never, subscriptions as never, { getAgentForHttps: vi.fn() } as never,
	));
	try {
		for (const worker of workers) await worker.pushNotification('alice', 'readAllNotifications', undefined);
		expect(send.mock.calls.map(([s]) => s.endpoint)).toEqual([endpoint, kept, endpoint, kept]);
		send.mockClear();
		endpoints = [kept];
		const event = JSON.stringify({ channel: 'internal', message: { type: 'userTokenRegenerated', body: { id: 'alice' } } });
		await Promise.all(events.listeners('message').map(listener => listener('internal', event)));
		for (const worker of workers) await worker.pushNotification('alice', 'readAllNotifications', undefined);
		expect(send.mock.calls.map(([s]) => s.endpoint)).toEqual([kept, kept]);
	} finally {
		for (const worker of workers) worker.dispose();
		send.mockRestore();
		vapid.mockRestore();
	}
});
