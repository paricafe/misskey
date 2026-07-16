/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MODULE_METADATA } from '@nestjs/common/constants.js';
import type { MiLocalUser } from '@/models/User.js';
import { MastodonScopeService } from '@/server/api/mastodon/MastodonScopeService.js';
import { EndpointsModule } from '@/server/api/EndpointsModule.js';
import AppsEndpoint from './apps.js';

const me = { id: 'user-id' } as MiLocalUser;

function createNativeToken(overrides: Record<string, unknown> = {}) {
	return {
		id: 'native-token-id',
		lastUsedAt: new Date('2026-07-15T02:00:00.000Z'),
		token: 'native-token',
		session: null,
		hash: 'native-token-hash',
		userId: 'user-id',
		user: null,
		appId: null,
		app: null,
		name: 'Native client',
		description: 'Native token description',
		iconUrl: 'https://example.com/icon.png',
		permission: ['read:account'],
		fetched: false,
		...overrides,
	};
}

function createMastodonToken(overrides: Record<string, unknown> = {}) {
	return {
		id: 'mastodon-token-id',
		tokenHash: 'mastodon-token-hash',
		userId: 'user-id',
		user: null,
		clientId: 'mastodon-client-id',
		client: {
			id: 'mastodon-client-id',
			secretHash: 'mastodon-client-secret-hash',
			name: 'Tusky',
			website: 'https://tusky.app/',
			redirectUris: ['tusky://oauth'],
			scopes: ['read:accounts', 'write:statuses'],
			createdAt: new Date('2026-07-14T00:00:00.000Z'),
		},
		scopes: ['read:accounts', 'write:statuses'],
		createdAt: new Date('2026-07-15T00:00:00.000Z'),
		lastUsedAt: new Date('2026-07-15T01:00:00.000Z'),
		...overrides,
	};
}

function createEndpoint(options: {
	enableMastodonApi?: boolean;
	nativeTokens?: ReturnType<typeof createNativeToken>[];
	mastodonTokens?: ReturnType<typeof createMastodonToken>[];
	createdAtByNativeId?: Record<string, string>;
} = {}) {
	const nativeTokens = options.nativeTokens ?? [];
	const mastodonTokens = options.mastodonTokens ?? [];
	const query = {
		where: vi.fn(),
		leftJoinAndSelect: vi.fn(),
		orderBy: vi.fn(),
		getMany: vi.fn().mockResolvedValue(nativeTokens),
	};
	query.where.mockReturnValue(query);
	query.leftJoinAndSelect.mockReturnValue(query);
	query.orderBy.mockReturnValue(query);

	const accessTokensRepository = {
		createQueryBuilder: vi.fn().mockReturnValue(query),
	};
	const mastodonTokensRepository = {
		find: vi.fn().mockResolvedValue(mastodonTokens),
	};
	const idService = {
		parse: vi.fn((id: string) => ({
			date: new Date(options.createdAtByNativeId?.[id] ?? '2026-07-15T00:00:00.000Z'),
		})),
	};
	const endpoint = new AppsEndpoint(
		{ enableMastodonApi: options.enableMastodonApi ?? true } as never,
		accessTokensRepository as never,
		mastodonTokensRepository as never,
		idService as never,
		new MastodonScopeService(),
	);

	return { endpoint, accessTokensRepository, mastodonTokensRepository };
}

describe('api:i/apps', () => {
	test('registers the Mastodon scope mapper in the endpoint-owning module', () => {
		const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, EndpointsModule) as unknown[];

		expect(providers).toContain(MastodonScopeService);
	});

	test('projects user-owned Mastodon tokens into the existing response shape', async () => {
		const { endpoint, mastodonTokensRepository } = createEndpoint({
			mastodonTokens: [createMastodonToken()],
		});

		const result = await endpoint.exec({}, me, null);

		expect(result).toContainEqual({
			id: 'mastodon-token-id',
			name: 'Tusky',
			createdAt: '2026-07-15T00:00:00.000Z',
			lastUsedAt: '2026-07-15T01:00:00.000Z',
			permission: expect.arrayContaining(['read:account', 'write:notes']),
			iconUrl: null,
			description: 'https://tusky.app/',
		});
		expect(mastodonTokensRepository.find).toHaveBeenCalledWith({
			where: { userId: 'user-id' },
			relations: { client: true },
		});
	});

	test('preserves the native token projection', async () => {
		const nativeToken = createNativeToken({
			name: null,
			description: null,
			permission: ['ignored:when-app-is-present'],
			appId: 'native-app-id',
			app: {
				id: 'native-app-id',
				name: 'Native app',
				description: 'Native app description',
				permission: ['read:account', 'write:notes'],
			},
		});
		const { endpoint } = createEndpoint({
			nativeTokens: [nativeToken],
			createdAtByNativeId: { 'native-token-id': '2026-07-14T00:00:00.000Z' },
		});

		await expect(endpoint.exec({}, me, null)).resolves.toContainEqual({
			id: 'native-token-id',
			name: 'Native app',
			createdAt: '2026-07-14T00:00:00.000Z',
			lastUsedAt: '2026-07-15T02:00:00.000Z',
			permission: ['read:account', 'write:notes'],
			iconUrl: 'https://example.com/icon.png',
			description: 'Native app description',
		});
	});

	test('returns only native tokens without reading Mastodon storage when disabled', async () => {
		const nativeToken = createNativeToken();
		const { endpoint, mastodonTokensRepository } = createEndpoint({
			enableMastodonApi: false,
			nativeTokens: [nativeToken],
			mastodonTokens: [createMastodonToken()],
		});

		const result = await endpoint.exec({}, me, null);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(nativeToken.id);
		expect(mastodonTokensRepository.find).not.toHaveBeenCalled();
	});

	test.each([
		{ sort: '+createdAt' as const, expected: ['d', 'c', 'b', 'a'] },
		{ sort: '-createdAt' as const, expected: ['a', 'b', 'c', 'd'] },
		{ sort: '+lastUsedAt' as const, expected: ['b', 'a', 'd', 'c'] },
		{ sort: '-lastUsedAt' as const, expected: ['c', 'd', 'a', 'b'] },
	])('sorts combined tokens for $sort with stable ID ordering', async ({ sort, expected }) => {
		const { endpoint } = createEndpoint({
			nativeTokens: [
				createNativeToken({ id: 'b', lastUsedAt: null }),
				createNativeToken({ id: 'd', lastUsedAt: new Date('2026-07-15T02:00:00.000Z') }),
			],
			mastodonTokens: [
				createMastodonToken({ id: 'a', createdAt: new Date('2026-07-15T00:00:00.000Z'), lastUsedAt: null }),
				createMastodonToken({ id: 'c', createdAt: new Date('2026-07-15T02:00:00.000Z'), lastUsedAt: new Date('2026-07-15T01:00:00.000Z') }),
			],
			createdAtByNativeId: {
				b: '2026-07-15T02:00:00.000Z',
				d: '2026-07-15T03:00:00.000Z',
			},
		});

		const result = await endpoint.exec({ sort }, me, null);

		expect(result.map((item: { id: string }) => item.id)).toEqual(expected);
	});
});
