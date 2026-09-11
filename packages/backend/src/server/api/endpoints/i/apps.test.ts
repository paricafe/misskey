/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiLocalUser } from '@/models/User.js';
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

function createEndpoint(options: {
	nativeTokens?: ReturnType<typeof createNativeToken>[];
	createdAtByNativeId?: Record<string, string>;
} = {}) {
	const nativeTokens = options.nativeTokens ?? [];
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
	const idService = {
		parse: vi.fn((id: string) => ({
			date: new Date(options.createdAtByNativeId?.[id] ?? '2026-07-15T00:00:00.000Z'),
		})),
	};
	const endpoint = new AppsEndpoint(
		accessTokensRepository as never,
		idService as never,
	);

	return { endpoint, accessTokensRepository };
}

describe('api:i/apps', () => {
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

	test('returns native tokens without an application', async () => {
		const nativeToken = createNativeToken();
		const { endpoint } = createEndpoint({
			nativeTokens: [nativeToken],
		});

		const result = await endpoint.exec({}, me, null);

		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(nativeToken.id);
	});
});
