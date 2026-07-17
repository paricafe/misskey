/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { digestCredential } from './utils.js';
import { MastodonAuthenticateService } from './MastodonAuthenticateService.js';

describe(MastodonAuthenticateService, () => {
	test('requires both token ownership and an active local user', async () => {
		const tokenExists = vi.fn().mockResolvedValue(true);
		const userExists = vi.fn()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const service = new MastodonAuthenticateService(
			{ exists: tokenExists } as never,
			{ exists: userExists } as never,
			{ localUserByIdCache: { fetch: vi.fn() } } as never,
		);

		await expect(service.isActiveUserToken('token-id', 'user-id')).resolves.toBe(true);
		await expect(service.isActiveUserToken('token-id', 'suspended-user-id')).resolves.toBe(false);
		expect(tokenExists).toHaveBeenNthCalledWith(1, { where: { id: 'token-id', userId: 'user-id' } });
		expect(tokenExists).toHaveBeenNthCalledWith(2, { where: { id: 'token-id', userId: 'suspended-user-id' } });
		expect(userExists).toHaveBeenNthCalledWith(1, { where: expect.objectContaining({
			id: 'user-id',
			isDeleted: false,
			isSuspended: false,
		}) });
		expect(userExists).toHaveBeenNthCalledWith(2, { where: expect.objectContaining({
			id: 'suspended-user-id',
			isDeleted: false,
			isSuspended: false,
		}) });
	});

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

		await expect(service.authenticate('raw-token')).resolves.toEqual({ kind: 'user', token, user });
		expect(findOneBy).toHaveBeenCalledWith({ tokenHash: digestCredential('raw-token') });
		expect(fetch).toHaveBeenCalledWith('user-id', expect.any(Function));
		expect(update).toHaveBeenCalledWith('token-id', { lastUsedAt: expect.any(Date) });
	});

	test('returns an application auth result without loading a user', async () => {
		const token = {
			id: 'app-token-id',
			tokenHash: digestCredential('raw-token'),
			userId: null,
			clientId: 'client-id',
			scopes: ['read'],
		};
		const fetch = vi.fn();
		const service = new MastodonAuthenticateService(
			{ findOneBy: vi.fn().mockResolvedValue(token), update: vi.fn() } as never,
			{ findOneBy: vi.fn() } as never,
			{ localUserByIdCache: { fetch } } as never,
		);

		await expect(service.authenticate('raw-token')).resolves.toEqual({
			kind: 'application',
			token,
			user: null,
		});
		expect(fetch).not.toHaveBeenCalled();
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
