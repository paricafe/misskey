/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { digestCredential } from './utils.js';
import { MastodonAuthenticateService } from './MastodonAuthenticateService.js';

describe(MastodonAuthenticateService, () => {
	test('looks up only the compatibility token digest', async () => {
		const token = {
			id: 'token-id',
			tokenHash: digestCredential('raw-token'),
			userId: 'user-id',
			clientId: 'client-id',
			scopes: ['read'],
		};
		const user = { id: 'user-id', isDeleted: false, isSuspended: false };
		const findOneBy = vi.fn().mockResolvedValue(token);
		const update = vi.fn().mockResolvedValue(undefined);
		const fetch = vi.fn().mockResolvedValue(user);
		const service = new MastodonAuthenticateService(
			{ findOneBy, update } as never,
			{ findOneBy: vi.fn() } as never,
			{ localUserByIdCache: { fetch } } as never,
		);

		await expect(service.authenticate('raw-token')).resolves.toEqual({ token, user });
		expect(findOneBy).toHaveBeenCalledWith({ tokenHash: digestCredential('raw-token') });
		expect(fetch).toHaveBeenCalledWith('user-id', expect.any(Function));
		expect(update).toHaveBeenCalledWith('token-id', { lastUsedAt: expect.any(Date) });
	});

	test('rejects a missing or unknown token', async () => {
		const service = new MastodonAuthenticateService(
			{ findOneBy: vi.fn().mockResolvedValue(null), update: vi.fn() } as never,
			{ findOneBy: vi.fn() } as never,
			{ localUserByIdCache: { fetch: vi.fn() } } as never,
		);

		await expect(service.authenticate(undefined)).rejects.toMatchObject({ statusCode: 401 });
		await expect(service.authenticate('unknown')).rejects.toMatchObject({ statusCode: 401 });
	});

	test.each([
		{ isDeleted: true, isSuspended: false },
		{ isDeleted: false, isSuspended: true },
	])('rejects unavailable local users', async state => {
		const service = new MastodonAuthenticateService(
			{ findOneBy: vi.fn().mockResolvedValue({ id: 'token-id', userId: 'user-id' }), update: vi.fn() } as never,
			{ findOneBy: vi.fn() } as never,
			{ localUserByIdCache: { fetch: vi.fn().mockResolvedValue({ id: 'user-id', ...state }) } } as never,
		);

		await expect(service.authenticate('raw-token')).rejects.toMatchObject({ statusCode: 401 });
	});
});
