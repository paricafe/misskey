/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Redis from 'ioredis';
import { bindThis } from '@/decorators.js';

export class RedisKVCache<T> {
	private readonly lifetime: number;
	private readonly memoryCache: MemoryKVCache<T>;
	private readonly fetcher: (key: string) => Promise<T>;
	private readonly toRedisConverter: (value: T) => string;
	private readonly fromRedisConverter: (value: string) => T | undefined;
	private readonly pendingFetches = new Map<string, Promise<T>>();

	constructor(
		private redisClient: Redis.Redis,
		private name: string,
		opts: {
			lifetime: RedisKVCache<T>['lifetime'];
			memoryCacheLifetime: number;
			fetcher: RedisKVCache<T>['fetcher'];
			toRedisConverter: RedisKVCache<T>['toRedisConverter'];
			fromRedisConverter: RedisKVCache<T>['fromRedisConverter'];
		},
	) {
		this.lifetime = opts.lifetime;
		this.memoryCache = new MemoryKVCache(opts.memoryCacheLifetime);
		this.fetcher = opts.fetcher;
		this.toRedisConverter = opts.toRedisConverter;
		this.fromRedisConverter = opts.fromRedisConverter;
	}

	@bindThis
	public async set(key: string, value: T): Promise<void> {
		this.pendingFetches.delete(key);
		this.memoryCache.set(key, value);
		if (this.lifetime === Infinity) {
			await this.redisClient.set(
				`kvcache:${this.name}:${key}`,
				this.toRedisConverter(value),
			);
		} else {
			await this.redisClient.set(
				`kvcache:${this.name}:${key}`,
				this.toRedisConverter(value),
				'EX', Math.round(this.lifetime / 1000),
			);
		}
	}

	@bindThis
	public async get(key: string): Promise<T | undefined> {
		return this.memoryCache.fetchMaybe(key, async () => {
			const cached = await this.redisClient.get(`kvcache:${this.name}:${key}`);
			return cached == null ? undefined : this.fromRedisConverter(cached);
		});
	}

	@bindThis
	public async delete(key: string): Promise<void> {
		this.pendingFetches.delete(key);
		this.memoryCache.delete(key);
		await this.redisClient.del(`kvcache:${this.name}:${key}`);
	}

	@bindThis
	public async fetch(key: string): Promise<T> {
		const memoryCached = this.memoryCache.get(key);
		if (memoryCached !== undefined) return memoryCached;

		const pendingFetch = this.pendingFetches.get(key);
		if (pendingFetch !== undefined) return pendingFetch;

		return this.fetchAndCache(key);
	}

	@bindThis
	private async fetchAndCache(key: string, refresh = false): Promise<T> {
		const pendingFetch = Promise.resolve().then(async () => {
			if (!refresh) {
				const cachedValue = await this.get(key);
				if (cachedValue !== undefined) return cachedValue;
			}

			const value = await this.fetcher(key);
			if (this.pendingFetches.get(key) === pendingFetch) {
				await this.set(key, value);
			}
			return value;
		});
		this.pendingFetches.set(key, pendingFetch);

		try {
			return await pendingFetch;
		} finally {
			if (this.pendingFetches.get(key) === pendingFetch) {
				this.pendingFetches.delete(key);
			}
		}
	}

	@bindThis
	public async refresh(key: string) {
		this.pendingFetches.delete(key);
		this.memoryCache.delete(key);
		await this.fetchAndCache(key, true);
	}

	@bindThis
	public gc() {
		this.memoryCache.gc();
	}

	@bindThis
	public dispose() {
		this.memoryCache.dispose();
	}
}

export class RedisSingleCache<T> {
	private readonly lifetime: number;
	private readonly memoryCache: MemorySingleCache<T>;
	private readonly fetcher: () => Promise<T>;
	private readonly toRedisConverter: (value: T) => string;
	private readonly fromRedisConverter: (value: string) => T | undefined;
	private pendingFetch: Promise<T> | undefined;

	constructor(
		private redisClient: Redis.Redis,
		private name: string,
		opts: {
			lifetime: number;
			memoryCacheLifetime: number;
			fetcher: RedisSingleCache<T>['fetcher'];
			toRedisConverter: RedisSingleCache<T>['toRedisConverter'];
			fromRedisConverter: RedisSingleCache<T>['fromRedisConverter'];
		},
	) {
		this.lifetime = opts.lifetime;
		this.memoryCache = new MemorySingleCache(opts.memoryCacheLifetime);
		this.fetcher = opts.fetcher;
		this.toRedisConverter = opts.toRedisConverter;
		this.fromRedisConverter = opts.fromRedisConverter;
	}

	@bindThis
	public async set(value: T): Promise<void> {
		this.memoryCache.set(value);
		if (this.lifetime === Infinity) {
			await this.redisClient.set(
				`singlecache:${this.name}`,
				this.toRedisConverter(value),
			);
		} else {
			await this.redisClient.set(
				`singlecache:${this.name}`,
				this.toRedisConverter(value),
				'EX', Math.round(this.lifetime / 1000),
			);
		}
	}

	@bindThis
	public async get(): Promise<T | undefined> {
		const memoryCached = this.memoryCache.get();
		if (memoryCached !== undefined) return memoryCached;

		const cached = await this.redisClient.get(`singlecache:${this.name}`);
		if (cached == null) return undefined;

		const value = this.fromRedisConverter(cached);
		if (value !== undefined) {
			this.memoryCache.set(value);
		}

		return value;
	}

	@bindThis
	public async delete(): Promise<void> {
		this.memoryCache.delete();
		await this.redisClient.del(`singlecache:${this.name}`);
	}

	@bindThis
	public async fetch(): Promise<T> {
		const memoryCached = this.memoryCache.get();
		if (memoryCached !== undefined) {
			return memoryCached;
		}

		if (this.pendingFetch !== undefined) {
			return this.pendingFetch;
		}

		const pendingFetch = (async () => {
			const cachedValue = await this.get();
			if (cachedValue !== undefined) {
				return cachedValue;
			}

			const value = await this.fetcher();
			await this.set(value);
			return value;
		})();
		this.pendingFetch = pendingFetch;

		try {
			return await pendingFetch;
		} finally {
			if (this.pendingFetch === pendingFetch) {
				this.pendingFetch = undefined;
			}
		}
	}

	@bindThis
	public async refresh() {
		const value = await this.fetcher();
		await this.set(value);
	}
}

export class MemoryKVCache<T> {
	private readonly cache = new Map<string, { date: number; value: T; }>();
	private readonly pendingFetches = new Map<string, Promise<T | undefined>>();
	private readonly gcIntervalHandle = setInterval(() => this.gc(), 1000 * 60 * 3);

	constructor(
		private readonly lifetime: number,
		private readonly limit: number = Infinity,
	) {}

	@bindThis
	/**
	 * @deprecated これを直接呼び出すべきではない。InternalEventなどで変更を全てのプロセス/マシンに通知するべき
	 */
	public set(key: string, value: T): void {
		if (this.limit <= 0) {
			throw new Error('Limit must be greater than 0');
		}
		this.pendingFetches.delete(key);

		if (this.limit !== Infinity) {
			this.gc();

			this.cache.delete(key);

			while (this.cache.size >= this.limit) {
				const oldestKey = this.cache.keys().next().value;
				if (oldestKey == null) {
					throw new Error('Cache is empty but size exceeds the limit');
				}
				this.cache.delete(oldestKey);
			}
		}

		this.cache.set(key, {
			date: Date.now(),
			value,
		});
	}

	@bindThis
	public get(key: string): T | undefined {
		const cached = this.cache.get(key);
		if (cached == null) return undefined;
		if ((Date.now() - cached.date) > this.lifetime) {
			this.cache.delete(key);
			return undefined;
		}
		if (this.limit !== Infinity) {
			this.cache.delete(key);
			this.cache.set(key, cached);
		}
		return cached.value;
	}

	@bindThis
	public delete(key: string): void {
		this.pendingFetches.delete(key);
		this.cache.delete(key);
	}

	@bindThis
	public async fetch(key: string, fetcher: () => Promise<T>, validator?: (cachedValue: T) => boolean): Promise<T> {
		const cachedValue = this.get(key);
		if (cachedValue !== undefined) {
			if (validator) {
				if (validator(cachedValue)) {
					return cachedValue;
				}
			} else {
				return cachedValue;
			}
		}

		const pendingFetch = this.pendingFetches.get(key);
		if (pendingFetch !== undefined) {
			const value = await pendingFetch;
			if (value !== undefined) return value;
			return this.fetch(key, fetcher, validator);
		}

		return this.fetchAndCache(key, fetcher);
	}

	@bindThis
	public async fetchMaybe(key: string, fetcher: () => Promise<T | undefined>, validator?: (cachedValue: T) => boolean): Promise<T | undefined> {
		const cachedValue = this.get(key);
		if (cachedValue !== undefined) {
			if (validator) {
				if (validator(cachedValue)) {
					return cachedValue;
				}
			} else {
				return cachedValue;
			}
		}

		const pendingFetch = this.pendingFetches.get(key);
		if (pendingFetch !== undefined) return pendingFetch;

		return this.fetchAndCache(key, fetcher);
	}

	@bindThis
	private async fetchAndCache<V extends T | undefined>(key: string, fetcher: () => Promise<V>): Promise<V> {
		const pendingFetch = Promise.resolve().then(fetcher).then(value => {
			if (value !== undefined && this.pendingFetches.get(key) === pendingFetch) {
				this.set(key, value);
			}
			return value;
		});
		this.pendingFetches.set(key, pendingFetch);

		try {
			return await pendingFetch;
		} finally {
			if (this.pendingFetches.get(key) === pendingFetch) {
				this.pendingFetches.delete(key);
			}
		}
	}

	@bindThis
	public gc(): void {
		const now = Date.now();

		for (const [key, { date }] of this.cache.entries()) {
			const age = now - date;
			if (age >= this.lifetime) this.cache.delete(key);
		}
	}

	@bindThis
	public dispose(): void {
		clearInterval(this.gcIntervalHandle);
	}

	public get entries() {
		return this.cache.entries();
	}
}

export class MemorySingleCache<T> {
	private cachedAt: number | null = null;
	private value: T | undefined;

	constructor(
		private lifetime: number,
	) {}

	@bindThis
	public set(value: T): void {
		this.cachedAt = Date.now();
		this.value = value;
	}

	@bindThis
	public get(): T | undefined {
		if (this.cachedAt == null) return undefined;
		if ((Date.now() - this.cachedAt) > this.lifetime) {
			this.value = undefined;
			this.cachedAt = null;
			return undefined;
		}
		return this.value;
	}

	@bindThis
	public delete() {
		this.value = undefined;
		this.cachedAt = null;
	}

	@bindThis
	public async fetch(fetcher: () => Promise<T>, validator?: (cachedValue: T) => boolean): Promise<T> {
		const cachedValue = this.get();
		if (cachedValue !== undefined) {
			if (validator) {
				if (validator(cachedValue)) {
					return cachedValue;
				}
			} else {
				return cachedValue;
			}
		}

		const value = await fetcher();
		this.set(value);
		return value;
	}

	@bindThis
	public async fetchMaybe(fetcher: () => Promise<T | undefined>, validator?: (cachedValue: T) => boolean): Promise<T | undefined> {
		const cachedValue = this.get();
		if (cachedValue !== undefined) {
			if (validator) {
				if (validator(cachedValue)) {
					return cachedValue;
				}
			} else {
				return cachedValue;
			}
		}

		const value = await fetcher();
		if (value !== undefined) {
			this.set(value);
		}
		return value;
	}
}
