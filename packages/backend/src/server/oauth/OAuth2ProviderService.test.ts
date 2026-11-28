/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test } from 'vitest';
import { OAuth2ProviderService } from './OAuth2ProviderService.js';

describe('OAuth2ProviderService.generateRFC8414', () => {
	const services: OAuth2ProviderService[] = [];

	afterEach(() => {
		while (services.length > 0) services.pop()!.onApplicationShutdown();
	});

	function createService(enableMastodonApi: boolean) {
		const service = new OAuth2ProviderService(
			{ url: 'https://social.example', enableMastodonApi } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{ getLogger: () => ({}) } as never,
		);
		services.push(service);
		return service;
	}

	test('merges Mastodon compatibility metadata when enableMastodonApi is enabled', () => {
		const metadata = createService(true).generateRFC8414();
		expect(metadata.grant_types_supported).toContain('authorization_code');
		expect(metadata.grant_types_supported).toContain('client_credentials');
		expect(metadata.scopes_supported).toContain('read');
		expect(metadata.scopes_supported).toContain('write');
		expect(metadata.scopes_supported).toContain('read:account');
		expect(String(metadata.app_registration_endpoint)).toBe('https://social.example/api/v1/apps');
		expect(String(metadata.revocation_endpoint)).toBe('https://social.example/oauth/revoke');
		expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
	});

	test('omits Mastodon compatibility metadata when enableMastodonApi is disabled', () => {
		const metadata = createService(false).generateRFC8414();
		expect(metadata.grant_types_supported).toEqual(['authorization_code']);
		expect(metadata.scopes_supported).not.toContain('read');
		expect('app_registration_endpoint' in metadata).toBe(false);
		expect('revocation_endpoint' in metadata).toBe(false);
	});
});
