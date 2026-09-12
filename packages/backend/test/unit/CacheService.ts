/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CacheService } from '@/core/CacheService.js';

vi.mock('@/core/entities/UserEntityService.js', () => ({ UserEntityService: class {} }));
vi.mock('@/core/HttpRequestService.js', () => ({ HttpRequestService: class {} }));

describe('blocking cache invalidation across workers', () => {
	const services: CacheService[] = [];

	afterEach(() => {
		for (const service of services.splice(0)) {
			service.pariRemoteUserDecorationsCache.dispose();
			service.dispose();
		}
	});

	test.each(['blockingCreated', 'blockingDeleted'] as const)('%s invalidates both directions in every worker', async (type) => {
		let blocked = type === 'blockingDeleted';
		const values = new Map<string, string>();
		const redis = {
			get: async (key: string) => values.get(key) ?? null,
			set: async (key: string, value: string) => { values.set(key, value); return 'OK'; },
			del: async (key: string) => Number(values.delete(key)),
		};
		const blockings = {
			find: async () => blocked ? [{ blockerId: 'alice', blockeeId: 'bob' }] : [],
		};
		const subscribers = [new EventEmitter(), new EventEmitter()];
		for (const subscriber of subscribers) {
			services.push(new CacheService(redis as never, subscriber as never, {} as never, {} as never, {} as never,
				blockings as never, {} as never, {} as never, {} as never, {} as never, {} as never));
		}
		for (const service of services) {
			expect((await service.userBlockingCache.fetch('alice')).has('bob')).toBe(blocked);
			expect((await service.userBlockedCache.fetch('bob')).has('alice')).toBe(blocked);
		}

		blocked = !blocked;
		await Promise.all([
			services[0].userBlockingCache.refresh('alice'),
			services[0].userBlockedCache.refresh('bob'),
		]);
		// A different worker still has the previous value until the internal event arrives.
		expect((await services[1].userBlockingCache.fetch('alice')).has('bob')).toBe(!blocked);
		const message = JSON.stringify({ channel: 'internal', message: { type, body: { blockerId: 'alice', blockeeId: 'bob' } } });
		await Promise.all(subscribers.flatMap(subscriber => subscriber.listeners('message').map(listener => listener('internal', message))));

		for (const service of services) {
			expect((await service.userBlockingCache.fetch('alice')).has('bob')).toBe(blocked);
			expect((await service.userBlockedCache.fetch('bob')).has('alice')).toBe(blocked);
		}
	});
});
