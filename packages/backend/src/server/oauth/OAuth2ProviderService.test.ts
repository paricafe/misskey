/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MastodonApiError } from '@/server/api/mastodon/errors.js';
import { MastodonScopeService } from '@/server/api/mastodon/MastodonScopeService.js';
import { OAuth2ProviderService } from './OAuth2ProviderService.js';

describe(OAuth2ProviderService, () => {
	const servers: ReturnType<typeof Fastify>[] = [];
	const services: OAuth2ProviderService[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map(server => server.close()));
		for (const service of services.splice(0)) service.dispose();
	});

	function createService() {
		const authenticate = vi.fn(async (token: string | undefined) => {
			if (token == null) throw new MastodonApiError(401, 'invalid_token', 'The access token is invalid');
			return {
				kind: 'user',
				user: {
					id: 'user-id',
					username: 'alice',
					name: 'Alice',
					uri: 'https://remote.example/users/alice',
					avatarUrl: 'https://cdn.example/alice.png',
				},
				token: { id: 'token-id', scopes: ['profile'] },
			};
		});
		const scopeService = new MastodonScopeService();
		const mastodonOAuthService = {
			getSupportedScopes: vi.fn().mockReturnValue(scopeService.getSupportedScopes()),
			getRevocationEndpoint: vi.fn().mockReturnValue(new URL('https://misskey.example/oauth/revoke')),
		};
		const service = new OAuth2ProviderService(
			{ url: 'https://misskey.example/' } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			mastodonOAuthService as never,
			{ authenticate } as never,
			scopeService,
			{ getLogger: vi.fn().mockReturnValue({}) } as never,
		);
		services.push(service);
		return { service, authenticate, scopeService };
	}

	async function createServer() {
		const fixture = createService();
		const fastify = Fastify();
		await fixture.service.createServer(fastify);
		servers.push(fastify);
		return { ...fixture, fastify };
	}

	test('advertises client credentials, official Mastodon scopes, and userinfo', () => {
		const { service } = createService();
		const metadata = service.generateRFC8414();

		expect(metadata.grant_types_supported).toEqual([
			'authorization_code',
			'client_credentials',
		]);
		expect(metadata.scopes_supported).toEqual(expect.arrayContaining([
			'profile',
			'read:collections',
			'write:collections',
		]));
		expect(metadata.userinfo_endpoint).toBe('https://misskey.example/oauth/userinfo');
	});

	test.each(['GET', 'POST'] as const)('serves OAuth userinfo over %s', async method => {
		const { fastify, authenticate } = await createServer();
		const response = await fastify.inject({
			method,
			url: '/userinfo',
			headers: { authorization: method === 'GET' ? 'bEaReR user-token' : 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers['cache-control']).toBe('no-store');
		expect(authenticate).toHaveBeenCalledWith('user-token');
		expect(response.json()).toEqual({
			iss: 'https://misskey.example/',
			sub: 'https://remote.example/users/alice',
			name: 'Alice',
			preferred_username: 'alice',
			profile: 'https://misskey.example/@alice',
			picture: 'https://cdn.example/alice.png',
		});
	});

	test('uses stable local fallbacks in userinfo', async () => {
		const { fastify, authenticate } = await createServer();
		authenticate.mockResolvedValueOnce({
			kind: 'user',
			user: { id: 'user-id', username: 'alice', name: null, uri: null, avatarUrl: null },
			token: { id: 'token-id', scopes: ['profile'] },
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/userinfo',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			iss: 'https://misskey.example/',
			sub: 'https://misskey.example/users/user-id',
			name: 'alice',
			preferred_username: 'alice',
			profile: 'https://misskey.example/@alice',
			picture: 'https://misskey.example/avatar/@alice',
		});
	});

	test('rejects missing or invalid userinfo bearer tokens', async () => {
		const { fastify, authenticate } = await createServer();
		const missing = await fastify.inject({ method: 'GET', url: '/userinfo' });
		authenticate.mockRejectedValueOnce(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));
		const invalid = await fastify.inject({
			method: 'GET',
			url: '/userinfo',
			headers: { authorization: 'Bearer invalid-token' },
		});

		expect(missing.statusCode).toBe(401);
		expect(invalid.statusCode).toBe(401);
	});

	test('rejects application tokens on userinfo', async () => {
		const { fastify, authenticate } = await createServer();
		authenticate.mockResolvedValueOnce({
			kind: 'application',
			user: null,
			token: { id: 'application-token-id', scopes: ['profile'] },
		});

		const response = await fastify.inject({
			method: 'POST',
			url: '/userinfo',
			headers: { authorization: 'Bearer application-token' },
		});

		expect(response.statusCode).toBe(401);
	});

	test('requires profile scope on userinfo', async () => {
		const { fastify, authenticate } = await createServer();
		authenticate.mockResolvedValueOnce({
			kind: 'user',
			user: { id: 'user-id', username: 'alice', name: null, uri: null, avatarUrl: null },
			token: { id: 'token-id', scopes: ['read:accounts'] },
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/userinfo',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(403);
	});
});
