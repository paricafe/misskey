/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { AuthenticateService, AuthenticationError } from './AuthenticateService.js';

function setup() {
	const users = { findOneBy: vi.fn().mockResolvedValue({ id: 'alice', isSuspended: true }) };
	const tokens = { findOne: vi.fn().mockResolvedValue({ id: 'token', userId: 'alice', permission: ['read:account'] }), update: vi.fn().mockResolvedValue(undefined) };
	const apps = { findOneByOrFail: vi.fn().mockResolvedValue({ permission: ['read:account'] }) };
	const cache = {
		localUserByNativeTokenCache: { fetch: vi.fn().mockResolvedValue({ id: 'alice', isSuspended: false }) },
		localUserByIdCache: { fetch: vi.fn().mockResolvedValue({ id: 'alice', isSuspended: false }) },
	};
	const service = new AuthenticateService(users as never, tokens as never, apps as never, cache as never);
	return { service, users, tokens, apps, cache };
}

describe('fresh streaming authentication', () => {
	test('bypasses a stale native credential cache after token rotation', async () => {
		const { service, users, cache } = setup();
		try {
			users.findOneBy.mockResolvedValue(null);
			await expect(service.authenticate('a'.repeat(16), { fresh: true })).rejects.toThrow('user not found');
			expect(cache.localUserByNativeTokenCache.fetch).not.toHaveBeenCalled();
		} finally {
			service.dispose();
		}
	});

	test('reads current user state without updating token activity on every refresh', async () => {
		const { service, tokens, cache } = setup();
		try {
			const [user] = await service.authenticate('application-token', { fresh: true, updateLastUsedAt: false });
			expect(user?.isSuspended).toBe(true);
			expect(cache.localUserByIdCache.fetch).not.toHaveBeenCalled();
			expect(tokens.update).not.toHaveBeenCalled();
		} finally {
			service.dispose();
		}
	});

	test('refreshes legacy app permissions instead of retaining cached scopes', async () => {
		const { service, tokens, apps } = setup();
		try {
			tokens.findOne.mockResolvedValue({ id: 'token', userId: 'alice', appId: 'app', permission: [] });
			await service.authenticate('application-token');
			apps.findOneByOrFail.mockResolvedValue({ permission: [] });
			const [, token] = await service.authenticate('application-token', { fresh: true, updateLastUsedAt: false });
			expect(token?.permission).toEqual([]);
			expect(apps.findOneByOrFail).toHaveBeenCalledTimes(2);
		} finally {
			service.dispose();
		}
	});
});

describe('AuthenticateService lastUsedAt throttling', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function createService() {
		const tokenRecord = {
			id: 'tok-1',
			userId: 'u1',
			token: 'secret-token',
			hash: 'secret-token',
			appId: null,
			lastUsedAt: null as Date | null,
		};
		const accessTokensRepository = {
			findOne: vi.fn().mockResolvedValue(tokenRecord),
			update: vi.fn().mockResolvedValue(undefined),
		};
		const usersRepository = {
			findOneBy: vi.fn().mockResolvedValue({ id: 'u1', host: null }),
		};
		const appsRepository = {
			findOneByOrFail: vi.fn(),
		};
		const cacheService = {
			localUserByNativeTokenCache: { fetch: vi.fn() },
			localUserByIdCache: {
				fetch: vi.fn(async (_id: string, fallback: () => Promise<unknown>) => fallback()),
			},
		};

		const service = new AuthenticateService(
			usersRepository as never,
			accessTokensRepository as never,
			appsRepository as never,
			cacheService as never,
		);

		return { service, tokenRecord, accessTokensRepository };
	}

	test('throttles lastUsedAt updates within 60 seconds and updates again after 60 seconds', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

		const { service, accessTokensRepository } = createService();

		await service.authenticate('secret-token');
		await service.authenticate('secret-token');
		vi.advanceTimersByTime(59_999);
		await service.authenticate('secret-token');

		expect(accessTokensRepository.update).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(1);
		await service.authenticate('secret-token');

		expect(accessTokensRepository.update).toHaveBeenCalledTimes(2);
		service.dispose();
	});

	test('skips lastUsedAt update when updateLastUsedAt is false and enforces immediate revocation', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

		const { service, accessTokensRepository } = createService();

		await service.authenticate('secret-token', { updateLastUsedAt: false });
		expect(accessTokensRepository.update).not.toHaveBeenCalled();

		await service.authenticate('secret-token');
		expect(accessTokensRepository.update).toHaveBeenCalledTimes(1);

		accessTokensRepository.findOne.mockResolvedValueOnce(null);
		await expect(service.authenticate('secret-token')).rejects.toBeInstanceOf(AuthenticationError);
		service.dispose();
	});
});
