/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { verifyChallenge } from 'pkce-challenge';
import { CacheService } from '@/core/CacheService.js';
import { IdService } from '@/core/IdService.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type {
	MastodonOAuthClientsRepository,
	MastodonOAuthTokensRepository,
	UsersRepository,
} from '@/models/_.js';
import { MastodonApiError } from './errors.js';
import { MastodonScopeService } from './MastodonScopeService.js';
import type { MastodonApplicationRegistration, MastodonCredentialApplication } from './types.js';
import type { MiLocalUser } from '@/models/User.js';
import { digestCredential, generateCredential, parseRedirectUris, timingSafeDigestEqual } from './utils.js';

type OAuthParameters = Record<string, string | string[] | undefined>;

type AuthorizationTransaction = {
	clientId: string;
	clientName: string;
	redirectUri: string;
	state?: string;
	scopes: string[];
	codeChallenge?: string;
};

type AuthorizationGrant = {
	clientId: string;
	userId: string;
	redirectUri: string;
	scopes: string[];
	codeChallenge?: string;
};

export type MastodonAuthorizationPage = {
	transactionId: string;
	clientName: string;
	scope: string[];
};

export type MastodonAuthorizationDecision = {
	redirectUri: string;
	parameters: Record<string, string>;
};

export type MastodonTokenResponse = {
	access_token: string;
	token_type: 'Bearer';
	scope: string;
	created_at: number;
};

@Injectable()
export class MastodonOAuthService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.mastodonOAuthClientsRepository)
		private mastodonOAuthClientsRepository: MastodonOAuthClientsRepository,

		@Inject(DI.mastodonOAuthTokensRepository)
		private mastodonOAuthTokensRepository: MastodonOAuthTokensRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.redis)
		private redis: Redis.Redis,

		private idService: IdService,
		private cacheService: CacheService,
		private mastodonScopeService: MastodonScopeService,
	) {}

	public async registerApplication(input: MastodonApplicationRegistration): Promise<MastodonCredentialApplication> {
		const name = typeof input.client_name === 'string' ? input.client_name.trim() : '';
		if (name.length === 0 || name.length > 256) {
			throw this.registrationError('client_name must contain between 1 and 256 characters');
		}

		let redirectUris: string[];
		let scopes: string[];
		try {
			redirectUris = parseRedirectUris(input.redirect_uris);
			scopes = this.mastodonScopeService.normalize(input.scopes);
		} catch (error) {
			throw this.registrationError(error instanceof Error ? error.message : 'invalid registration');
		}

		const website = this.validateWebsite(input.website);
		const clientSecret = generateCredential();
		const now = new Date();
		const id = this.idService.gen(now.getTime());

		await this.mastodonOAuthClientsRepository.insertOne({
			id,
			secretHash: digestCredential(clientSecret),
			name,
			website,
			redirectUris,
			scopes,
			createdAt: now,
		});

		return {
			id,
			name,
			website,
			redirect_uri: redirectUris[0],
			redirect_uris: redirectUris,
			scopes: scopes.join(' '),
			client_id: id,
			client_secret: clientSecret,
			client_secret_expires_at: 0,
		};
	}

	public isMastodonClientId(clientId: string | undefined): boolean {
		if (clientId == null || clientId === '') return false;
		try {
			const url = new URL(clientId);
			return url.protocol !== 'http:' && url.protocol !== 'https:';
		} catch {
			return true;
		}
	}

	public getSupportedScopes(): string[] {
		return this.mastodonScopeService.getSupportedScopes();
	}

	public getRevocationEndpoint(): URL {
		return new URL('/oauth/revoke', this.config.url);
	}

	public async getApplication(clientId: string): Promise<Record<string, unknown>> {
		const client = await this.mastodonOAuthClientsRepository.findOneBy({ id: clientId });
		if (client == null) throw new MastodonApiError(404, 'not_found', 'Application not found');
		return {
			id: client.id,
			name: client.name,
			website: client.website,
			redirect_uri: client.redirectUris[0],
			redirect_uris: client.redirectUris,
			client_id: client.id,
			scopes: client.scopes.join(' '),
			vapid_key: '',
		};
	}

	public extractClientId(parameters: OAuthParameters, authorizationHeader?: string): string | undefined {
		return this.readClientCredentials(parameters, authorizationHeader).clientId;
	}

	public async beginAuthorization(parameters: OAuthParameters): Promise<MastodonAuthorizationPage> {
		const clientId = this.firstValue(parameters.client_id);
		const redirectUri = this.firstValue(parameters.redirect_uri);
		const responseType = this.firstValue(parameters.response_type);
		const state = this.firstValue(parameters.state);
		const codeChallenge = this.firstValue(parameters.code_challenge);
		const codeChallengeMethod = this.firstValue(parameters.code_challenge_method);

		if (responseType !== 'code') {
			throw this.oauthError(400, 'unsupported_response_type', 'response_type must be code');
		}
		if (clientId == null) {
			throw this.oauthError(400, 'invalid_request', 'client_id is required');
		}

		const client = await this.mastodonOAuthClientsRepository.findOneBy({ id: clientId });
		if (client == null) {
			throw this.oauthError(400, 'invalid_client', 'The client is unknown');
		}
		if (redirectUri == null || !client.redirectUris.includes(redirectUri)) {
			throw this.oauthError(400, 'invalid_request', 'redirect_uri does not exactly match a registered URI');
		}

		let scopes: string[];
		try {
			scopes = this.mastodonScopeService.normalize(parameters.scope);
		} catch (error) {
			throw this.oauthError(400, 'invalid_scope', error instanceof Error ? error.message : 'scope is invalid');
		}
		if (!scopes.every(scope => this.mastodonScopeService.allows(client.scopes, scope))) {
			throw this.oauthError(400, 'invalid_scope', 'The requested scope exceeds the registered scope');
		}

		if (codeChallenge == null && codeChallengeMethod != null) {
			throw this.oauthError(400, 'invalid_request', 'code_challenge is required when code_challenge_method is present');
		}
		if (codeChallenge != null) {
			if (codeChallengeMethod !== 'S256') {
				throw this.oauthError(400, 'invalid_request', 'code_challenge_method must be S256');
			}
			if (!/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)) {
				throw this.oauthError(400, 'invalid_request', 'code_challenge is invalid');
			}
		}

		const transactionId = `mastodon:${generateCredential()}`;
		const transaction: AuthorizationTransaction = {
			clientId: client.id,
			clientName: client.name,
			redirectUri,
			state,
			scopes,
			codeChallenge,
		};
		await this.redis.set(this.transactionKey(transactionId), JSON.stringify(transaction), 'EX', 300);

		return {
			transactionId,
			clientName: client.name,
			scope: this.mastodonScopeService.toMisskeyPermissions(scopes),
		};
	}

	public async decide(transactionId: string, loginToken: string | undefined, cancel: boolean): Promise<MastodonAuthorizationDecision> {
		if (!transactionId.startsWith('mastodon:')) {
			throw this.oauthError(403, 'access_denied', 'The authorization transaction is invalid or expired');
		}
		const serialized = await this.redis.getdel(this.transactionKey(transactionId));
		if (serialized == null) {
			throw this.oauthError(403, 'access_denied', 'The authorization transaction is invalid or expired');
		}
		const transaction = JSON.parse(serialized) as AuthorizationTransaction;

		if (cancel) {
			return {
				redirectUri: transaction.redirectUri,
				parameters: {
					error: 'access_denied',
					...(transaction.state != null ? { state: transaction.state } : {}),
				},
			};
		}
		if (loginToken == null || loginToken === '') {
			throw this.oauthError(400, 'invalid_request', 'No user was selected');
		}

		const user = await this.cacheService.localUserByNativeTokenCache.fetch(loginToken, () => (
			this.usersRepository.findOneBy({ token: loginToken }) as Promise<MiLocalUser | null>
		));
		if (user == null || user.isDeleted || user.isSuspended) {
			throw this.oauthError(400, 'invalid_request', 'No such available user');
		}

		const code = generateCredential();
		const grant: AuthorizationGrant = {
			clientId: transaction.clientId,
			userId: user.id,
			redirectUri: transaction.redirectUri,
			scopes: transaction.scopes,
			codeChallenge: transaction.codeChallenge,
		};
		await this.redis.set(this.grantKey(code), JSON.stringify(grant), 'EX', 300);

		return {
			redirectUri: transaction.redirectUri,
			parameters: {
				code,
				...(transaction.state != null ? { state: transaction.state } : {}),
			},
		};
	}

	public async exchangeCode(parameters: OAuthParameters, authorizationHeader?: string): Promise<MastodonTokenResponse> {
		if (this.firstValue(parameters.grant_type) !== 'authorization_code') {
			throw this.oauthError(400, 'unsupported_grant_type', 'grant_type must be authorization_code');
		}

		const client = await this.authenticateClient(parameters, authorizationHeader);
		const code = this.firstValue(parameters.code);
		const redirectUri = this.firstValue(parameters.redirect_uri);
		if (code == null) {
			throw this.oauthError(400, 'invalid_grant', 'The authorization code is invalid');
		}

		const serialized = await this.redis.get(this.grantKey(code));
		if (serialized == null) {
			await this.revokeTokenIssuedForCode(code);
			throw this.oauthError(400, 'invalid_grant', 'The authorization code is invalid or expired');
		}
		const grant = JSON.parse(serialized) as AuthorizationGrant;
		if (grant.clientId !== client.id || redirectUri !== grant.redirectUri) {
			throw this.oauthError(400, 'invalid_grant', 'The authorization code is invalid');
		}

		if (grant.codeChallenge != null) {
			const verifier = this.firstValue(parameters.code_verifier);
			if (verifier == null || !(await verifyChallenge(verifier, grant.codeChallenge))) {
				throw this.oauthError(400, 'invalid_grant', 'The PKCE verifier is invalid');
			}
		}

		const now = new Date();
		const tokenId = this.idService.gen(now.getTime());
		const acquired = await this.redis.set(this.usedGrantKey(code), tokenId, 'EX', 300, 'NX');
		if (acquired == null) {
			await this.markGrantReplayed(code);
			throw this.oauthError(400, 'invalid_grant', 'The authorization code has already been used');
		}

		const rawToken = generateCredential();
		try {
			await this.mastodonOAuthTokensRepository.insertOne({
				id: tokenId,
				tokenHash: digestCredential(rawToken),
				userId: grant.userId,
				clientId: grant.clientId,
				scopes: grant.scopes,
				createdAt: now,
				lastUsedAt: null,
			});
		} catch (error) {
			await this.redis.del(this.usedGrantKey(code));
			throw error;
		}
		await this.redis.set(this.issuedTokenKey(code), tokenId, 'EX', 300);
		if (await this.redis.get(this.replayedGrantKey(code)) != null) {
			await this.mastodonOAuthTokensRepository.delete({ id: tokenId });
			await this.publishTokenRevoked(tokenId);
			throw this.oauthError(400, 'invalid_grant', 'The authorization code has already been used');
		}

		return {
			access_token: rawToken,
			token_type: 'Bearer',
			scope: grant.scopes.join(' '),
			created_at: Math.floor(now.getTime() / 1000),
		};
	}

	public async revoke(parameters: OAuthParameters, authorizationHeader?: string): Promise<void> {
		const client = await this.authenticateClient(parameters, authorizationHeader);
		const rawToken = this.firstValue(parameters.token);
		if (rawToken == null) return;

		const token = await this.mastodonOAuthTokensRepository.findOneBy({
			tokenHash: digestCredential(rawToken),
			clientId: client.id,
		});
		if (token != null) {
			await this.mastodonOAuthTokensRepository.delete({ id: token.id, clientId: client.id });
			await this.publishTokenRevoked(token.id);
		}
	}

	private async authenticateClient(parameters: OAuthParameters, authorizationHeader?: string) {
		const credentials = this.readClientCredentials(parameters, authorizationHeader);
		if (credentials.clientId == null || credentials.clientSecret == null) {
			throw this.oauthError(401, 'invalid_client', 'Client authentication is required');
		}

		const client = await this.mastodonOAuthClientsRepository.findOneBy({ id: credentials.clientId });
		if (client == null || client.id !== credentials.clientId || !timingSafeDigestEqual(credentials.clientSecret, client.secretHash)) {
			throw this.oauthError(401, 'invalid_client', 'Client authentication failed');
		}

		return client;
	}

	private readClientCredentials(parameters: OAuthParameters, authorizationHeader?: string): { clientId?: string; clientSecret?: string } {
		if (authorizationHeader?.startsWith('Basic ')) {
			try {
				const decoded = Buffer.from(authorizationHeader.slice(6), 'base64').toString('utf8');
				const separator = decoded.indexOf(':');
				if (separator >= 0) {
					return {
						clientId: decodeURIComponent(decoded.slice(0, separator)),
						clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
					};
				}
			} catch {
				return {};
			}
		}

		return {
			clientId: this.firstValue(parameters.client_id),
			clientSecret: this.firstValue(parameters.client_secret),
		};
	}

	private firstValue(value: string | string[] | undefined): string | undefined {
		return Array.isArray(value) ? value[0] : value;
	}

	private async revokeTokenIssuedForCode(code: string): Promise<void> {
		const tokenId = await this.redis.get(this.issuedTokenKey(code));
		if (tokenId != null) {
			await this.mastodonOAuthTokensRepository.delete({ id: tokenId });
			await this.publishTokenRevoked(tokenId);
			await this.redis.del(this.issuedTokenKey(code));
		}
	}

	private async markGrantReplayed(code: string): Promise<void> {
		await this.redis.set(this.replayedGrantKey(code), '1', 'EX', 300);
		const tokenId = await this.redis.get(this.usedGrantKey(code));
		if (tokenId != null) {
			await this.mastodonOAuthTokensRepository.delete({ id: tokenId });
			await this.publishTokenRevoked(tokenId);
		}
	}

	private async publishTokenRevoked(tokenId: string): Promise<void> {
		await this.redis.publish(this.config.host, JSON.stringify({
			channel: `mastodonTokenRevoked:${tokenId}`,
			message: null,
		}));
	}

	private transactionKey(transactionId: string): string {
		return `mastodon-oauth:transaction:${transactionId}`;
	}

	private grantKey(code: string): string {
		return `mastodon-oauth:grant:${code}`;
	}

	private usedGrantKey(code: string): string {
		return `mastodon-oauth:grant-used:${code}`;
	}

	private replayedGrantKey(code: string): string {
		return `mastodon-oauth:grant-replayed:${code}`;
	}

	private issuedTokenKey(code: string): string {
		return `mastodon-oauth:grant-token:${code}`;
	}

	private validateWebsite(value: string | undefined): string | null {
		if (value == null || value.trim() === '') return null;
		if (value.length > 2048) throw this.registrationError('website is too long');

		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw this.registrationError('website must be an absolute URL');
		}
		if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
			throw this.registrationError('website must be an HTTP(S) URL without credentials');
		}

		return value;
	}

	private registrationError(description: string): MastodonApiError {
		return new MastodonApiError(422, 'invalid_client_metadata', description);
	}

	private oauthError(statusCode: number, error: string, description: string): MastodonApiError {
		return new MastodonApiError(statusCode, error, description, true);
	}
}
