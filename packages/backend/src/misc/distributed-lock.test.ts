/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { acquireDistributedLock } from './distributed-lock.js';

function createRedis() {
	let owner: string | null = null;
	let expiresAt = 0;
	const expireIfNeeded = () => {
		if (owner != null && expiresAt <= Date.now()) {
			owner = null;
			expiresAt = 0;
		}
	};
	const redis = {
		set: vi.fn(async (_key: string, identifier: string, _px: string, timeout: number, _nx: string) => {
			expireIfNeeded();
			if (owner != null) return null;
			owner = identifier;
			expiresAt = Date.now() + timeout;
			return 'OK';
		}),
		eval: vi.fn(async (script: string, _keyCount: number, _key: string, identifier: string, timeout?: string) => {
			expireIfNeeded();
			if (owner !== identifier) return 0;
			if (script.includes('pexpire')) {
				expiresAt = Date.now() + Number(timeout);
				return 1;
			}
			if (script.includes('del')) {
				owner = null;
				expiresAt = 0;
				return 1;
			}
			throw new Error('unexpected script');
		}),
	};

	return {
		redis,
		getOwner: () => {
			expireIfNeeded();
			return owner;
		},
		replaceOwner: (identifier: string) => {
			owner = identifier;
			expiresAt = Date.now() + 30_000;
		},
	};
}

describe(acquireDistributedLock, () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('renews a long-running lock so a second contender never enters concurrently', async () => {
		const { redis, getOwner } = createRedis();
		const lock = await acquireDistributedLock(redis as never, 'long-operation', 30_000, 1, 100);
		const firstOwner = getOwner();

		await vi.advanceTimersByTimeAsync(65_000);

		const contender = acquireDistributedLock(redis as never, 'long-operation', 30_000, 1, 100);
		const contenderExpectation = expect(contender).rejects.toThrow('Failed to acquire lock long-operation');
		await vi.advanceTimersByTimeAsync(100);
		await contenderExpectation;
		expect(getOwner()).toBe(firstOwner);
		expect(redis.eval.mock.calls.filter(([script]) => String(script).includes('pexpire')).length).toBeGreaterThanOrEqual(6);

		await lock();
		expect(getOwner()).toBeNull();
	});

	test('release stops renewal and atomically deletes only the caller token', async () => {
		const { redis, getOwner } = createRedis();
		const lock = await acquireDistributedLock(redis as never, 'release', 30_000, 1, 100);

		await vi.advanceTimersByTimeAsync(10_000);
		await lock();
		const evalCallsAfterRelease = redis.eval.mock.calls.length;

		await vi.advanceTimersByTimeAsync(60_000);

		expect(redis.eval).toHaveBeenCalledWith(
			expect.stringContaining('del'),
			1,
			'lock:release',
			expect.any(String),
		);
		expect(redis.eval).toHaveBeenCalledTimes(evalCallsAfterRelease);
		expect(getOwner()).toBeNull();
	});

	test('does not renew or delete a token that has been replaced by another owner', async () => {
		const { redis, getOwner, replaceOwner } = createRedis();
		const lock = await acquireDistributedLock(redis as never, 'lost', 30_000, 1, 100);
		replaceOwner('new-owner');

		await vi.advanceTimersByTimeAsync(10_000);

		await expect(lock.assertOwned()).rejects.toThrow('Lost distributed lock lost');
		await lock();
		expect(getOwner()).toBe('new-owner');
	});

	test('surfaces a Redis renewal failure through the ownership check', async () => {
		const { redis } = createRedis();
		const lock = await acquireDistributedLock(redis as never, 'renewal-error', 30_000, 1, 100);
		redis.eval.mockRejectedValueOnce(new Error('Redis unavailable'));

		await vi.advanceTimersByTimeAsync(10_000);

		await expect(lock.assertOwned()).rejects.toMatchObject({
			name: 'DistributedLockLostError',
			cause: expect.objectContaining({ message: 'Redis unavailable' }),
		});
		await lock();
	});

	test('fails safely after exhausting all 50 acquisition retries', async () => {
		const redis = {
			set: vi.fn().mockResolvedValue(null),
		};
		const acquisition = acquireDistributedLock(redis as never, 'busy', 30_000, 50, 100);
		const acquisitionExpectation = expect(acquisition).rejects.toThrow('Failed to acquire lock busy');

		await vi.advanceTimersByTimeAsync(5_000);

		await acquisitionExpectation;
		expect(redis.set).toHaveBeenCalledTimes(50);
	});
});
