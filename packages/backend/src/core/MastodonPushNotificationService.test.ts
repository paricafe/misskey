/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import push from 'web-push';
import {
	encryptMastodonPushBearer,
	mastodonPushTitle,
	MastodonPushNotificationService,
	type MastodonPushAlerts,
} from './MastodonPushNotificationService.js';

vi.mock('web-push', () => ({ default: { sendNotification: vi.fn() } }));

const PRIVATE_KEY = 'nCqedreHEKZ54ZtuMX-1ZPkyK1H7e7itEemL_afgvUE';
const PUBLIC_KEY = 'BFoYnP6n4Huwsti9ptCZtqxxQTT5KpSdGfB8loT2pXzzZYNhOJ4lzcAmndO7ad8LFftUdmUXIZ3Zg-5JSZiu4f0';
const alerts = (overrides: Partial<MastodonPushAlerts> = {}): MastodonPushAlerts => ({
	mention: false, quote: false, status: false, reblog: false, follow: false, follow_request: false,
	favourite: false, poll: false, update: false, quoted_update: false, 'admin.sign_up': false, 'admin.report': false,
	...overrides,
});

describe(MastodonPushNotificationService, () => {
	beforeEach(() => vi.mocked(push.sendNotification).mockReset().mockResolvedValue({} as never));

	function createService(mute: unknown = null) {
		const value = {
			endpoint: 'https://push.example/subscription',
			keys: { p256dh: PUBLIC_KEY, auth: 'MLACbMpb8aYGL4nf4aiwCA' },
			standard: true,
			data: { policy: 'all' as const, alerts: alerts({ favourite: true, mention: true, reblog: true }) },
			bearer: encryptMastodonPushBearer('raw-bearer', 'user-id', 'token-id', 'state-id', PRIVATE_KEY),
		};
		const repository = {
			find: vi.fn().mockResolvedValue([{ id: 'state-id', userId: 'user-id', tokenId: 'token-id', value }]),
			findOneBy: vi.fn().mockResolvedValue(mute == null ? null : { value: mute }),
			delete: vi.fn(),
		};
		const followings = { existsBy: vi.fn() };
		const profileFetch = vi.fn().mockResolvedValue({ lang: 'en' });
		const service = new MastodonPushNotificationService(
			{ enableMastodonApi: true, url: 'https://misskey.example/', host: 'misskey.example' } as never,
			{ enableServiceWorker: true, swPublicKey: PUBLIC_KEY, swPrivateKey: PRIVATE_KEY } as never,
			repository as never, followings as never,
			{ userProfileCache: { fetch: profileFetch } } as never,
			{ getAgentForHttps: vi.fn().mockReturnValue({}) } as never,
		);
		const notification = {
			id: 'notification-id', type: 'reaction', reaction: '❤️',
			user: { id: 'actor-id', username: 'alice', name: 'Alice' },
			note: { id: 'note-id', cw: 'Post content', text: 'Post content' },
		};
		return { service, repository, followings, profileFetch, notification };
	}

	test('provides the queue-only Mastodon push delivery entry point', () => {
		expect(MastodonPushNotificationService.prototype.pushNotification).toBeTypeOf('function');
	});

	test('does not query subscriptions or send when the Mastodon API is disabled', async () => {
		const repository = { find: vi.fn(), findOneBy: vi.fn(), delete: vi.fn() };
		const followings = { existsBy: vi.fn() };
		const profileFetch = vi.fn();
		const getAgentForHttps = vi.fn();
		const service = new MastodonPushNotificationService(
			{ enableMastodonApi: false, url: 'https://misskey.example/', host: 'misskey.example' } as never,
			{ enableServiceWorker: true, swPublicKey: PUBLIC_KEY, swPrivateKey: PRIVATE_KEY } as never,
			repository as never,
			followings as never,
			{ userProfileCache: { fetch: profileFetch } } as never,
			{ getAgentForHttps } as never,
		);

		await service.pushNotification('user-id', {
			id: 'notification-id', type: 'mention',
			user: { id: 'actor-id', username: 'alice' }, note: { id: 'note-id', cw: 'Post content' },
		} as never);

		expect(repository.find).not.toHaveBeenCalled();
		expect(repository.findOneBy).not.toHaveBeenCalled();
		expect(repository.delete).not.toHaveBeenCalled();
		expect(followings.existsBy).not.toHaveBeenCalled();
		expect(profileFetch).not.toHaveBeenCalled();
		expect(getAgentForHttps).not.toHaveBeenCalled();
		expect(push.sendNotification).not.toHaveBeenCalled();
	});

	test.each(['❤', '❤️'])('sends the canonical heart reaction %s as a favourite', async reaction => {
		const { service, notification } = createService();
		await service.pushNotification('user-id', { ...notification, reaction } as never);
		expect(push.sendNotification).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(vi.mocked(push.sendNotification).mock.calls[0]![1]!.toString());
		expect(payload).toMatchObject({ notification_type: 'favourite', title: 'Alice favorited your post' });
	});

	test.each(['👍', '❤︎', ':heart:', ':heart@local:', undefined])('does not turn the native reaction %s into a favourite or perform extra queries', async reaction => {
		const { service, repository, profileFetch, notification } = createService();
		await service.pushNotification('user-id', { ...notification, reaction } as never);
		expect(repository.find).not.toHaveBeenCalled();
		expect(repository.findOneBy).not.toHaveBeenCalled();
		expect(profileFetch).not.toHaveBeenCalled();
		expect(push.sendNotification).not.toHaveBeenCalled();
	});

	test.each([
		{ type: 'reaction', user: undefined },
		{ type: 'reaction', user: { username: 'missing-id' } },
		{ type: 'reaction:grouped', user: undefined, reactions: [{ user: { id: 'actor-id' }, reaction: '❤️' }] },
		{ type: 'reaction:grouped', user: { id: 'actor-id' }, reactions: [{ user: { id: 'actor-id' }, reaction: '❤️' }] },
		{ type: 'renote:grouped', user: undefined, users: [{ id: 'actor-id' }] },
	])('does not invent a single actor for an incomplete or grouped notification: %j', async overrides => {
		const { service, repository, notification } = createService();
		await service.pushNotification('user-id', { ...notification, ...overrides } as never);
		expect(repository.find).not.toHaveBeenCalled();
		expect(repository.findOneBy).not.toHaveBeenCalled();
		expect(push.sendNotification).not.toHaveBeenCalled();
	});

	test.each([
		['permanent notification mute', true, null, false],
		['active notification mute', true, 60_000, false],
		['expired notification mute', true, -1, true],
		['timeline-only mute', false, null, true],
	] as const)('honors the %s without changing the subscription', async (_label, notifications, expiresIn, shouldSend) => {
		const { service, repository, followings, profileFetch, notification } = createService({
			notifications, expiresAt: expiresIn == null ? null : Date.now() + expiresIn,
		});
		await service.pushNotification('user-id', notification as never);

		expect(repository.findOneBy).toHaveBeenCalledExactlyOnceWith({ userId: 'user-id', kind: 'relationship_mute', key: 'actor-id' });
		expect(push.sendNotification).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
		expect(profileFetch).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
		expect(followings.existsBy).not.toHaveBeenCalled();
		expect(repository.delete).not.toHaveBeenCalled();
	});

	test('does not query mute state or profiles without a push subscription', async () => {
		const { service, repository, profileFetch, notification } = createService();
		repository.find.mockResolvedValue([]);
		await service.pushNotification('user-id', notification as never);
		expect(repository.findOneBy).not.toHaveBeenCalled();
		expect(profileFetch).not.toHaveBeenCalled();
		expect(push.sendNotification).not.toHaveBeenCalled();
	});

	test('sends an exact seven-field Mastodon payload with isolated VAPID and SSRF-safe transport options', async () => {
		const value = {
			endpoint: 'https://push.example/subscription',
			keys: { p256dh: PUBLIC_KEY, auth: 'MLACbMpb8aYGL4nf4aiwCA' },
			standard: true,
			data: { policy: 'all' as const, alerts: alerts({ mention: true }) },
			bearer: encryptMastodonPushBearer('raw-bearer', 'user-id', 'token-id', 'state-id', PRIVATE_KEY),
		};
		const repository = { find: vi.fn().mockResolvedValue([{ id: 'state-id', userId: 'user-id', tokenId: 'token-id', value }]), findOneBy: vi.fn().mockResolvedValue(null), delete: vi.fn() };
		const agent = {};
		const service = new MastodonPushNotificationService(
			{ enableMastodonApi: true, url: 'https://misskey.example/', host: 'misskey.example' } as never,
			{ enableServiceWorker: true, swPublicKey: PUBLIC_KEY, swPrivateKey: PRIVATE_KEY, iconUrl: null } as never,
			repository as never,
			{ existsBy: vi.fn() } as never,
			{ userProfileCache: { fetch: vi.fn().mockResolvedValue({ lang: 'zh-CN' }) } } as never,
			{ getAgentForHttps: vi.fn().mockReturnValue(agent) } as never,
		);

		await service.pushNotification('user-id', {
			id: 'notification-id', type: 'mention', createdAt: '2020-01-01T00:00:00.000Z',
			user: { id: 'actor-id', username: 'alice', name: 'Alice', avatarUrl: 'https://cdn.example/alice.png' },
			note: { id: 'note-id', cw: 'Spoiler 👩‍💻 heading', text: 'ignored body' },
		} as never);

		expect(push.sendNotification).toHaveBeenCalledTimes(1);
		expect(repository.find).toHaveBeenCalledWith({ where: { userId: 'user-id', kind: 'push_subscription' }, take: 64 });
		const [subscription, rawPayload, options] = vi.mocked(push.sendNotification).mock.calls[0]!;
		expect(subscription.endpoint).toBe(value.endpoint);
		const payload = JSON.parse(typeof rawPayload === 'string' ? rawPayload : rawPayload!.toString('utf8'));
		expect(Object.keys(payload)).toEqual(['access_token', 'preferred_locale', 'notification_id', 'notification_type', 'icon', 'title', 'body']);
		expect(payload).toEqual({
			access_token: 'raw-bearer', preferred_locale: 'zh-CN', notification_id: 'notification-id', notification_type: 'mention',
			icon: 'https://cdn.example/alice.png', title: 'You were mentioned by Alice', body: 'Spoiler 👩‍💻 heading',
		});
		expect(options).toMatchObject({ contentEncoding: 'aes128gcm', TTL: 172800, timeout: 10000, agent });
		expect(options?.vapidDetails).toEqual({ subject: 'https://misskey.example/', publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY });
	});

	test.each([
		['mention', 'You were mentioned by Alice'],
		['quote', 'Alice quoted your post'],
		['status', 'Alice just posted'],
		['reblog', 'Alice boosted your post'],
		['favourite', 'Alice favorited your post'],
		['follow', 'Alice is now following you'],
		['follow_request', 'Pending follower: Alice'],
		['poll', 'A poll by Alice has ended'],
	] as const)('uses the exact %s title template', (type, expected) => {
		expect(mastodonPushTitle('Alice', type)).toBe(expected);
	});

	test('reuses one relation lookup across subscriptions and never sends accepted-follow notifications', async () => {
		const makeRow = (id: string) => ({
			id, userId: 'user-id', tokenId: `token-${id}`,
			value: {
				endpoint: `https://push.example/${id}`, keys: { p256dh: PUBLIC_KEY, auth: 'MLACbMpb8aYGL4nf4aiwCA' }, standard: false,
				data: { policy: 'followed', alerts: alerts({ mention: true, quote: true, follow: true }) },
				bearer: encryptMastodonPushBearer('bearer', 'user-id', `token-${id}`, id, PRIVATE_KEY),
			},
		});
		const repository = { find: vi.fn().mockResolvedValue([makeRow('one'), makeRow('two')]), findOneBy: vi.fn().mockResolvedValue(null), delete: vi.fn() };
		const followings = { existsBy: vi.fn().mockResolvedValue(true) };
		const service = new MastodonPushNotificationService(
			{ enableMastodonApi: true, url: 'https://misskey.example/', host: 'misskey.example' } as never,
			{ enableServiceWorker: true, swPublicKey: PUBLIC_KEY, swPrivateKey: PRIVATE_KEY } as never,
			repository as never, followings as never,
			{ userProfileCache: { fetch: vi.fn().mockResolvedValue({ lang: null }) } } as never,
			{ getAgentForHttps: vi.fn().mockReturnValue({}) } as never,
		);

		const notification = { id: 'n1', type: 'mention', createdAt: new Date().toISOString(), user: { id: 'actor', username: 'actor' }, note: null };
		await service.pushNotification('user-id', notification as never);
		expect(followings.existsBy).toHaveBeenCalledTimes(1);
		expect(push.sendNotification).toHaveBeenCalledTimes(2);
		for (const call of vi.mocked(push.sendNotification).mock.calls) expect(call[2]?.contentEncoding).toBe('aesgcm');

		vi.mocked(push.sendNotification).mockClear();
		await service.pushNotification('user-id', { ...notification, id: 'quote-notification-id', type: 'quote' } as never);
		const quotePayload = JSON.parse(vi.mocked(push.sendNotification).mock.calls[0]![1]!.toString());
		expect(quotePayload).toMatchObject({ notification_id: 'quote-notification-id', notification_type: 'quote' });

		vi.mocked(push.sendNotification).mockClear();
		await service.pushNotification('user-id', { ...notification, type: 'followRequestAccepted' } as never);
		expect(push.sendNotification).not.toHaveBeenCalled();
	});

	test.each([
		[400, true], [404, true], [410, true], [408, false], [429, false], [500, false],
	] as const)('cleans up only permanent endpoint failure %s', async (statusCode, shouldDelete) => {
		const id = `state-${statusCode}`;
		const tokenId = `token-${statusCode}`;
		const value = {
			endpoint: `https://push.example/${statusCode}`, keys: { p256dh: PUBLIC_KEY, auth: 'MLACbMpb8aYGL4nf4aiwCA' }, standard: false,
			data: { policy: 'all' as const, alerts: alerts({ mention: true }) },
			bearer: encryptMastodonPushBearer('bearer', 'user-id', tokenId, id, PRIVATE_KEY),
		};
		const repository = { find: vi.fn().mockResolvedValue([{ id, userId: 'user-id', tokenId, value }]), findOneBy: vi.fn().mockResolvedValue(null), delete: vi.fn() };
		vi.mocked(push.sendNotification).mockRejectedValueOnce({ statusCode });
		const service = new MastodonPushNotificationService(
			{ enableMastodonApi: true, url: 'https://misskey.example/', host: 'misskey.example' } as never,
			{ enableServiceWorker: true, swPublicKey: PUBLIC_KEY, swPrivateKey: PRIVATE_KEY } as never,
			repository as never, { existsBy: vi.fn() } as never,
			{ userProfileCache: { fetch: vi.fn().mockResolvedValue({ lang: 'en' }) } } as never,
			{ getAgentForHttps: vi.fn().mockReturnValue({}) } as never,
		);
		await service.pushNotification('user-id', { id: 'n1', type: 'mention', user: { id: 'actor', username: 'actor' }, note: null } as never);
		expect(repository.delete).toHaveBeenCalledTimes(shouldDelete ? 1 : 0);
	});

	test('deletes tampered ciphertext without attempting delivery', async () => {
		const bearer = encryptMastodonPushBearer('bearer', 'user-id', 'token-id', 'state-id', PRIVATE_KEY);
		bearer.tag = 'AAAAAAAAAAAAAAAAAAAAAA';
		const value = {
			endpoint: 'https://push.example/tampered', keys: { p256dh: PUBLIC_KEY, auth: 'MLACbMpb8aYGL4nf4aiwCA' }, standard: true,
			data: { policy: 'all' as const, alerts: alerts({ mention: true }) }, bearer,
		};
		const repository = { find: vi.fn().mockResolvedValue([{ id: 'state-id', userId: 'user-id', tokenId: 'token-id', value }]), findOneBy: vi.fn().mockResolvedValue(null), delete: vi.fn() };
		const service = new MastodonPushNotificationService(
			{ enableMastodonApi: true, url: 'https://misskey.example/', host: 'misskey.example' } as never,
			{ enableServiceWorker: true, swPublicKey: PUBLIC_KEY, swPrivateKey: PRIVATE_KEY } as never,
			repository as never, { existsBy: vi.fn() } as never,
			{ userProfileCache: { fetch: vi.fn().mockResolvedValue({ lang: 'en' }) } } as never,
			{ getAgentForHttps: vi.fn().mockReturnValue({}) } as never,
		);
		await service.pushNotification('user-id', { id: 'n1', type: 'mention', user: { id: 'actor', username: 'actor' }, note: null } as never);
		expect(push.sendNotification).not.toHaveBeenCalled();
		expect(repository.delete).toHaveBeenCalledWith({ id: 'state-id' });
	});

	test('limits concurrent sends to eight', async () => {
		const rows = Array.from({ length: 16 }, (_, index) => {
			const id = `state-${index}`;
			const tokenId = `token-${index}`;
			return {
				id, userId: 'user-id', tokenId,
				value: {
					endpoint: `https://push.example/${index}`, keys: { p256dh: PUBLIC_KEY, auth: 'MLACbMpb8aYGL4nf4aiwCA' }, standard: true,
					data: { policy: 'all' as const, alerts: alerts({ mention: true }) },
					bearer: encryptMastodonPushBearer('bearer', 'user-id', tokenId, id, PRIVATE_KEY),
				},
			};
		});
		let active = 0;
		let maximum = 0;
		vi.mocked(push.sendNotification).mockImplementation(async () => {
			active++;
			maximum = Math.max(maximum, active);
			await new Promise(resolve => setTimeout(resolve, 2));
			active--;
			return {} as never;
		});
		const service = new MastodonPushNotificationService(
			{ enableMastodonApi: true, url: 'https://misskey.example/', host: 'misskey.example' } as never,
			{ enableServiceWorker: true, swPublicKey: PUBLIC_KEY, swPrivateKey: PRIVATE_KEY } as never,
			{ find: vi.fn().mockResolvedValue(rows), findOneBy: vi.fn().mockResolvedValue(null), delete: vi.fn() } as never, { existsBy: vi.fn() } as never,
			{ userProfileCache: { fetch: vi.fn().mockResolvedValue({ lang: 'en' }) } } as never,
			{ getAgentForHttps: vi.fn().mockReturnValue({}) } as never,
		);
		await service.pushNotification('user-id', { id: 'n1', type: 'mention', user: { id: 'actor', username: 'actor' }, note: null } as never);
		expect(maximum).toBe(8);
	});
});
