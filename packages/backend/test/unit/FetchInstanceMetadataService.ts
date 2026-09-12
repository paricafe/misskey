/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import type { MiInstance } from '@/models/Instance.js';

const instance = { id: 'instance', host: 'example.com' } as MiInstance;
const lockKey = 'lock:fetch-instance-metadata:example.com';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

function createMockRedis() {
	const store = new Map<string, { owner: string; expiresAt: number }>();
	const read = (key: string) => {
		const entry = store.get(key);
		if (entry != null && entry.expiresAt <= Date.now()) {
			store.delete(key);
			return undefined;
		}
		return entry;
	};
	const redis = {
		set: vi.fn(async (key: string, owner: string, _px: string, timeout: number, _nx: string) => {
			if (read(key)) return null;
			store.set(key, { owner, expiresAt: Date.now() + timeout });
			return 'OK';
		}),
		eval: vi.fn(async (script: string, _count: number, key: string, owner: string, timeout?: string) => {
			const entry = read(key);
			if (entry?.owner !== owner) return 0;
			if (script.includes('pexpire')) {
				entry.expiresAt = Date.now() + Number(timeout);
			} else {
				store.delete(key);
			}
			return 1;
		}),
	};
	return { redis, read, store };
}

function setup() {
	const { redis, read, store } = createMockRedis();
	const http = {
		getJson: vi.fn().mockRejectedValue(new Error('No metadata available')),
		getHtml: vi.fn().mockResolvedValue(''),
		send: vi.fn().mockResolvedValue({ ok: false }),
	};
	const federation = {
		fetchOrRegister: vi.fn().mockResolvedValue({ infoUpdatedAt: new Date(0) }),
		update: vi.fn().mockResolvedValue(undefined),
	};
	const logger = { info: vi.fn(), error: vi.fn(), succ: vi.fn() };
	const service = new FetchInstanceMetadataService(
		http as never,
		{ getLogger: () => logger } as never,
		federation as never,
		redis as never,
	);
	return { service, redis, read, store, http, federation, logger };
}

describe('FetchInstanceMetadataService', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	test('updates stale metadata and releases its lock', async () => {
		const { service, federation, http, read } = setup();
		await service.fetchInstanceMetadata(instance);

		expect(federation.fetchOrRegister).toHaveBeenCalledOnce();
		expect(http.getJson).toHaveBeenCalled();
		expect(federation.update).toHaveBeenCalledWith('instance', { infoUpdatedAt: expect.any(Date) });
		expect(read(lockKey)).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	test('releases the lock without fetching fresh metadata', async () => {
		const { service, federation, http, read } = setup();
		federation.fetchOrRegister.mockResolvedValue({ infoUpdatedAt: new Date() });
		await service.fetchInstanceMetadata(instance);

		expect(http.getJson).not.toHaveBeenCalled();
		expect(federation.update).not.toHaveBeenCalled();
		expect(read(lockKey)).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	test('a failed contender neither refreshes nor releases an existing lock', async () => {
		const { service, store, read, federation, redis } = setup();
		store.set(lockKey, { owner: 'existing-owner', expiresAt: Date.now() + 5_000 });
		const before = { ...read(lockKey) };
		const fetching = service.fetchInstanceMetadata(instance);
		await vi.advanceTimersByTimeAsync(1);
		await fetching;

		expect(read(lockKey)).toEqual(before);
		expect(federation.fetchOrRegister).not.toHaveBeenCalled();
		expect(redis.eval).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5_000);
		await service.fetchInstanceMetadata(instance);
		expect(federation.update).toHaveBeenCalledOnce();
	});

	test('forced refresh skips freshness and locking without deleting the current owner', async () => {
		const { service, store, read, federation, redis } = setup();
		store.set(lockKey, { owner: 'existing-owner', expiresAt: Date.now() + 30_000 });
		await service.fetchInstanceMetadata(instance, true);

		expect(federation.fetchOrRegister).not.toHaveBeenCalled();
		expect(federation.update).toHaveBeenCalledOnce();
		expect(read(lockKey)?.owner).toBe('existing-owner');
		expect(redis.set).not.toHaveBeenCalled();
		expect(redis.eval).not.toHaveBeenCalled();
	});

	test('renews a slow refresh and keeps contenders out beyond the original expiry', async () => {
		const { service, federation, read } = setup();
		const gate = deferred();
		federation.fetchOrRegister.mockImplementationOnce(async () => {
			await gate.promise;
			return { infoUpdatedAt: new Date(0) };
		});
		const first = service.fetchInstanceMetadata(instance);
		await vi.advanceTimersByTimeAsync(65_000);
		const owner = read(lockKey)?.owner;
		const second = service.fetchInstanceMetadata(instance);
		await vi.advanceTimersByTimeAsync(1);
		await second;

		expect(owner).toBeTypeOf('string');
		expect(read(lockKey)?.owner).toBe(owner);
		expect(federation.fetchOrRegister).toHaveBeenCalledOnce();
		gate.resolve();
		await first;
		expect(federation.update).toHaveBeenCalledOnce();
		expect(read(lockKey)).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	test('does not persist stale results or delete a replacement owner after losing the lock', async () => {
		const { service, federation, store, read, logger } = setup();
		const gate = deferred();
		federation.fetchOrRegister.mockImplementationOnce(async () => {
			await gate.promise;
			return { infoUpdatedAt: new Date(0) };
		});
		const fetching = service.fetchInstanceMetadata(instance);
		await vi.advanceTimersByTimeAsync(0);
		store.set(lockKey, { owner: 'replacement-owner', expiresAt: Date.now() + 30_000 });
		gate.resolve();
		await fetching;

		expect(federation.update).not.toHaveBeenCalled();
		expect(read(lockKey)?.owner).toBe('replacement-owner');
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Lost distributed lock'));
		expect(vi.getTimerCount()).toBe(0);
	});

	test('reports Redis acquisition errors without starting a metadata request', async () => {
		const { service, redis, federation, logger } = setup();
		redis.set.mockRejectedValueOnce(new Error('Redis unavailable'));
		await service.fetchInstanceMetadata(instance);

		expect(federation.fetchOrRegister).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Redis unavailable'));
	});

	test('rejects persistence after a renewal error and stops the renewal timer', async () => {
		const { service, redis, federation, read, logger } = setup();
		const gate = deferred();
		federation.fetchOrRegister.mockImplementationOnce(async () => {
			await gate.promise;
			return { infoUpdatedAt: new Date(0) };
		});
		const fetching = service.fetchInstanceMetadata(instance);
		redis.eval.mockRejectedValueOnce(new Error('Redis unavailable'));
		await vi.advanceTimersByTimeAsync(10_000);
		gate.resolve();
		await fetching;

		expect(federation.update).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Lost distributed lock'));
		expect(read(lockKey)).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	test('reports an unlock failure without an unhandled rejection or continued renewal', async () => {
		const { service, redis, federation, logger } = setup();
		federation.fetchOrRegister.mockResolvedValue({ infoUpdatedAt: new Date() });
		redis.eval.mockRejectedValueOnce(new Error('Redis unavailable'));
		await service.fetchInstanceMetadata(instance);

		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to release metadata lock'));
		expect(vi.getTimerCount()).toBe(0);
	});
});
