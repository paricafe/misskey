/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonPushSubscriptionService } from './MastodonPushSubscriptionService.js';

const P256DH = 'BFoYnP6n4Huwsti9ptCZtqxxQTT5KpSdGfB8loT2pXzzZYNhOJ4lzcAmndO7ad8LFftUdmUXIZ3Zg-5JSZiu4f0';
const AUTH = 'MLACbMpb8aYGL4nf4aiwCA';

describe(MastodonPushSubscriptionService, () => {
	function createService(metaOverrides: Record<string, unknown> = {}) {
		let row: Record<string, unknown> | null = null;
		let sequence = 0;
		const stateService = {
			withUserKindLock: vi.fn(async (_userId, _kind, callback) => await callback(stateService)),
			list: vi.fn(async () => row == null ? [] : [row]),
			get: vi.fn(async () => row),
			createWithId: vi.fn(async input => {
				row = { ...input };
				return row;
			}),
			put: vi.fn(async input => {
				row = { id: row?.id ?? 'state-existing', ...input };
				return row;
			}),
			delete: vi.fn(async () => {
				const existed = row != null;
				row = null;
				return existed;
			}),
		};
		const service = new MastodonPushSubscriptionService({
			enableServiceWorker: true,
			swPublicKey: P256DH,
			swPrivateKey: 'nCqedreHEKZ54ZtuMX-1ZPkyK1H7e7itEemL_afgvUE',
			...metaOverrides,
		} as never, stateService as never, { gen: vi.fn(() => `state-${++sequence}`) } as never);
		return { service, stateService, getRow: () => row };
	}

	test('creates one token-owned subscription from nested JSON without storing the bearer in plaintext', async () => {
		const { service, stateService, getRow } = createService();
		const response = await service.create({ user: { id: 'user-id' }, token: { id: 'token-id' } } as never, 'secret-bearer', {
			subscription: {
				endpoint: 'https://push.example/subscription/1',
				keys: { p256dh: P256DH, auth: AUTH },
				standard: true,
			},
			data: { policy: 'all', alerts: { mention: true, reblog: false } },
		});

		expect(response).toEqual({
			id: 'state-1',
			endpoint: 'https://push.example/subscription/1',
			standard: true,
			alerts: {
				mention: true, quote: false, status: false, reblog: false, follow: false, follow_request: false,
				favourite: false, poll: false, update: false, quoted_update: false, 'admin.sign_up': false, 'admin.report': false,
		 },
			server_key: P256DH,
		});
		expect(stateService.createWithId).toHaveBeenCalledWith(expect.objectContaining({
			id: 'state-1',
			userId: 'user-id',
			tokenId: 'token-id',
			kind: 'push_subscription',
			key: 'token-id',
		}));
		expect(JSON.stringify(getRow())).not.toContain('secret-bearer');
		expect(JSON.stringify(getRow())).toContain('ciphertext');
		expect(JSON.stringify(getRow())).toContain('salt');
	});

	test('accepts case-insensitive booleans and the compact t/f form', async () => {
		const { service } = createService();
		const response = await service.create({ user: { id: 'user-id' }, token: { id: 'token-id' } } as never, 'bearer', {
			'subscription[endpoint]': 'https://push.example/booleans',
			'subscription[keys][p256dh]': P256DH,
			'subscription[keys][auth]': AUTH,
			'subscription[standard]': 'T',
			'data[alerts][mention]': 'TrUe',
			'data[alerts][quote]': 'f',
		});
		expect(response).toMatchObject({ standard: true, alerts: { mention: true, quote: false } });
		expect(response).not.toHaveProperty('policy');
	});

	test('returns 422 for unavailable VAPID on every stateful operation and enforces bounded state', async () => {
		const auth = { user: { id: 'user-id' }, token: { id: 'token-id' } } as never;
		const unavailable = createService({ enableServiceWorker: false }).service;
		for (const operation of [
			() => unavailable.create(auth, 'bearer', {}),
			() => unavailable.get(auth),
			() => unavailable.update(auth, {}),
		] as const) await expect(operation()).rejects.toMatchObject({ statusCode: 422 });

		const { service, stateService } = createService();
		stateService.get.mockResolvedValueOnce(null);
		stateService.list.mockResolvedValueOnce(Array.from({ length: 64 }, (_, index) => ({ id: `state-${index}` })));
		await expect(service.create(auth, 'bearer', {
			subscription: { endpoint: 'https://push.example/cap', keys: { p256dh: P256DH, auth: AUTH } },
		})).rejects.toMatchObject({ statusCode: 422 });

		await expect(createService().service.create(auth, 'x'.repeat(5000), {
			subscription: { endpoint: 'https://push.example/large', keys: { p256dh: P256DH, auth: AUTH } },
		})).rejects.toMatchObject({ statusCode: 422 });
		await expect(createService().service.create(auth, 'bearer', {
			subscription: { endpoint: 'https://push.example/auth', keys: { p256dh: P256DH, auth: 'A'.repeat(65) } },
		})).rejects.toMatchObject({ statusCode: 422 });
	});

	test('replaces the same token with a fresh public id and replaces data on PUT', async () => {
		const { service } = createService();
		const auth = { user: { id: 'user-id' }, token: { id: 'token-id' } } as never;
		const subscription = { endpoint: 'https://push.example/1', keys: { p256dh: P256DH, auth: AUTH }, standard: true };
		const first = await service.create(auth, 'bearer', { subscription, data: { policy: 'follower', alerts: { mention: true, quote: true } } });
		const second = await service.create(auth, 'bearer', { subscription });
		expect(first.id).toBe('state-1');
		expect(second.id).toBe('state-2');

		const updated = await service.update(auth, { data: { alerts: { poll: true } } });
		expect(updated).toMatchObject({ id: 'state-2', endpoint: subscription.endpoint, standard: true });
		expect(updated.alerts).toEqual(expect.objectContaining({ mention: false, quote: false, poll: true }));
	});

	test('accepts Mastodon bracket-form fields and strictly rejects unsafe endpoints and malformed keys', async () => {
		const { service } = createService();
		const auth = { user: { id: 'user-id' }, token: { id: 'token-id' } } as never;
		const response = await service.create(auth, 'secret-bearer', {
			'subscription[endpoint]': 'https://push.example/subscription/2',
			'subscription[keys][p256dh]': P256DH,
			'subscription[keys][auth]': AUTH,
			'subscription[standard]': 'false',
			'data[policy]': 'followed',
			'data[alerts][mention]': 'true',
		});
		expect(response).toMatchObject({ endpoint: 'https://push.example/subscription/2', standard: false });

		for (const [endpoint, p256dh, clientAuth] of [
			['http://push.example/sub', P256DH, AUTH],
			['https://127.0.0.1/sub', P256DH, AUTH],
			['https://push.example/sub', 'bad', AUTH],
			['https://push.example/sub', P256DH, 'bad'],
			['https://push.example/sub', `${P256DH}==`, AUTH],
			['https://push.example/sub', P256DH, `${AUTH}=`],
		] as const) {
			await expect(service.create(auth, 'secret-bearer', {
				subscription: { endpoint, keys: { p256dh, auth: clientAuth } },
			})).rejects.toMatchObject({ statusCode: 422 });
		}

		await expect(service.create(auth, 'secret-bearer', {
			subscription: { endpoint: 'https://push.example/nested', keys: { p256dh: P256DH, auth: AUTH } },
			'subscription[endpoint]': 'https://push.example/bracket',
		})).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.create(auth, 'secret-bearer', {
			'subscription[endpoint]': ['https://push.example/1', 'https://push.example/2'],
			'subscription[keys][p256dh]': P256DH,
			'subscription[keys][auth]': AUTH,
		})).rejects.toMatchObject({ statusCode: 422 });
	});
});
