/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { OAuth2ProviderService } from './OAuth2ProviderService.js';

describe(OAuth2ProviderService, () => {
	test('advertises the supported client credentials grant', () => {
		const service = new OAuth2ProviderService(
			{ url: 'https://misskey.example/' } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{
				getSupportedScopes: vi.fn().mockReturnValue(['read']),
				getRevocationEndpoint: vi.fn().mockReturnValue(new URL('https://misskey.example/oauth/revoke')),
			} as never,
			{ getLogger: vi.fn().mockReturnValue({}) } as never,
		);

		try {
			expect(service.generateRFC8414().grant_types_supported).toEqual([
				'authorization_code',
				'client_credentials',
			]);
		} finally {
			service.dispose();
		}
	});
});
