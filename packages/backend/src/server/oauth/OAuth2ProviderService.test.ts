/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { permissions as kinds } from 'misskey-js';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { OAuth2ProviderService } from './OAuth2ProviderService.js';

describe(OAuth2ProviderService, () => {
	const servers: ReturnType<typeof Fastify>[] = [];
	const services: OAuth2ProviderService[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map(server => server.close()));
		for (const service of services.splice(0)) service.dispose();
	});

	function createService() {
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
		const service = new OAuth2ProviderService(
			{ url: 'https://misskey.example/' } as never,
			accessTokensRepository as never,
			{} as never,
			{ gen: vi.fn().mockReturnValue('access-token-id') } as never,
			httpRequestService as never,
			cacheService as never,
			{ getCommonData: vi.fn().mockResolvedValue({ config: { url: 'https://misskey.example/' } }) } as never,
			{ getLogger: vi.fn().mockReturnValue({ info: vi.fn(), error: vi.fn() }) } as never,
		);
		services.push(service);
		return {
			service,
			accessTokensRepository,
			httpRequestService,
		};
	}

	async function createServer() {
		const fixture = createService();
		const fastify = Fastify();
		await fixture.service.createServer(fastify);
		servers.push(fastify);
		return { ...fixture, fastify };
	}

	test('advertises native OAuth metadata and routes', async () => {
		const { service, fastify } = await createServer();
		const metadata = service.generateRFC8414();

		expect(metadata.scopes_supported).toEqual(kinds);
		expect(metadata.grant_types_supported).toEqual(['authorization_code']);
		expect(metadata).not.toHaveProperty('userinfo_endpoint');
		expect(metadata).not.toHaveProperty('revocation_endpoint');
		expect(metadata).not.toHaveProperty('app_registration_endpoint');
		expect(metadata).not.toHaveProperty('token_endpoint_auth_methods_supported');
		expect((await fastify.inject({ method: 'GET', url: '/userinfo' })).statusCode).toBe(404);
		expect((await fastify.inject({ method: 'POST', url: '/revoke' })).statusCode).toBe(404);
	});

	test('preserves the native OAuth authorization code flow', async () => {
		const clientId = 'https://client.example/';
		const redirectUri = 'https://client.example/callback';
		const verifier = 'native-oauth-verifier-which-is-long-enough-for-pkce';
		const challenge = createHash('sha256').update(verifier).digest('base64url');
		const fixture = createService();
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
				client_extension: 'native',
				'client_extension[details]': 'opaque',
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
	});

	test('keeps native OAuth multipart token requests unsupported', async () => {
		const fixture = createService();
		const fastify = Fastify();
		fastify.register(fixture.service.createTokenServer, { prefix: '/oauth/token' });
		servers.push(fastify);
		const form = new FormData();
		form.append('client_id', 'https://native.example/');
		form.append('grant_type', 'authorization_code');
		const request = new Request('https://misskey.example/oauth/token', { method: 'POST', body: form });
		const result = await fastify.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': request.headers.get('content-type')! }, payload: Buffer.from(await request.arrayBuffer()) });
		expect(result.statusCode).toBe(415);
		expect(fixture.accessTokensRepository.insert).not.toHaveBeenCalled();
	});
});
