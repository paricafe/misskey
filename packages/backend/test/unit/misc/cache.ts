/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryKVCache, MemorySingleCache, RedisKVCache, RedisSingleCache } from '@/misc/cache.js';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('misc:RedisKVCache', () => {
	const caches: RedisKVCache<string | null>[] = [];
	const createCache = (fetcher: (key: string) => Promise<string | null>) => {
		const values = new Map<string, string>();
		const redisClient = {
			get: vi.fn(async (key: string) => values.get(key) ?? null),
			set: vi.fn(async (key: string, value: string) => {
				values.set(key, value);
				return 'OK';
			}),
			del: vi.fn(async (key: string) => Number(values.delete(key))),
		};
		const cache = new RedisKVCache<string | null>(redisClient as never, 'test', {
			lifetime: 10000,
			memoryCacheLifetime: 1000,
			fetcher,
			toRedisConverter: value => JSON.stringify(value),
			fromRedisConverter: value => JSON.parse(value),
		});
		caches.push(cache);
		return { cache, redisClient, values };
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		for (const cache of caches.splice(0)) cache.dispose();
		vi.useRealTimers();
	});

	test('deduplicates misses per key while different keys load in parallel', async () => {
		const a = deferred<string>();
		const b = deferred<string>();
		const fetcher = vi.fn((key: string) => key === 'a' ? a.promise : b.promise);
		const { cache, redisClient } = createCache(fetcher);
		const requests = [cache.fetch('a'), cache.fetch('a'), cache.fetch('b')];
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		expect(redisClient.get).toHaveBeenCalledTimes(2);

		b.resolve('B');
		await expect(requests[2]).resolves.toBe('B');
		a.resolve('A');
		await expect(Promise.all(requests)).resolves.toEqual(['A', 'A', 'B']);
		expect(redisClient.set).toHaveBeenCalledTimes(2);
		await expect(cache.fetch('a')).resolves.toBe('A');
		expect(redisClient.get).toHaveBeenCalledTimes(2);
	});

	test('deduplicates Redis reads after memory expiry without refetching or rewriting', async () => {
		const fetcher = vi.fn().mockResolvedValue('fetched');
		const { cache, redisClient } = createCache(fetcher);
		await cache.set('key', 'cached');
		vi.advanceTimersByTime(1001);

		await expect(Promise.all([cache.fetch('key'), cache.fetch('key')])).resolves.toEqual(['cached', 'cached']);
		expect(redisClient.get).toHaveBeenCalledOnce();
		expect(redisClient.set).toHaveBeenCalledOnce();
		expect(fetcher).not.toHaveBeenCalled();
	});

	test('shares a rejected load and allows the next request to retry', async () => {
		const failed = deferred<string>();
		const fetcher = vi.fn().mockReturnValueOnce(failed.promise).mockResolvedValueOnce('retried');
		const { cache } = createCache(fetcher);
		const first = cache.fetch('key');
		const second = cache.fetch('key');
		const results = Promise.allSettled([first, second]);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		failed.reject(new Error('fetch failed'));
		expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
		await expect(cache.fetch('key')).resolves.toBe('retried');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	test('retries after a shared Redis read fails', async () => {
		const read = deferred<string | null>();
		const fetcher = vi.fn().mockResolvedValue('retried');
		const { cache, redisClient } = createCache(fetcher);
		redisClient.get.mockReturnValueOnce(read.promise);
		const results = Promise.allSettled([cache.fetch('key'), cache.fetch('key')]);
		await vi.waitFor(() => expect(redisClient.get).toHaveBeenCalledOnce());
		read.reject(new Error('Redis unavailable'));
		expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
		expect(fetcher).not.toHaveBeenCalled();
		await expect(cache.fetch('key')).resolves.toBe('retried');
		expect(redisClient.get).toHaveBeenCalledTimes(2);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	test('preserves null as a cached value', async () => {
		const fetcher = vi.fn().mockResolvedValue(null);
		const { cache, redisClient } = createCache(fetcher);
		await expect(Promise.all([cache.fetch('key'), cache.fetch('key')])).resolves.toEqual([null, null]);
		await expect(cache.fetch('key')).resolves.toBeNull();
		expect(fetcher).toHaveBeenCalledOnce();
		expect(redisClient.get).toHaveBeenCalledOnce();
	});

	test.each(['set', 'delete', 'refresh'] as const)('%s supersedes a pending source fetch', async (mutation) => {
		const old = deferred<string>();
		const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('new');
		const { cache, redisClient } = createCache(fetcher);
		const pending = cache.fetch('key');
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

		if (mutation === 'set') await cache.set('key', 'new');
		if (mutation === 'delete') await cache.delete('key');
		if (mutation === 'refresh') await cache.refresh('key');
		old.resolve('old');
		await expect(pending).resolves.toBe('old');

		await expect(cache.get('key')).resolves.toBe(mutation === 'delete' ? undefined : 'new');
		expect(redisClient.set.mock.calls.some(([, value]) => value === '"old"')).toBe(false);
		await expect(cache.fetch('key')).resolves.toBe('new');
	});

	test.each(['set', 'delete', 'refresh'] as const)('%s prevents a pending Redis read from repopulating memory', async (mutation) => {
		const read = deferred<string | null>();
		const { cache, redisClient } = createCache(vi.fn().mockResolvedValue('new'));
		redisClient.get.mockReturnValueOnce(read.promise);
		const pending = cache.fetch('key');
		await vi.waitFor(() => expect(redisClient.get).toHaveBeenCalledOnce());

		if (mutation === 'set') await cache.set('key', 'new');
		if (mutation === 'delete') await cache.delete('key');
		if (mutation === 'refresh') await cache.refresh('key');
		read.resolve('"old"');
		await expect(pending).resolves.toBe('old');
		await expect(cache.get('key')).resolves.toBe(mutation === 'delete' ? undefined : 'new');
	});

	test('a superseded load cannot clear the replacement pending fetch', async () => {
		const old = deferred<string>();
		const replacement = deferred<string>();
		const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
		const { cache } = createCache(fetcher);
		const first = cache.fetch('key');
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		await cache.delete('key');
		const second = cache.fetch('key');
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
		old.resolve('old');
		await first;
		const third = cache.fetch('key');
		replacement.resolve('new');
		await expect(Promise.all([second, third])).resolves.toEqual(['new', 'new']);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	test.each(['set', 'delete', 'refresh'] as const)('%s supersedes a pending refresh', async (mutation) => {
		const old = deferred<string>();
		const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce('new');
		const { cache, redisClient } = createCache(fetcher);
		const pending = cache.refresh('key');
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		if (mutation === 'set') await cache.set('key', 'new');
		if (mutation === 'delete') await cache.delete('key');
		if (mutation === 'refresh') await cache.refresh('key');
		old.resolve('old');
		await pending;
		await expect(cache.get('key')).resolves.toBe(mutation === 'delete' ? undefined : 'new');
		expect(redisClient.set.mock.calls.some(([, value]) => value === '"old"')).toBe(false);
	});
});

describe('misc:RedisSingleCache', () => {
	test('deduplicates concurrent cache misses', async () => {
		let resolveFetcher: ((value: string) => void) | undefined;
		const redisClient = {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue('OK'),
		};
		const fetcher = vi.fn(() => new Promise<string>((resolve) => {
			resolveFetcher = resolve;
		}));
		const cache = new RedisSingleCache<string>(redisClient as never, 'test', {
			lifetime: 1000,
			memoryCacheLifetime: 1000,
			fetcher,
			toRedisConverter: value => value,
			fromRedisConverter: value => value,
		});

		const first = cache.fetch();
		const second = cache.fetch();
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		resolveFetcher?.('fetched');

		await expect(Promise.all([first, second])).resolves.toEqual(['fetched', 'fetched']);
		expect(redisClient.get).toHaveBeenCalledOnce();
		expect(redisClient.set).toHaveBeenCalledOnce();
	});

	test('allows retry after a pending fetch rejects', async () => {
		const redisClient = {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue('OK'),
		};
		const fetcher = vi.fn()
			.mockRejectedValueOnce(new Error('fetch failed'))
			.mockResolvedValueOnce('fetched');
		const cache = new RedisSingleCache<string>(redisClient as never, 'test', {
			lifetime: 1000,
			memoryCacheLifetime: 1000,
			fetcher,
			toRedisConverter: value => value,
			fromRedisConverter: value => value,
		});

		await expect(cache.fetch()).rejects.toThrow('fetch failed');
		await expect(cache.fetch()).resolves.toBe('fetched');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe('misc:MemoryKVCache', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('set and get returns the value within lifetime', () => {
		const cache = new MemoryKVCache<string>(1000);
		cache.set('key', 'value');
		expect(cache.get('key')).toBe('value');
		cache.dispose();
	});

	test('get returns undefined after lifetime expires', () => {
		const cache = new MemoryKVCache<string>(1000);
		cache.set('key', 'value');
		vi.advanceTimersByTime(1001);
		expect(cache.get('key')).toBeUndefined();
		cache.dispose();
	});

	test('delete removes the entry', () => {
		const cache = new MemoryKVCache<string>(1000);
		cache.set('key', 'value');
		cache.delete('key');
		expect(cache.get('key')).toBeUndefined();
		cache.dispose();
	});

	test('keeps current behavior when limit is omitted', () => {
		const cache = new MemoryKVCache<number>(1000 * 60);
		cache.set('a', 1);
		cache.set('b', 2);
		cache.set('c', 3);
		expect(cache.get('a')).toBe(1);
		expect(cache.get('b')).toBe(2);
		expect(cache.get('c')).toBe(3);
		cache.dispose();
	});

	test('evicts least recently used entry when limit is reached', () => {
		const cache = new MemoryKVCache<number>(1000 * 60, 2);
		cache.set('a', 1);
		cache.set('b', 2);
		expect(cache.get('a')).toBe(1);
		cache.set('c', 3);
		expect(cache.get('a')).toBe(1);
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('c')).toBe(3);
		cache.dispose();
	});

	describe.each(['fetch', 'fetchMaybe'] as const)('%s concurrency', (method) => {
		test('shares misses per key, including after expiry, while other keys load independently', async () => {
			const cache = new MemoryKVCache<string>(1000);
			cache.set('a', 'expired');
			vi.advanceTimersByTime(1001);
			const a = deferred<string>();
			const b = deferred<string>();
			const loadA = vi.fn(() => a.promise);
			const loadB = vi.fn(() => b.promise);
			const requests = [cache[method]('a', loadA), cache[method]('a', loadA), cache[method]('b', loadB)];
			await vi.waitFor(() => {
				expect(loadA).toHaveBeenCalledOnce();
				expect(loadB).toHaveBeenCalledOnce();
			});
			b.resolve('B');
			await expect(requests[2]).resolves.toBe('B');
			a.resolve('A');
			await expect(Promise.all(requests)).resolves.toEqual(['A', 'A', 'B']);
			expect(cache.get('a')).toBe('A');
			cache.dispose();
		});

		test('shares errors but permits retries', async () => {
			const cache = new MemoryKVCache<string>(1000);
			const failed = deferred<string>();
			const fetcher = vi.fn().mockReturnValueOnce(failed.promise).mockResolvedValueOnce('retried');
			const results = Promise.allSettled([cache[method]('key', fetcher), cache[method]('key', fetcher)]);
			await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
			failed.reject(new Error('fetch failed'));
			expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
			await expect(cache[method]('key', fetcher)).resolves.toBe('retried');
			expect(fetcher).toHaveBeenCalledTimes(2);
			cache.dispose();
		});

		test.each(['set', 'delete'] as const)('%s prevents old loads from restoring stale data', async (mutation) => {
			const cache = new MemoryKVCache<string>(1000);
			const old = deferred<string>();
			const fetcher = vi.fn(() => old.promise);
			const pending = cache[method]('key', fetcher);
			await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
			if (mutation === 'set') cache.set('key', 'new');
			if (mutation === 'delete') cache.delete('key');
			old.resolve('old');
			await expect(pending).resolves.toBe('old');
			expect(cache.get('key')).toBe(mutation === 'delete' ? undefined : 'new');
			cache.dispose();
		});

		test('an invalidated load does not clear a newer pending load', async () => {
			const cache = new MemoryKVCache<string>(1000);
			const old = deferred<string>();
			const replacement = deferred<string>();
			const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
			const first = cache[method]('key', fetcher);
			await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
			cache.delete('key');
			const second = cache[method]('key', fetcher);
			await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
			old.resolve('old');
			await first;
			const third = cache[method]('key', fetcher);
			replacement.resolve('new');
			await expect(Promise.all([second, third])).resolves.toEqual(['new', 'new']);
			expect(fetcher).toHaveBeenCalledTimes(2);
			expect(cache.get('key')).toBe('new');
			cache.dispose();
		});

		test('shares fresh negative results but still validates them on the next cache lookup', async () => {
			const cache = new MemoryKVCache<string | null>(1000);
			cache.set('key', null);
			const missing = deferred<string | null>();
			const fetcher = vi.fn().mockReturnValueOnce(missing.promise).mockResolvedValueOnce('found');
			const validator = (value: string | null) => value !== null;
			const requests = [cache[method]('key', fetcher, validator), cache[method]('key', fetcher, validator)];
			await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
			missing.resolve(null);
			await expect(Promise.all(requests)).resolves.toEqual([null, null]);
			await expect(cache[method]('key', fetcher, validator)).resolves.toBe('found');
			expect(fetcher).toHaveBeenCalledTimes(2);
			cache.dispose();
		});

		test('keeps valid cache hits available while another caller refreshes rejected data', async () => {
			const cache = new MemoryKVCache<string>(1000);
			cache.set('key', 'cached');
			const refresh = deferred<string>();
			const pending = cache[method]('key', () => refresh.promise, () => false);
			const fetcher = vi.fn().mockResolvedValue('unused');
			await expect(cache[method]('key', fetcher, value => value === 'cached')).resolves.toBe('cached');
			expect(fetcher).not.toHaveBeenCalled();
			refresh.resolve('new');
			await expect(pending).resolves.toBe('new');
			cache.dispose();
		});
	});

	test('shares optional misses without caching undefined', async () => {
		const cache = new MemoryKVCache<string>(1000);
		const missing = deferred<string | undefined>();
		const fetcher = vi.fn().mockReturnValueOnce(missing.promise).mockResolvedValueOnce(undefined);
		const requests = [cache.fetchMaybe('key', fetcher), cache.fetchMaybe('key', fetcher)];
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		missing.resolve(undefined);
		await expect(Promise.all(requests)).resolves.toEqual([undefined, undefined]);
		expect([...cache.entries]).toEqual([]);
		await expect(cache.fetchMaybe('key', fetcher)).resolves.toBeUndefined();
		expect(fetcher).toHaveBeenCalledTimes(2);
		cache.dispose();
	});

	test('a required fetch retries instead of returning an optional undefined result', async () => {
		const cache = new MemoryKVCache<string>(1000);
		const missing = deferred<string | undefined>();
		const optional = cache.fetchMaybe('key', () => missing.promise);
		const fetcher = vi.fn().mockResolvedValue('required');
		const required = cache.fetch('key', fetcher);
		missing.resolve(undefined);
		await expect(optional).resolves.toBeUndefined();
		await expect(required).resolves.toBe('required');
		expect(fetcher).toHaveBeenCalledOnce();
		cache.dispose();
	});

	describe('gc()', () => {
		test('removes expired entries', () => {
			const cache = new MemoryKVCache<string>(1000);
			cache.set('a', '1');
			cache.set('b', '2');
			vi.advanceTimersByTime(1001);
			cache.gc();
			expect(cache.get('a')).toBeUndefined();
			expect(cache.get('b')).toBeUndefined();
			cache.dispose();
		});

		test('retains entries that have not yet expired', () => {
			const cache = new MemoryKVCache<string>(2000);
			cache.set('a', '1');
			vi.advanceTimersByTime(1001);
			cache.gc();
			expect(cache.get('a')).toBe('1');
			cache.dispose();
		});

		test('removes only expired entries when mixed with live entries', () => {
			const cache = new MemoryKVCache<string>(2000);
			cache.set('old', 'oldValue');
			vi.advanceTimersByTime(2001);
			cache.set('new', 'newValue');
			cache.gc();
			expect(cache.get('old')).toBeUndefined();
			expect(cache.get('new')).toBe('newValue');
			cache.dispose();
		});

		// Regression test for https://github.com/misskey-dev/misskey/issues/15500
		// Updated keys keep their original insertion position in Map. gc() must not
		// assume that entries are ordered from oldest to youngest, otherwise it can
		// stop early at an updated key and leave later, truly-expired keys alive.
		// The key observable symptom is that gc() fails to *remove* the expired entry
		// from the Map — get() has its own expiry check so it returns undefined either
		// way, but the stale entry keeps consuming memory.
		test('correctly expires old entries after a key is updated (issue #15500)', () => {
			const lifetime = 1000;
			const cache = new MemoryKVCache<string>(lifetime);

			// Insert 'a' and 'b' at t=0
			cache.set('a', 'v1');
			cache.set('b', 'v1');

			// Advance time and update 'a'. It stays at position 0 in the Map, so a
			// gc() implementation that stops at the first fresh entry would leave 'b'
			// in the Map even though get() would hide it as expired.
			vi.advanceTimersByTime(500);
			cache.set('a', 'v2'); // refresh 'a'; 'b' is still at t=0

			// 'b' is now expired, 'a' has 400ms left
			vi.advanceTimersByTime(600); // total 1100ms

			cache.gc();

			// Verify the entry is actually removed from the Map, not just hidden by get().
			// get() always checks expiry itself, so it returns undefined even without gc() —
			// the real bug is memory not being freed.
			const entries = [...cache.entries];
			expect(entries.find(([k]) => k === 'b')).toBeUndefined(); // 'b' must be gone from Map
			expect(entries.find(([k]) => k === 'a')?.[1].value).toBe('v2'); // 'a' still in Map
			cache.dispose();
		});

		test('gc does not break when cache is empty', () => {
			const cache = new MemoryKVCache<string>(1000);
			expect(() => cache.gc()).not.toThrow();
			cache.dispose();
		});
	});

	test('set does not cause active entries iteration to revisit the same key', () => {
		const cache = new MemoryKVCache<{ id: string }>(1000);
		cache.set('key', { id: 'user-1' });

		let iterations = 0;
		for (const [key, { value }] of cache.entries) {
			iterations++;
			if (value.id === 'user-1') {
				cache.set(key, value);
			}

			expect(iterations).toBeLessThan(3);
		}

		expect(iterations).toBe(1);
		cache.dispose();
	});

	describe('fetch()', () => {
		test('calls fetcher on cache miss', async () => {
			const cache = new MemoryKVCache<string>(1000);
			const fetcher = vi.fn().mockResolvedValue('fetched');
			const result = await cache.fetch('key', fetcher);
			expect(fetcher).toHaveBeenCalledOnce();
			expect(result).toBe('fetched');
			cache.dispose();
		});

		test('does not call fetcher on cache hit', async () => {
			const cache = new MemoryKVCache<string>(1000);
			cache.set('key', 'cached');
			const fetcher = vi.fn().mockResolvedValue('fetched');
			const result = await cache.fetch('key', fetcher);
			expect(fetcher).not.toHaveBeenCalled();
			expect(result).toBe('cached');
			cache.dispose();
		});

		test('respects validator and bypasses cache when validator returns false', async () => {
			const cache = new MemoryKVCache<string>(1000);
			cache.set('key', 'cached');
			const fetcher = vi.fn().mockResolvedValue('fetched');
			const result = await cache.fetch('key', fetcher, () => false);
			expect(fetcher).toHaveBeenCalledOnce();
			expect(result).toBe('fetched');
			cache.dispose();
		});
	});

	describe('fetchMaybe()', () => {
		test('does not cache undefined returned by fetcher', async () => {
			const cache = new MemoryKVCache<string>(1000);
			const fetcher = vi.fn().mockResolvedValue(undefined);
			const result = await cache.fetchMaybe('key', fetcher);
			expect(result).toBeUndefined();
			// A second call should invoke the fetcher again because undefined was not cached
			await cache.fetchMaybe('key', fetcher);
			expect(fetcher).toHaveBeenCalledTimes(2);
			cache.dispose();
		});
	});
});

describe('misc:MemorySingleCache', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('set and get returns the value within lifetime', () => {
		const cache = new MemorySingleCache<string>(1000);
		cache.set('value');
		expect(cache.get()).toBe('value');
	});

	test('get returns undefined after lifetime expires', () => {
		const cache = new MemorySingleCache<string>(1000);
		cache.set('value');
		vi.advanceTimersByTime(1001);
		expect(cache.get()).toBeUndefined();
	});

	test('delete removes the cached value', () => {
		const cache = new MemorySingleCache<string>(1000);
		cache.set('value');
		cache.delete();
		expect(cache.get()).toBeUndefined();
	});

	describe('fetch()', () => {
		test('calls fetcher on cache miss', async () => {
			const cache = new MemorySingleCache<string>(1000);
			const fetcher = vi.fn().mockResolvedValue('fetched');
			const result = await cache.fetch(fetcher);
			expect(fetcher).toHaveBeenCalledOnce();
			expect(result).toBe('fetched');
		});

		test('does not call fetcher on cache hit', async () => {
			const cache = new MemorySingleCache<string>(1000);
			cache.set('cached');
			const fetcher = vi.fn().mockResolvedValue('fetched');
			const result = await cache.fetch(fetcher);
			expect(fetcher).not.toHaveBeenCalled();
			expect(result).toBe('cached');
		});

		test('respects validator and bypasses cache when validator returns false', async () => {
			const cache = new MemorySingleCache<string>(1000);
			cache.set('cached');
			const fetcher = vi.fn().mockResolvedValue('fetched');
			const result = await cache.fetch(fetcher, () => false);
			expect(fetcher).toHaveBeenCalledOnce();
			expect(result).toBe('fetched');
		});
	});
});
