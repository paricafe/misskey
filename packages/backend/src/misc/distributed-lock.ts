/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Redis from 'ioredis';

const RENEW_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
	return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
	return redis.call('del', KEYS[1])
end
return 0
`;

export class DistributedLockLostError extends Error {
	constructor(name: string, cause?: unknown) {
		super(`Lost distributed lock ${name}`, cause == null ? undefined : { cause });
		this.name = 'DistributedLockLostError';
	}
}

export type DistributedLock = (() => Promise<void>) & {
	assertOwned(): Promise<void>;
};

export async function acquireDistributedLock(
	redis: Redis.Redis,
	name: string,
	timeout: number,
	maxRetries: number,
	retryInterval: number,
): Promise<DistributedLock> {
	const lockKey = `lock:${name}`;
	const identifier = Math.random().toString(36).slice(2);

	let retries = 0;
	while (retries < maxRetries) {
		const result = await redis.set(lockKey, identifier, 'PX', timeout, 'NX');
		if (result === 'OK') {
			let active = true;
			let lostError: DistributedLockLostError | null = null;
			let renewalTimer: ReturnType<typeof setTimeout> | null = null;
			let renewalInFlight: Promise<void> | null = null;
			const renewalInterval = Math.max(1, Math.floor(timeout / 3));

			const renew = async (): Promise<void> => {
				if (lostError != null) throw lostError;
				try {
					const renewed = Number(await redis.eval(
						RENEW_LOCK_SCRIPT,
						1,
						lockKey,
						identifier,
						timeout.toString(),
					));
					if (renewed !== 1) throw new DistributedLockLostError(name);
				} catch (error) {
					lostError = error instanceof DistributedLockLostError
						? error
						: new DistributedLockLostError(name, error);
					throw lostError;
				}
			};

			const scheduleRenewal = (): void => {
				if (!active || lostError != null) return;
				renewalTimer = setTimeout(() => {
					renewalTimer = null;
					renewalInFlight = renew()
						.catch(() => undefined)
						.finally(() => {
							renewalInFlight = null;
							scheduleRenewal();
						});
				}, renewalInterval);
				renewalTimer.unref?.();
			};
			scheduleRenewal();

			const release = async (): Promise<void> => {
				if (!active) return;
				active = false;
				if (renewalTimer != null) {
					clearTimeout(renewalTimer);
					renewalTimer = null;
				}
				await renewalInFlight;
				await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, identifier);
			};

			return Object.assign(release, {
				assertOwned: renew,
			});
		}

		await new Promise(resolve => setTimeout(resolve, retryInterval));
		retries++;
	}

	throw new Error(`Failed to acquire lock ${name}`);
}

export function acquireApObjectLock(
	redis: Redis.Redis,
	uri: string,
): Promise<DistributedLock> {
	return acquireDistributedLock(redis, `ap-object:${uri}`, 30 * 1000, 50, 100);
}

export function acquireChartInsertLock(
	redis: Redis.Redis,
	name: string,
): Promise<DistributedLock> {
	return acquireDistributedLock(redis, `chart-insert:${name}`, 30 * 1000, 50, 500);
}
