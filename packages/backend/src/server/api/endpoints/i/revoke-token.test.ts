/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import RevokeTokenEndpoint from './revoke-token.js';

const me = { id: 'user-id' } as MiLocalUser;

function createEndpoint(options: {
	accessToken?: { id: string } | null;
} = {}) {
	const accessTokensRepository = {
		findOneBy: vi.fn().mockImplementation(async (where: { id?: string }) => options.accessToken === undefined ? { id: where.id ?? 'nativetokenid1234' } : options.accessToken),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	const endpoint = new RevokeTokenEndpoint(
		accessTokensRepository as never,
	);

	return { endpoint, accessTokensRepository };
}

describe('api:i/revoke-token', () => {
	test('rejects anonymous requests', async () => {
		const { endpoint } = createEndpoint();

		await expect(endpoint.exec({ tokenId: 'nativetokenid1234' }, null, null)).rejects.toMatchObject({
			code: 'CREDENTIAL_REQUIRED',
		});
	});

	test('allows an access token to revoke itself', async () => {
		const { endpoint, accessTokensRepository } = createEndpoint({
			accessToken: { id: 'selftokenid1234' },
		});

		await endpoint.exec({ tokenId: 'selftokenid1234' }, me, { id: 'selftokenid1234' } as never);

		expect(accessTokensRepository.delete).toHaveBeenCalledWith({ id: 'selftokenid1234' });
	});

	test('rejects an access token revoking another token', async () => {
		const { endpoint, accessTokensRepository } = createEndpoint({
			accessToken: { id: 'othertokenid1234' },
		});

		await expect(endpoint.exec({ tokenId: 'othertokenid1234' }, me, { id: 'selftokenid1234' } as never)).rejects.toMatchObject({
			code: 'PERMISSION_DENIED',
		});
		expect(accessTokensRepository.delete).not.toHaveBeenCalled();
	});

	test('revokes a user-owned native token by ID', async () => {
		const { endpoint, accessTokensRepository } = createEndpoint();
		await endpoint.exec({ tokenId: 'nativetokenid1234' }, me, null);
		expect(accessTokensRepository.findOneBy).toHaveBeenCalledWith({ id: 'nativetokenid1234', userId: me.id });
		expect(accessTokensRepository.delete).toHaveBeenCalledWith({ id: 'nativetokenid1234' });
	});

	test('revokes a user-owned native token by value', async () => {
		const { endpoint, accessTokensRepository } = createEndpoint();
		await endpoint.exec({ token: 'native-token' }, me, null);
		expect(accessTokensRepository.findOneBy).toHaveBeenCalledWith({ token: 'native-token', userId: me.id });
		expect(accessTokensRepository.delete).toHaveBeenCalledWith({ id: 'nativetokenid1234' });
	});

	test('does not delete tokens that are not owned by the user', async () => {
		const { endpoint, accessTokensRepository } = createEndpoint({ accessToken: null });
		await endpoint.exec({ tokenId: 'othertokenid1234' }, me, null);
		expect(accessTokensRepository.findOneBy).toHaveBeenCalledWith({ id: 'othertokenid1234', userId: me.id });
		expect(accessTokensRepository.delete).not.toHaveBeenCalled();
	});
});
