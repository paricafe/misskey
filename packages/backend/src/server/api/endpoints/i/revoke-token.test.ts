/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
import { digestCredential } from '@/server/api/mastodon/utils.js';
import RevokeTokenEndpoint from './revoke-token.js';

const me = { id: 'user-id' } as MiLocalUser;

function createEndpoint(options: {
	enableMastodonApi?: boolean;
	mastodonDeleteAffected?: number;
	mastodonToken?: { id: string } | null;
} = {}) {
	const accessTokensRepository = {
		exists: vi.fn().mockResolvedValue(true),
		delete: vi.fn().mockResolvedValue(undefined),
	};
	const mastodonTokensRepository = {
		findOneBy: vi.fn().mockResolvedValue(options.mastodonToken === undefined ? { id: 'mastodontokenid' } : options.mastodonToken),
		delete: vi.fn().mockResolvedValue({ affected: options.mastodonDeleteAffected ?? 1 }),
	};
	const redis = { publish: vi.fn().mockResolvedValue(1) };
	const endpoint = new RevokeTokenEndpoint(
		accessTokensRepository as never,
		mastodonTokensRepository as never,
		{ host: 'misskey.test', enableMastodonApi: options.enableMastodonApi ?? true } as never,
		redis as never,
	);

	return { endpoint, accessTokensRepository, mastodonTokensRepository, redis };
}

describe('api:i/revoke-token', () => {
	test('revokes user-owned native and Mastodon tokens by ID', async () => {
		const { endpoint, accessTokensRepository, mastodonTokensRepository, redis } = createEndpoint();

		await endpoint.exec({ tokenId: 'mastodontokenid' }, me, null);

		expect(accessTokensRepository.exists).not.toHaveBeenCalled();
		expect(accessTokensRepository.delete).toHaveBeenCalledWith({
			id: 'mastodontokenid',
			userId: me.id,
		});
		expect(mastodonTokensRepository.delete).toHaveBeenCalledWith({
			id: 'mastodontokenid',
			userId: me.id,
		});
		expect(redis.publish).toHaveBeenCalledWith('misskey.test', JSON.stringify({
			channel: 'mastodonTokenRevoked:mastodontokenid',
			message: null,
		}));
	});

	test('revokes user-owned native and Mastodon tokens by raw token', async () => {
		const { endpoint, accessTokensRepository, mastodonTokensRepository, redis } = createEndpoint();

		await endpoint.exec({ token: 'raw-mastodon-token' }, me, null);

		expect(accessTokensRepository.exists).not.toHaveBeenCalled();
		expect(accessTokensRepository.delete).toHaveBeenCalledWith({
			token: 'raw-mastodon-token',
			userId: me.id,
		});
		expect(mastodonTokensRepository.findOneBy).toHaveBeenCalledWith({
			tokenHash: digestCredential('raw-mastodon-token'),
			userId: me.id,
		});
		expect(mastodonTokensRepository.delete).toHaveBeenCalledWith({
			id: 'mastodontokenid',
			userId: me.id,
		});
		expect(redis.publish).toHaveBeenCalledWith('misskey.test', JSON.stringify({
			channel: 'mastodonTokenRevoked:mastodontokenid',
			message: null,
		}));
	});

	test('requires user ownership so application tokens with a null userId cannot match', async () => {
		const { endpoint, mastodonTokensRepository, redis } = createEndpoint({ mastodonDeleteAffected: 0 });

		await endpoint.exec({ tokenId: 'applicationtokenid' }, me, null);

		expect(mastodonTokensRepository.delete).toHaveBeenCalledWith({
			id: 'applicationtokenid',
			userId: 'user-id',
		});
		expect(mastodonTokensRepository.delete).not.toHaveBeenCalledWith(expect.objectContaining({
			userId: null,
		}));
		expect(redis.publish).not.toHaveBeenCalled();
	});

	test('revokes only native tokens by ID when Mastodon API is disabled', async () => {
		const { endpoint, accessTokensRepository, mastodonTokensRepository, redis } = createEndpoint({ enableMastodonApi: false });

		await endpoint.exec({ tokenId: 'nativetokenid1234' }, me, null);

		expect(accessTokensRepository.delete).toHaveBeenCalledWith({ id: 'nativetokenid1234', userId: me.id });
		expect(mastodonTokensRepository.delete).not.toHaveBeenCalled();
		expect(mastodonTokensRepository.findOneBy).not.toHaveBeenCalled();
		expect(redis.publish).not.toHaveBeenCalled();
	});

	test('revokes only native tokens by value when Mastodon API is disabled', async () => {
		const { endpoint, accessTokensRepository, mastodonTokensRepository, redis } = createEndpoint({ enableMastodonApi: false });

		await endpoint.exec({ token: 'native-token' }, me, null);

		expect(accessTokensRepository.delete).toHaveBeenCalledWith({ token: 'native-token', userId: me.id });
		expect(mastodonTokensRepository.delete).not.toHaveBeenCalled();
		expect(mastodonTokensRepository.findOneBy).not.toHaveBeenCalled();
		expect(redis.publish).not.toHaveBeenCalled();
	});
});
