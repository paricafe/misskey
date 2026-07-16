/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { permissions as kinds } from 'misskey-js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MastodonApiError } from '@/server/api/mastodon/errors.js';
import { MastodonScopeService } from '@/server/api/mastodon/MastodonScopeService.js';
import { OAuth2ProviderService } from './OAuth2ProviderService.js';

type AuthenticationFixture = {
	kind: 'user';
	user: {
		id: string;
		username: string;
		name: string | null;
		uri: string | null;
		avatarUrl: string | null;
	};
	token: { id: string; scopes: string[] };
} | {
	kind: 'application';
	user: null;
	token: { id: string; scopes: string[] };
};

describe(OAuth2ProviderService, () => {
	const servers: ReturnType<typeof Fastify>[] = [];
	const services: OAuth2ProviderService[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map(server => server.close()));
		for (const service of services.splice(0)) service.dispose();
	});

	function createService(enableMastodonApi = true) {
		const authenticate = vi.fn<(token: string | undefined) => Promise<AuthenticationFixture>>(async (token: string | undefined) => {
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
		const accessTokensRepository = {
			insert: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
		};
		const httpRequestService = {
			send: vi.fn(),
		};
		const cacheService = {
			localUserByNativeTokenCache: {
				fetch: vi.fn().mockResolvedValue({ id: 'user-id' }),
			},
		};
		const mastodonOAuthService = {
			getSupportedScopes: vi.fn().mockReturnValue(scopeService.getSupportedScopes()),
			getRevocationEndpoint: vi.fn().mockReturnValue(new URL('https://misskey.example/oauth/revoke')),
			isMastodonClientId: vi.fn().mockReturnValue(false),
			beginAuthorization: vi.fn(),
			decide: vi.fn(),
			revoke: vi.fn(),
			extractClientId: vi.fn((_body: Record<string, unknown>) => undefined),
			exchangeToken: vi.fn(),
		};
		const service = new OAuth2ProviderService(
			{ url: 'https://misskey.example/', enableMastodonApi } as never,
			accessTokensRepository as never,
			{} as never,
			{ gen: vi.fn().mockReturnValue('access-token-id') } as never,
			httpRequestService as never,
			cacheService as never,
			{ getCommonData: vi.fn().mockResolvedValue({ config: { url: 'https://misskey.example/' } }) } as never,
			mastodonOAuthService as never,
			{ authenticate } as never,
			scopeService,
			{ getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }) } as never,
		);
		services.push(service);
		return {
			service,
			authenticate,
			scopeService,
			accessTokensRepository,
			httpRequestService,
			mastodonOAuthService,
		};
	}

	async function createServer(enableMastodonApi = true) {
		const fixture = createService(enableMastodonApi);
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

	test('restores native OAuth metadata and routes when Mastodon API is disabled', async () => {
		const { service, fastify, mastodonOAuthService } = await createServer(false);
		const metadata = service.generateRFC8414();

		expect(metadata.scopes_supported).toEqual(kinds);
		expect(metadata.grant_types_supported).toEqual(['authorization_code']);
		expect(metadata).not.toHaveProperty('userinfo_endpoint');
		expect(metadata).not.toHaveProperty('revocation_endpoint');
		expect(metadata).not.toHaveProperty('app_registration_endpoint');
		expect(metadata).not.toHaveProperty('token_endpoint_auth_methods_supported');
		expect((await fastify.inject({ method: 'GET', url: '/userinfo' })).statusCode).toBe(404);
		expect((await fastify.inject({ method: 'POST', url: '/revoke' })).statusCode).toBe(404);
		expect(mastodonOAuthService.getSupportedScopes).not.toHaveBeenCalled();
		expect(mastodonOAuthService.getRevocationEndpoint).not.toHaveBeenCalled();
	});

	test('completes native OAuth authorization code flow without Mastodon dispatch when disabled', async () => {
		const clientId = 'https://client.example/';
		const redirectUri = 'https://client.example/callback';
		const verifier = 'native-oauth-verifier-which-is-long-enough-for-pkce';
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const fixture = createService(false);
		fixture.httpRequestService.send.mockResolvedValue({
			headers: new Headers({ 'content-type': 'application/json' }),
			url: clientId,
			json: vi.fn().mockResolvedValue({
				client_id: clientId,
				client_uri: clientId,
				client_name: 'Native client',
				redirect_uris: [redirectUri],
			}),
		});
		const authorizationServer = Fastify();
		await fixture.service.createServer(authorizationServer);
		servers.push(authorizationServer);
		const tokenServer = Fastify();
		tokenServer.register(fixture.service.createTokenServer, { prefix: '/oauth/token' });
		await tokenServer.ready();
		servers.push(tokenServer);

		const authorize = await authorizationServer.inject({
			method: 'GET',
			url: '/authorize',
			query: {
				client_id: clientId,
				redirect_uri: redirectUri,
				response_type: 'code',
				scope: 'write:notes',
				state: 'native-state',
				code_challenge: challenge,
				code_challenge_method: 'S256',
			},
		});
		expect(authorize.statusCode, authorize.headers.location ?? authorize.body).toBe(200);
		const transactionId = /name="misskey:oauth:transaction-id" content="([^"]+)"/u.exec(authorize.body)?.[1];
		expect(transactionId).toBeTruthy();
		if (transactionId == null) throw new Error('Missing authorization transaction ID');

		const decision = await authorizationServer.inject({
			method: 'POST',
			url: '/decision',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			payload: new URLSearchParams({
				transaction_id: transactionId,
				login_token: 'native-login-token',
			}).toString(),
		});
		expect(decision.statusCode).toBe(302);
		const location = decision.headers.location;
		if (location == null) throw new Error('Missing authorization redirect');
		const redirect = new URL(location);
		expect(redirect.searchParams.get('state')).toBe('native-state');
		expect(redirect.searchParams.get('iss')).toBe('https://misskey.example/');
		const code = redirect.searchParams.get('code');
		expect(code).toBeTruthy();
		if (code == null) throw new Error('Missing authorization code');

		const token = await tokenServer.inject({
			method: 'POST',
			url: '/oauth/token',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			payload: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				client_id: clientId,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			}).toString(),
		});
		expect(token.statusCode).toBe(200);
		expect(token.json()).toMatchObject({ token_type: 'Bearer', scope: 'write:notes' });
		expect(fixture.accessTokensRepository.insert).toHaveBeenCalledWith(expect.objectContaining({
			id: 'access-token-id',
			userId: 'user-id',
			name: clientId,
			permission: ['write:notes'],
		}));
		expect(fixture.mastodonOAuthService.isMastodonClientId).not.toHaveBeenCalled();
		expect(fixture.mastodonOAuthService.beginAuthorization).not.toHaveBeenCalled();
		expect(fixture.mastodonOAuthService.decide).not.toHaveBeenCalled();
		expect(fixture.mastodonOAuthService.extractClientId).not.toHaveBeenCalled();
		expect(fixture.mastodonOAuthService.exchangeToken).not.toHaveBeenCalled();
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
