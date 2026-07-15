/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { MastodonOAuthService } from './MastodonOAuthService.js';
import { MastodonScopeService } from './MastodonScopeService.js';
import { digestCredential } from './utils.js';

class FakeRedis {
	public readonly values = new Map<string, string>();

	public async set(key: string, value: string, ...args: string[]): Promise<'OK' | null> {
		if (args.includes('NX') && this.values.has(key)) return null;
		this.values.set(key, value);
		return 'OK';
	}

	public async get(key: string): Promise<string | null> {
		return this.values.get(key) ?? null;
	}

	public async getdel(key: string): Promise<string | null> {
		const value = this.values.get(key) ?? null;
		this.values.delete(key);
		return value;
	}

	public async del(...keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) deleted += this.values.delete(key) ? 1 : 0;
		return deleted;
	}

	public async publish(): Promise<number> {
		return 0;
	}
}

function createService(overrides: {
	clients?: Record<string, unknown>;
	tokens?: Record<string, unknown>;
	redis?: object;
	users?: Record<string, unknown>;
	cache?: Record<string, unknown>;
	id?: Record<string, unknown>;
} = {}) {
	const insertOne = vi.fn(async value => value);
	const tokenInsertOne = vi.fn(async value => value);
	const tokenDelete = vi.fn();
	const service = new MastodonOAuthService(
		{ url: 'https://misskey.example/' } as never,
		{ insertOne, findOneBy: vi.fn(), ...overrides.clients } as never,
		{ insertOne: tokenInsertOne, findOneBy: vi.fn(), delete: tokenDelete, ...overrides.tokens } as never,
		{ findOneBy: vi.fn(), ...overrides.users } as never,
		(overrides.redis ?? { set: vi.fn(), get: vi.fn(), getdel: vi.fn(), del: vi.fn(), publish: vi.fn() }) as never,
		{ gen: vi.fn().mockReturnValue('client-id'), ...overrides.id } as never,
		{ localUserByNativeTokenCache: { fetch: vi.fn() }, ...overrides.cache } as never,
		new MastodonScopeService(),
	);

	return { service, insertOne, tokenInsertOne, tokenDelete };
}

describe(MastodonOAuthService, () => {
	test('registers an application while storing only the client secret digest', async () => {
		const { service, insertOne } = createService();

		const application = await service.registerApplication({
			client_name: 'Elk',
			redirect_uris: 'https://elk.example/callback\nmyapp://oauth',
			scopes: 'read write follow push',
			website: 'https://elk.example/',
		});

		expect(application).toMatchObject({
			id: 'client-id',
			name: 'Elk',
			client_id: 'client-id',
			client_secret_expires_at: 0,
			redirect_uri: 'https://elk.example/callback',
			redirect_uris: ['https://elk.example/callback', 'myapp://oauth'],
			scopes: ['read', 'write', 'follow', 'push'],
			website: 'https://elk.example/',
		});
		expect(application.client_secret).toHaveLength(64);
		expect(insertOne).toHaveBeenCalledWith(expect.objectContaining({
			id: 'client-id',
			secretHash: digestCredential(application.client_secret),
			redirectUris: application.redirect_uris,
			scopes: ['read', 'write', 'follow', 'push'],
		}));
		expect(JSON.stringify(insertOne.mock.calls[0]?.[0])).not.toContain(application.client_secret);
	});

	test('validates registration fields', async () => {
		const { service } = createService();

		await expect(service.registerApplication({ client_name: '', redirect_uris: 'https://client.example/cb' })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.registerApplication({ client_name: 'Client', redirect_uris: 'http://client.example/cb' })).rejects.toMatchObject({ statusCode: 422 });
		await expect(service.registerApplication({ client_name: 'Client', redirect_uris: 'https://client.example/cb', scopes: 'unknown' })).rejects.toMatchObject({ statusCode: 422 });
	});

	test('issues a read-scoped application token with no user', async () => {
		const clientSecret = 'client-secret';
		const client = {
			id: 'client-id',
			secretHash: digestCredential(clientSecret),
			name: 'Client',
			redirectUris: ['https://client.example/callback'],
			scopes: ['read', 'write'],
		};
		const { service, tokenInsertOne } = createService({
			clients: { findOneBy: vi.fn().mockResolvedValue(client) },
			id: { gen: vi.fn().mockReturnValue('application-token-id') },
		});

		const token = await service.exchangeToken({
			grant_type: 'client_credentials',
			client_id: client.id,
			client_secret: clientSecret,
			redirect_uri: client.redirectUris[0],
		});

		expect(token).toMatchObject({ token_type: 'Bearer', scope: 'read' });
		expect(tokenInsertOne).toHaveBeenCalledWith(expect.objectContaining({
			id: 'application-token-id',
			userId: null,
			clientId: client.id,
			scopes: ['read'],
			tokenHash: digestCredential(token.access_token),
		}));
	});

	test('rejects application-token scopes outside the registered grant', async () => {
		const clientSecret = 'client-secret';
		const client = {
			id: 'client-id',
			secretHash: digestCredential(clientSecret),
			redirectUris: ['https://client.example/callback'],
			scopes: ['read'],
		};
		const { service } = createService({
			clients: { findOneBy: vi.fn().mockResolvedValue(client) },
		});

		await expect(service.exchangeToken({
			grant_type: 'client_credentials',
			client_id: client.id,
			client_secret: clientSecret,
			scope: 'write',
		})).rejects.toMatchObject({ error: 'invalid_scope' });
	});

	test('completes a confidential authorization-code flow without PKCE', async () => {
		const redis = new FakeRedis();
		const clientSecret = 'client-secret';
		const client = {
			id: 'client-id',
			secretHash: digestCredential(clientSecret),
			name: 'Tusky',
			redirectUris: ['tusky://oauth'],
			scopes: ['read', 'write', 'follow', 'push'],
		};
		const { service, tokenInsertOne } = createService({
			clients: { findOneBy: vi.fn().mockResolvedValue(client) },
			redis,
			users: { findOneBy: vi.fn().mockResolvedValue({ id: 'user-id' }) },
			cache: { localUserByNativeTokenCache: { fetch: vi.fn(async (_key, loader) => loader()) } },
			id: { gen: vi.fn().mockReturnValue('token-id') },
		});

		const authorization = await service.beginAuthorization({
			client_id: 'client-id',
			redirect_uri: 'tusky://oauth',
			response_type: 'code',
			scope: 'read write:statuses',
			state: 'state-value',
		});
		expect(authorization.transactionId).toMatch(/^mastodon:/u);
		expect(authorization.scope).toContain('write:notes');

		const decision = await service.decide(authorization.transactionId, 'native-login-token', false);
		expect(decision.parameters.state).toBe('state-value');

		const token = await service.exchangeToken({
			grant_type: 'authorization_code',
			code: decision.parameters.code,
			client_id: 'client-id',
			client_secret: clientSecret,
			redirect_uri: 'tusky://oauth',
		});

		expect(token.access_token).toHaveLength(64);
		expect(token).toMatchObject({ token_type: 'Bearer', scope: 'read write:statuses' });
		expect(tokenInsertOne).toHaveBeenCalledWith(expect.objectContaining({
			id: 'token-id',
			clientId: 'client-id',
			userId: 'user-id',
			tokenHash: digestCredential(token.access_token),
		}));
		expect(JSON.stringify(tokenInsertOne.mock.calls[0]?.[0])).not.toContain(token.access_token);
	});

	test('enforces exact redirect, registered scope subset, S256 PKCE, and client secret', async () => {
		const redis = new FakeRedis();
		const clientSecret = 'client-secret';
		const client = {
			id: 'client-id',
			secretHash: digestCredential(clientSecret),
			name: 'Phanpy',
			redirectUris: ['https://phanpy.example/oauth'],
			scopes: ['read', 'write'],
		};
		const { service } = createService({
			clients: { findOneBy: vi.fn().mockResolvedValue(client) },
			redis,
			users: { findOneBy: vi.fn().mockResolvedValue({ id: 'user-id' }) },
			cache: { localUserByNativeTokenCache: { fetch: vi.fn(async (_key, loader) => loader()) } },
		});
		const verifier = 'a'.repeat(64);
		const challenge = createHash('sha256').update(verifier).digest('base64url');

		await expect(service.beginAuthorization({
			client_id: 'client-id', response_type: 'code', redirect_uri: 'https://evil.example/oauth', scope: 'read',
		})).rejects.toMatchObject({ error: 'invalid_request' });
		await expect(service.beginAuthorization({
			client_id: 'client-id', response_type: 'code', redirect_uri: 'https://phanpy.example/oauth', scope: 'follow',
		})).rejects.toMatchObject({ error: 'invalid_scope' });

		const authorization = await service.beginAuthorization({
			client_id: 'client-id',
			response_type: 'code',
			redirect_uri: 'https://phanpy.example/oauth',
			scope: 'read:accounts',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		});
		const decision = await service.decide(authorization.transactionId, 'native-login-token', false);

		await expect(service.exchangeToken({
			grant_type: 'authorization_code', code: decision.parameters.code, client_id: 'client-id', client_secret: 'wrong', redirect_uri: 'https://phanpy.example/oauth', code_verifier: verifier,
		})).rejects.toMatchObject({ statusCode: 401, error: 'invalid_client' });
		await expect(service.exchangeToken({
			grant_type: 'authorization_code', code: decision.parameters.code, client_id: 'client-id', client_secret: clientSecret, redirect_uri: 'https://phanpy.example/oauth', code_verifier: 'wrong',
		})).rejects.toMatchObject({ error: 'invalid_grant' });
		await expect(service.exchangeToken({
			grant_type: 'authorization_code', code: decision.parameters.code, client_id: 'client-id', client_secret: clientSecret, redirect_uri: 'https://phanpy.example/oauth', code_verifier: verifier,
		})).resolves.toMatchObject({ token_type: 'Bearer', scope: 'read:accounts' });
	});

	test('revokes a token when an authorization code is replayed concurrently', async () => {
		const redis = new FakeRedis();
		const clientSecret = 'client-secret';
		const client = {
			id: 'client-id',
			secretHash: digestCredential(clientSecret),
			name: 'Elk',
			redirectUris: ['https://elk.example/oauth'],
			scopes: ['read'],
		};
		const { service, tokenDelete } = createService({
			clients: { findOneBy: vi.fn().mockResolvedValue(client) },
			redis,
			users: { findOneBy: vi.fn().mockResolvedValue({ id: 'user-id' }) },
			cache: { localUserByNativeTokenCache: { fetch: vi.fn(async (_key, loader) => loader()) } },
			id: { gen: vi.fn().mockReturnValue('token-id') },
		});
		const authorization = await service.beginAuthorization({
			client_id: 'client-id', response_type: 'code', redirect_uri: 'https://elk.example/oauth', scope: 'read',
		});
		const decision = await service.decide(authorization.transactionId, 'native-login-token', false);
		const exchange = () => service.exchangeToken({
			grant_type: 'authorization_code',
			code: decision.parameters.code,
			client_id: 'client-id',
			client_secret: clientSecret,
			redirect_uri: 'https://elk.example/oauth',
		});

		const results = await Promise.allSettled([exchange(), exchange()]);
		expect(results.every(result => result.status === 'rejected')).toBe(true);
		expect(tokenDelete).toHaveBeenCalledWith({ id: 'token-id' });
	});

	test('revokes only a token belonging to the authenticated client and is idempotent', async () => {
		const clientSecret = 'client-secret';
		const client = { id: 'client-id', secretHash: digestCredential(clientSecret) };
		const { service, tokenDelete } = createService({
			clients: { findOneBy: vi.fn().mockResolvedValue(client) },
			tokens: { findOneBy: vi.fn().mockResolvedValue({ id: 'token-id', clientId: 'client-id' }) },
		});

		await expect(service.revoke({ client_id: 'client-id', client_secret: clientSecret, token: 'raw-token' })).resolves.toBeUndefined();
		expect(tokenDelete).toHaveBeenCalledWith({ id: 'token-id', clientId: 'client-id' });
	});
});
