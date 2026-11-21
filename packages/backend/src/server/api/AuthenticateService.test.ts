/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { AuthenticateService } from './AuthenticateService.js';

function setup() {
	const primary = { queryRunner: { getReplicationMode: () => 'master' }, withRepository: (repository: unknown) => repository };
	const users = { manager: primary, findOneBy: vi.fn().mockResolvedValue({ id: 'alice', isSuspended: true }) };
	const tokens = { manager: primary, findOne: vi.fn().mockResolvedValue({ id: 'token', userId: 'alice', permission: ['read:account'] }), update: vi.fn().mockResolvedValue(undefined) };
	const apps = { findOneByOrFail: vi.fn().mockResolvedValue({ permission: ['read:account'] }) };
	const cache = {
		localUserByIdCache: { fetch: vi.fn().mockResolvedValue({ id: 'alice', isSuspended: false }) },
	};
	const service = new AuthenticateService(users as never, tokens as never, apps as never, cache as never);
	return { service, users, tokens, apps, cache };
}

describe('fresh streaming authentication', () => {
	test.each([false, true])('checks the current native credential on the primary (fresh %s)', async fresh => {
		const { service, users } = setup();
		try {
			users.findOneBy.mockResolvedValue(null);
			await expect(service.authenticate('a'.repeat(16), { fresh })).rejects.toThrow('user not found');
			expect(users.findOneBy).toHaveBeenCalledWith({ token: 'a'.repeat(16) });
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
