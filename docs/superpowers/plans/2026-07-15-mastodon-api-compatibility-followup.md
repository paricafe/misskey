# Mastodon API Compatibility Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the high-impact Mastodon OAuth and API contracts, expose user-owned compatibility tokens in Misskey's existing token manager, and retain strict isolation from native Misskey authentication.

**Architecture:** Keep Mastodon clients and bearer tokens in the existing compatibility tables, using nullable `userId` to distinguish application tokens from user tokens. Extend the existing gateway with an anonymous invocation path for genuinely public native endpoints, keep user-only calls behind scope-derived synthetic tokens, and add narrowly-scoped route/service behavior for notification suppression and official response shapes.

**Tech Stack:** TypeScript, NestJS, Fastify, TypeORM/PostgreSQL, ioredis, Vitest, pnpm, Misskey native endpoint executors.

## Global Constraints

- Do not edit `packages/backend/migration/1783956161436-mastodon-api-compatibility.js`; add a new reversible migration.
- The migration may change only `mastodon_oauth_token.userId` nullability and must not alter native Misskey tables.
- Mastodon tokens must remain invalid on native `/api` routes, and native tokens must remain invalid on Mastodon routes.
- Application tokens have `userId = null` and are accepted only by application/public API surfaces.
- Advertise `api_versions.mastodon = 1` until every later versioned contract is implemented.
- Reject unsupported `scheduled_at` with HTTP 422 before invoking `notes/create`.
- Do not edit locale YAML files.
- Do not run backend end-to-end tests; use unit tests and Fastify injection tests.
- Every new AGPL-governed TypeScript or migration file must include the repository SPDX header.
- Run `pnpm build-misskey-js-with-types` because native API endpoint behavior is changing, even though the `i/apps` response shape stays stable.

---

## File Structure

- `packages/backend/migration/1784113507739-mastodon-oauth-application-tokens.js`: only drops/restores the compatibility token `userId` NOT NULL constraint.
- `packages/backend/src/models/MastodonOAuthToken.ts`: represents nullable application-token ownership.
- `packages/backend/src/server/api/mastodon/types.ts`: discriminated application/user authentication types and official application response shapes.
- `packages/backend/src/server/api/mastodon/MastodonOAuthService.ts`: dispatches authorization-code and client-credentials grants.
- `packages/backend/src/server/api/mastodon/MastodonAuthenticateService.ts`: resolves a digest to application or user authentication.
- `packages/backend/src/server/api/mastodon/MastodonApiCallService.ts`: invokes public native endpoints anonymously and user endpoints with a synthetic token.
- `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`: owns the added/corrected REST contracts and route auth policies.
- `packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.ts`: keeps WebSocket streaming user-token-only after authentication becomes discriminated.
- `packages/backend/src/server/api/mastodon/MastodonNotificationService.ts`: maps notification filters and stores bounded Redis dismissals.
- `packages/backend/src/server/api/endpoints/i/apps.ts`: aggregates native and Mastodon user tokens.
- `packages/backend/src/server/api/endpoints/i/revoke-token.ts`: revokes either user-owned token type.
- Adjacent `*.test.ts` files and `packages/backend/test/unit/mastodon-oauth-token-migration.ts`: unit and route-level contract coverage.

### Task 1: Minimal nullable-user migration

**Files:**
- Create: `packages/backend/migration/1784113507739-mastodon-oauth-application-tokens.js`
- Modify: `packages/backend/src/models/MastodonOAuthToken.ts`
- Test: `packages/backend/test/unit/mastodon-oauth-token-migration.ts`

**Interfaces:**
- Produces: `MiMastodonOAuthToken.userId: MiUser['id'] | null` and `MiMastodonOAuthToken.user: MiUser | null`.
- Preserves: token hash, client relation, scopes, timestamps, indexes, and foreign-key names.

- [ ] **Step 1: Write the failing migration contract test**

```ts
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import { MastodonOAuthApplicationTokens1784113507739 } from '../../migration/1784113507739-mastodon-oauth-application-tokens.js';
import { MiMastodonOAuthToken } from '@/models/MastodonOAuthToken.js';

describe('Mastodon OAuth application token migration', () => {
	test('drops and restores only the userId not-null constraint', async () => {
		const query = vi.fn().mockResolvedValue(undefined);
		const migration = new MastodonOAuthApplicationTokens1784113507739();

		await migration.up({ query } as never);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query).toHaveBeenNthCalledWith(1, 'ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" DROP NOT NULL');

		query.mockClear();
		await migration.down({ query } as never);
		expect(query).toHaveBeenNthCalledWith(1, 'DELETE FROM "mastodon_oauth_token" WHERE "userId" IS NULL');
		expect(query).toHaveBeenNthCalledWith(2, 'ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" SET NOT NULL');
	});

	test('marks the entity userId column nullable', () => {
		const column = getMetadataArgsStorage().columns.find(value => (
			value.target === MiMastodonOAuthToken && value.propertyName === 'userId'
		));
		expect(column?.options.nullable).toBe(true);
	});
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter backend test -- --run test/unit/mastodon-oauth-token-migration.ts`

Expected: FAIL because the migration module does not exist and `userId` is not nullable.

- [ ] **Step 3: Add the migration and nullable entity fields**

```js
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class MastodonOAuthApplicationTokens1784113507739 {
    name = 'MastodonOAuthApplicationTokens1784113507739'

    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" DROP NOT NULL');
    }

    async down(queryRunner) {
        await queryRunner.query('DELETE FROM "mastodon_oauth_token" WHERE "userId" IS NULL');
        await queryRunner.query('ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" SET NOT NULL');
    }
}
```

Change the entity fields to:

```ts
@Index('IDX_mastodon_oauth_token_user_id')
@Column({ ...id(), nullable: true })
public userId: MiUser['id'] | null;

@ManyToOne(() => MiUser, { nullable: true, onDelete: 'CASCADE' })
@JoinColumn({ name: 'userId', foreignKeyConstraintName: 'FK_mastodon_oauth_token_user_id' })
public user: MiUser | null;
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter backend test -- --run test/unit/mastodon-oauth-token-migration.ts`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit the migration slice**

```bash
git add packages/backend/migration/1784113507739-mastodon-oauth-application-tokens.js packages/backend/src/models/MastodonOAuthToken.ts packages/backend/test/unit/mastodon-oauth-token-migration.ts
git commit -m "feat(backend): support Mastodon application tokens"
```

### Task 2: Client-credentials issuance and discriminated authentication

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/types.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonOAuthService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonOAuthService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonAuthenticateService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonAuthenticateService.test.ts`
- Modify: `packages/backend/src/server/oauth/OAuth2ProviderService.ts`

**Interfaces:**
- Produces: `MastodonOAuthService.exchangeToken(parameters, authorizationHeader?)`.
- Produces: `MastodonAuth = MastodonApplicationAuth | MastodonUserAuth` with a `kind` discriminator.
- Preserves: authorization-code replay protection and PKCE behavior.

- [ ] **Step 1: Add failing OAuth and authentication tests**

Add a client-credentials test to `MastodonOAuthService.test.ts`:

```ts
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
```

Change registration/application assertions from a space-delimited `scopes` string to an array. Add this authentication test:

```ts
test('returns an application auth result without loading a user', async () => {
	const token = {
		id: 'app-token-id',
		tokenHash: digestCredential('raw-token'),
		userId: null,
		clientId: 'client-id',
		scopes: ['read'],
	};
	const fetch = vi.fn();
	const service = new MastodonAuthenticateService(
		{ findOneBy: vi.fn().mockResolvedValue(token), update: vi.fn() } as never,
		{ findOneBy: vi.fn() } as never,
		{ localUserByIdCache: { fetch } } as never,
	);

	await expect(service.authenticate('raw-token')).resolves.toEqual({
		kind: 'application',
		token,
		user: null,
	});
	expect(fetch).not.toHaveBeenCalled();
});
```

Update the existing successful user assertion to include `kind: 'user'`.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonOAuthService.test.ts src/server/api/mastodon/MastodonAuthenticateService.test.ts`

Expected: FAIL because `exchangeToken` and application authentication do not exist and application scopes use the wrong response type.

- [ ] **Step 3: Implement token types and client-credentials dispatch**

Define:

```ts
export type MastodonApplicationAuth = {
	kind: 'application';
	user: null;
	token: MiMastodonOAuthToken;
};

export type MastodonUserAuth = {
	kind: 'user';
	user: MiLocalUser;
	token: MiMastodonOAuthToken;
};

export type MastodonAuth = MastodonApplicationAuth | MastodonUserAuth;
```

Change `MastodonCredentialApplication.scopes` to `string[]`. Return `scopes` arrays from registration and `getApplication`.

Add grant dispatch:

```ts
public async exchangeToken(parameters: OAuthParameters, authorizationHeader?: string): Promise<MastodonTokenResponse> {
	const grantType = this.firstValue(parameters.grant_type);
	if (grantType === 'authorization_code') {
		return await this.exchangeCode(parameters, authorizationHeader);
	}
	if (grantType === 'client_credentials') {
		return await this.exchangeClientCredentials(parameters, authorizationHeader);
	}
	throw this.oauthError(400, 'unsupported_grant_type', 'grant_type is not supported');
}

private async exchangeClientCredentials(parameters: OAuthParameters, authorizationHeader?: string): Promise<MastodonTokenResponse> {
	const client = await this.authenticateClient(parameters, authorizationHeader);
	const redirectUri = this.firstValue(parameters.redirect_uri);
	if (redirectUri != null && !client.redirectUris.includes(redirectUri)) {
		throw this.oauthError(400, 'invalid_grant', 'redirect_uri does not exactly match a registered URI');
	}

	let scopes: string[];
	try {
		scopes = this.mastodonScopeService.normalize(parameters.scope, ['read']);
	} catch (error) {
		throw this.oauthError(400, 'invalid_scope', error instanceof Error ? error.message : 'scope is invalid');
	}
	if (!scopes.every(scope => this.mastodonScopeService.allows(client.scopes, scope))) {
		throw this.oauthError(400, 'invalid_scope', 'The requested scope exceeds the registered scope');
	}

	const now = new Date();
	const rawToken = generateCredential();
	await this.mastodonOAuthTokensRepository.insertOne({
		id: this.idService.gen(now.getTime()),
		tokenHash: digestCredential(rawToken),
		userId: null,
		clientId: client.id,
		scopes,
		createdAt: now,
		lastUsedAt: null,
	});
	return {
		access_token: rawToken,
		token_type: 'Bearer',
		scope: scopes.join(' '),
		created_at: Math.floor(now.getTime() / 1000),
	};
}
```

Remove the grant-type guard from the private authorization-code branch, and change `OAuth2ProviderService` to call `exchangeToken`.

In `MastodonAuthenticateService.authenticate`, return the application result immediately after updating `lastUsedAt` when `token.userId == null`. Return `{ kind: 'user', user, token }` for available users.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonOAuthService.test.ts src/server/api/mastodon/MastodonAuthenticateService.test.ts`

Expected: PASS; existing PKCE, replay, and revocation tests remain green.

- [ ] **Step 5: Commit OAuth behavior**

```bash
git add packages/backend/src/server/api/mastodon/types.ts packages/backend/src/server/api/mastodon/MastodonOAuthService.ts packages/backend/src/server/api/mastodon/MastodonOAuthService.test.ts packages/backend/src/server/api/mastodon/MastodonAuthenticateService.ts packages/backend/src/server/api/mastodon/MastodonAuthenticateService.test.ts packages/backend/src/server/oauth/OAuth2ProviderService.ts
git commit -m "feat(backend): complete Mastodon application OAuth"
```

### Task 3: Native token-manager aggregation and revocation

**Files:**
- Modify: `packages/backend/src/server/api/endpoints/i/apps.ts`
- Create: `packages/backend/src/server/api/endpoints/i/apps.test.ts`
- Modify: `packages/backend/src/server/api/endpoints/i/revoke-token.ts`
- Create: `packages/backend/src/server/api/endpoints/i/revoke-token.test.ts`

**Interfaces:**
- Preserves: the existing `i/apps` response schema.
- Produces: combined native and Mastodon user-token rows with existing sort semantics.
- Produces: ownership-checked revocation by ID or raw token.

- [ ] **Step 1: Write failing endpoint tests**

The `i/apps` test must instantiate the endpoint with mocked repositories and assert this Mastodon projection:

```ts
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
```

The revoke test must assert both ID and digest paths:

```ts
await endpoint.exec({ tokenId: 'mastodon-token-id' }, me, null);
expect(mastodonTokensRepository.delete).toHaveBeenCalledWith({
	id: 'mastodon-token-id',
	userId: me.id,
});

await endpoint.exec({ token: 'raw-mastodon-token' }, me, null);
expect(mastodonTokensRepository.delete).toHaveBeenCalledWith({
	tokenHash: digestCredential('raw-mastodon-token'),
	userId: me.id,
});
```

Also assert that `userId: null` application tokens cannot match the user-owned deletion criteria.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter backend test -- --run src/server/api/endpoints/i/apps.test.ts src/server/api/endpoints/i/revoke-token.test.ts`

Expected: FAIL because both endpoints only inject `AccessTokensRepository`.

- [ ] **Step 3: Implement aggregation and ownership checks**

Inject `MastodonOAuthTokensRepository` and `MastodonScopeService` into `i/apps`. Fetch Mastodon rows with their client relation, project them to the existing schema, combine with native rows, and sort by the selected timestamp:

```ts
const mastodonTokens = await this.mastodonOAuthTokensRepository.find({
	where: { userId: me.id },
	relations: { client: true },
});

const mastodonItems = mastodonTokens.map(token => ({
	id: token.id,
	name: token.client.name,
	createdAt: token.createdAt.toISOString(),
	lastUsedAt: token.lastUsedAt?.toISOString(),
	permission: this.mastodonScopeService.toMisskeyPermissions(token.scopes),
	iconUrl: null,
	description: token.client.website ?? 'Mastodon API',
}));
```

Keep the existing native projection. For `+createdAt`/`+lastUsedAt` sort newest first; for the corresponding `-` values sort oldest first; retain stable ID ordering for equal/null timestamps.

Inject `MastodonOAuthTokensRepository` into `i/revoke-token`. Delete directly with user ownership instead of a separate existence check:

```ts
if ('tokenId' in ps) {
	await this.accessTokensRepository.delete({ id: ps.tokenId, userId: me.id });
	await this.mastodonOAuthTokensRepository.delete({ id: ps.tokenId, userId: me.id });
} else if (ps.token) {
	await this.accessTokensRepository.delete({ token: ps.token, userId: me.id });
	await this.mastodonOAuthTokensRepository.delete({
		tokenHash: digestCredential(ps.token),
		userId: me.id,
	});
}
```

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm --filter backend test -- --run src/server/api/endpoints/i/apps.test.ts src/server/api/endpoints/i/revoke-token.test.ts`

Expected: PASS with native behavior and Mastodon ownership assertions.

- [ ] **Step 5: Commit token management**

```bash
git add packages/backend/src/server/api/endpoints/i/apps.ts packages/backend/src/server/api/endpoints/i/apps.test.ts packages/backend/src/server/api/endpoints/i/revoke-token.ts packages/backend/src/server/api/endpoints/i/revoke-token.test.ts
git commit -m "feat(backend): manage Mastodon access tokens"
```

### Task 4: Application/user/public route authentication

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiCallService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiCallService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.test.ts`

**Interfaces:**
- Produces: `MastodonApiCallService.invokePublic(name, data, auth, request)`.
- Produces route policies for any token, required user token, and optional public authentication.

- [ ] **Step 1: Write failing public/auth policy tests**

Add gateway assertions that anonymous invocation passes `null` user/token:

```ts
await service.invokePublic('notes/show', { noteId: 'note-id' }, null, request as never);
expect(invoke).toHaveBeenCalledWith(
	expect.objectContaining({ name: 'notes/show', exec }),
	null,
	null,
	{ noteId: 'note-id' },
	null,
	request,
);
```

Add Fastify injection tests for:

```ts
test('accepts an application token for app verification', async () => {
	const { fastify, authenticate, getApplication, assert } = createServer();
	authenticate.mockResolvedValue({
		kind: 'application',
		user: null,
		token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
	});
	const response = await fastify.inject({
		method: 'GET',
		url: '/api/v1/apps/verify_credentials',
		headers: { authorization: 'Bearer app-token' },
	});
	expect(response.statusCode).toBe(200);
	expect(getApplication).toHaveBeenCalledWith('client-id');
	expect(assert).not.toHaveBeenCalled();
});

test('rejects an application token on user-only routes', async () => {
	const { fastify, authenticate } = createServer();
	authenticate.mockResolvedValue({
		kind: 'application',
		user: null,
		token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
	});
	const response = await fastify.inject({
		method: 'GET',
		url: '/api/v1/accounts/verify_credentials',
		headers: { authorization: 'Bearer app-token' },
	});
	expect(response.statusCode).toBe(422);
});
```

Add public-route tests showing no Authorization skips authentication, a user token adds viewer state, and an explicitly invalid token returns 401.

Update the existing streaming fixture to return `{ kind: 'user', ... }`, then add a WebSocket upgrade test whose authenticator returns `{ kind: 'application', ... }`. Assert the client receives an HTTP 401 `unexpected-response`, and assert that no native stream/context is created.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiCallService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts src/server/api/mastodon/MastodonStreamingApiServerService.test.ts`

Expected: FAIL because public invocation and token-kind route policies do not exist, and streaming does not reject an application token before constructing user state.

- [ ] **Step 3: Implement the public gateway and auth helpers**

Add `invokePublic`:

```ts
public async invokePublic(
	name: string,
	data: Record<string, unknown>,
	auth: MastodonUserAuth | null,
	request: NativeRequest,
): Promise<unknown> {
	if (auth != null) return await this.invoke(name, data, auth, request);
	const definition = this.endpointByName.get(name);
	if (definition == null) {
		throw new MastodonApiError(500, 'server_error', `Unknown native endpoint: ${name}`);
	}
	const endpoint = this.moduleRef.get<{ exec: NativeEndpoint['exec'] }>(`ep:${name}`, { strict: false });
	return await this.apiCallService.invoke(
		{ ...definition, exec: endpoint.exec },
		null,
		null,
		data,
		null,
		request,
	);
}
```

Keep the existing `withAuth` name for user-only routes, but require `auth.kind === 'user'` before checking scope. Add:

```ts
private bearerToken(request: MastodonRequest): string | undefined {
	const authorization = request.headers.authorization;
	if (authorization == null) return undefined;
	const match = /^Bearer[ \t]+(.+)$/iu.exec(authorization);
	if (match?.[1] == null || match[1] === '') {
		throw new MastodonApiError(401, 'invalid_token', 'The access token is invalid');
	}
	return match[1];
}

private async withAnyToken<T>(request: MastodonRequest, action: (auth: MastodonAuth) => Promise<T>): Promise<T> {
	const token = this.bearerToken(request);
	if (token == null) throw new MastodonApiError(401, 'invalid_token', 'The access token is invalid');
	return await action(await this.mastodonAuthenticateService.authenticate(token));
}

private async withOptionalUser<T>(
	request: MastodonRequest,
	scope: string,
	action: (auth: MastodonUserAuth | null) => Promise<T>,
): Promise<T> {
	const token = this.bearerToken(request);
	if (token == null) return await action(null);
	const auth = await this.mastodonAuthenticateService.authenticate(token);
	if (auth.kind === 'application') return await action(null);
	this.mastodonScopeService.assert(auth.token.scopes, scope);
	return await action(auth);
}
```

Use `withAnyToken` for `apps/verify_credentials`. Continue rejecting REST query-string tokens.

Keep streaming user-token-only: type `ConnectionContext.auth` and `assertScopes` as `MastodonUserAuth`, and immediately reject the upgrade with 401 when `authenticate()` returns `kind: 'application'`. This check must happen before reading `auth.user`, registering request context, or creating `MainStreamConnection`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiCallService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts src/server/api/mastodon/MastodonStreamingApiServerService.test.ts`

Expected: PASS for application, user, anonymous, invalid-token, case-insensitive Bearer, and application-token streaming rejection cases.

- [ ] **Step 5: Commit route authentication**

```bash
git add packages/backend/src/server/api/mastodon/MastodonApiCallService.ts packages/backend/src/server/api/mastodon/MastodonApiCallService.test.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.ts packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.test.ts
git commit -m "fix(backend): align Mastodon route authentication"
```

### Task 5: Core account, status, timeline, poll, and media contracts

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`

**Interfaces:**
- Produces public batch/account/status routes, account search, poll retrieval, and media deletion.
- Preserves user-only home/list timelines and all existing write scope checks.

- [ ] **Step 1: Add failing route contract tests**

Cover these exact requests:

```ts
await fastify.inject({ method: 'GET', url: '/api/v1/accounts?id[]=user-a&id[]=user-b' });
await fastify.inject({ method: 'GET', url: '/api/v1/statuses?id[]=note-a&id[]=note-b' });
await fastify.inject({
	method: 'GET',
	url: '/api/v1/accounts/search?q=alice&limit=5',
	headers: { authorization: 'Bearer user-token' },
});
await fastify.inject({ method: 'GET', url: '/api/v1/polls/note-with-poll' });
await fastify.inject({
	method: 'DELETE',
	url: '/api/v1/media/file-id',
	headers: { authorization: 'Bearer user-token' },
});
```

Assert public account/status reads call `invokePublic` without authentication. Assert `only_media=true` sends `withFiles: true`, `pinned=true` uses the account's `pinnedNotes`, and `remote=true` returns 422 because Misskey has no equivalent remote-only timeline.

Add the scheduled-post safety test:

```ts
const response = await fastify.inject({
	method: 'POST',
	url: '/api/v1/statuses',
	headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
	payload: { status: 'later', scheduled_at: '2099-01-01T00:00:00.000Z' },
});
expect(response.statusCode).toBe(422);
expect(nativeInvoke).not.toHaveBeenCalledWith('notes/create', expect.anything(), expect.anything(), expect.anything());
```

Assert deleted statuses include top-level `text` and retain `media_attachments`/`poll`.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts src/server/api/mastodon/MastodonEntityService.test.ts`

Expected: FAIL on missing routes, authenticated public endpoints, poll visibility, and scheduled-post handling.

- [ ] **Step 3: Implement the routes with native endpoint mappings**

Use the following mappings:

| Mastodon operation | Native Misskey operation |
| --- | --- |
| batch accounts | one `users/show` per unique ID |
| batch statuses | one `notes/show` per unique ID |
| account search | `users/search` with `query`, `limit`, and `offset` |
| public account statuses | `users/notes` |
| public/local timeline | `notes/global-timeline` / `notes/local-timeline` |
| hashtag timeline | `notes/search-by-tag` |
| get poll | `notes/show` then entity poll conversion |
| delete media | `drive/files/delete` |

Register batch routes before `/api/v1/accounts/:id` and `/api/v1/statuses/:id`. De-duplicate IDs, cap batches at 40, retain input order, omit only 404/inaccessible records, and rethrow server/rate-limit errors.

Change public account/status/timeline handlers to `withOptionalUser` and `invokePublic`. Change `statusesWithState` to accept `MastodonUserAuth | null`:

```ts
private async statusesWithState(notes: Packed<'Note'>[], auth: MastodonUserAuth | null): Promise<Record<string, unknown>[]> {
	if (notes.length === 0) return [];
	if (auth == null) return notes.map(note => this.mastodonEntityService.status(note));
	const noteIds = [...new Set(notes.map(note => note.id))];
	const [renotes, favorites, pinings] = await Promise.all([
		this.notesRepository.findBy({ userId: auth.user.id, renoteId: In(noteIds) }),
		this.noteFavoritesRepository.findBy({ userId: auth.user.id, noteId: In(noteIds) }),
		this.userNotePiningsRepository.findBy({ userId: auth.user.id, noteId: In(noteIds) }),
	]);
	const renotedIds = new Set(renotes.flatMap(renote => renote.renoteId == null || !this.isPureRenote(renote) ? [] : [renote.renoteId]));
	const bookmarkedIds = new Set(favorites.map(favorite => favorite.noteId));
	const pinnedIds = new Set(pinings.map(pining => pining.noteId));
	return notes.map(note => ({
		...this.mastodonEntityService.status(note),
		reblogged: renotedIds.has(note.id),
		bookmarked: bookmarkedIds.has(note.id),
		pinned: pinnedIds.has(note.id),
	}));
}
```

Make the entity poll converter public:

```ts
public poll(noteId: string, poll: NonNullable<Packed<'Note'>['poll']>) {
	const votesCount = poll.choices.reduce((total, choice) => total + choice.votes, 0);
	const ownVotes = poll.choices.flatMap((choice, index) => choice.isVoted ? [index] : []);
	return {
		id: noteId,
		expires_at: poll.expiresAt,
		expired: poll.expiresAt != null && new Date(poll.expiresAt).getTime() <= Date.now(),
		multiple: poll.multiple,
		votes_count: votesCount,
		voters_count: votesCount,
		voted: ownVotes.length > 0,
		own_votes: ownVotes,
		options: poll.choices.map(choice => ({ title: choice.text, votes_count: choice.votes })),
		emojis: [],
	};
}
```

At the start of `createStatus`:

```ts
const scheduledAt = this.string(request.body?.scheduled_at);
if (scheduledAt != null && scheduledAt !== '') {
	throw new MastodonApiError(422, 'unprocessable_entity', 'Scheduled statuses are not supported');
}
```

For status deletion, return `{ ...status, text: note.text ?? '' }`. Preserve converted poll/media fields already present on `status`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts src/server/api/mastodon/MastodonEntityService.test.ts`

Expected: PASS for all added routes and existing compose/interaction cases.

- [ ] **Step 5: Commit core API compatibility**

```bash
git add packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts packages/backend/src/server/api/mastodon/MastodonEntityService.ts packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts
git commit -m "feat(backend): expand core Mastodon API contracts"
```

### Task 6: Notification filters and bounded single-dismiss state

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonNotificationService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonNotificationService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`

**Interfaces:**
- Produces: `toMisskeyTypes(types: readonly string[]): MiNotification['type'][]`.
- Produces: `dismiss(userId, notificationId)` and `filterDismissed(userId, notifications)`.
- Redis key: `mastodon-api:dismissed-notifications:<userId>`, 90-day TTL, maximum 1000 IDs.

- [ ] **Step 1: Write failing notification service and route tests**

```ts
test('maps Mastodon notification filters to Misskey types', () => {
	expect(service.toMisskeyTypes(['mention', 'favourite', 'reblog', 'follow_request'])).toEqual([
		'mention',
		'reply',
		'note',
		'quote',
		'reaction',
		'reaction:grouped',
		'renote',
		'renote:grouped',
		'receiveFollowRequest',
	]);
});

test('stores a bounded expiring user-scoped dismissal', async () => {
	await service.dismiss('user-id', 'notification-id');
	expect(redis.zadd).toHaveBeenCalledWith(
		'mastodon-api:dismissed-notifications:user-id',
		expect.any(Number),
		'notification-id',
	);
	expect(redis.zremrangebyrank).toHaveBeenCalledWith(
		'mastodon-api:dismissed-notifications:user-id',
		0,
		-1001,
	);
	expect(redis.expire).toHaveBeenCalledWith(
		'mastodon-api:dismissed-notifications:user-id',
		90 * 24 * 60 * 60,
	);
});
```

Route tests must assert `types[]=mention` and `exclude_types[]=follow` become native `includeTypes`/`excludeTypes`, `account_id` filters converted results, and `POST /api/v1/notifications/:id/dismiss` hides that ID from list and single reads.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonNotificationService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts`

Expected: FAIL because the service and dismiss route do not exist and query filters are ignored.

- [ ] **Step 3: Implement notification mapping and dismissal**

Create an SPDX-headed `@Injectable()` service. Its mapping table is:

```ts
private readonly misskeyTypes: Readonly<Record<string, MiNotification['type'][]>> = {
	mention: ['mention', 'reply', 'note', 'quote'],
	status: ['note'],
	reblog: ['renote', 'renote:grouped'],
	favourite: ['reaction', 'reaction:grouped'],
	follow: ['follow', 'followRequestAccepted'],
	follow_request: ['receiveFollowRequest'],
	poll: ['pollEnded'],
};
```

Implement dismissal:

```ts
public async dismiss(userId: string, notificationId: string): Promise<void> {
	const key = this.key(userId);
	const now = Date.now();
	await this.redis.zadd(key, now, notificationId);
	await this.redis.zremrangebyscore(key, 0, now - 90 * 24 * 60 * 60 * 1000);
	await this.redis.zremrangebyrank(key, 0, -1001);
	await this.redis.expire(key, 90 * 24 * 60 * 60);
}

public async filterDismissed<T extends { id: string }>(userId: string, values: readonly T[]): Promise<T[]> {
	const key = this.key(userId);
	const scores = await Promise.all(values.map(value => this.redis.zscore(key, value.id)));
	return values.filter((_value, index) => scores[index] == null);
}
```

Register the service in `ServerModule`. Pass mapped include/exclude arrays to `i/notifications`, filter converted notifications by `account_id`, then apply `filterDismissed`. Add the dismiss route with `write:notifications` scope and return `{}`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonNotificationService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts`

Expected: PASS with bounded Redis calls and route filtering.

- [ ] **Step 5: Commit notification compatibility**

```bash
git add packages/backend/src/server/api/mastodon/MastodonNotificationService.ts packages/backend/src/server/api/mastodon/MastodonNotificationService.test.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts packages/backend/src/server/ServerModule.ts
git commit -m "feat(backend): complete Mastodon notification controls"
```

### Task 7: Emoji, instance rules, and truthful capability discovery

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`

**Interfaces:**
- Produces real custom emoji and rule collections.
- Advertises `api_versions.mastodon = 1` and `4.3.0 (compatible; Misskey <version>)`.

- [ ] **Step 1: Write failing discovery tests**

Assert:

```ts
expect(instance.json()).toMatchObject({
	version: '4.3.0 (compatible; Misskey 2026.7.0)',
	api_versions: { mastodon: 1 },
	rules: [
		{ id: '1', text: 'Be kind', hint: '' },
	],
});
expect(rules.json()).toEqual([
	{ id: '1', text: 'Be kind', hint: '' },
]);
expect(emojis.json()).toEqual([
	expect.objectContaining({
		shortcode: 'blobcat',
		url: 'https://misskey.example/files/blobcat.png',
		static_url: 'https://misskey.example/files/blobcat.png',
		visible_in_picker: true,
	}),
]);
```

Assert `GET /api/v1/custom_emojis` and `GET /api/v1/instance/rules` are public and reject an explicitly invalid Authorization token.

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts`

Expected: FAIL because emoji/rules are empty and the instance claims API version 4.

- [ ] **Step 3: Implement real discovery responses**

Map `MiMeta.serverRules`:

```ts
private rules(): Array<{ id: string; text: string; hint: string }> {
	return this.meta.serverRules.map((text, index) => ({
		id: (index + 1).toString(),
		text,
		hint: '',
	}));
}
```

For custom emoji, anonymously invoke `emojis` and map `response.emojis`:

```ts
return emojis.map(emoji => ({
	shortcode: emoji.name,
	url: emoji.url,
	static_url: emoji.url,
	visible_in_picker: true,
	category: emoji.category ?? null,
}));
```

Use `meta.bannerUrl ?? meta.iconUrl ?? new URL('/favicon.ico', config.url).toString()` for a non-null discovery image. Add `configuration.accounts.max_pinned_statuses` and expose rules in both instance versions.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts`

Expected: PASS for version, rules, emoji, icon fallback, and public auth semantics.

- [ ] **Step 5: Commit truthful discovery**

```bash
git add packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts
git commit -m "fix(backend): report Mastodon capabilities accurately"
```

### Task 8: Generated API artifacts, release note, review, and verification

**Files:**
- Modify: `CHANGELOG.md`
- Regenerate when changed: `packages/misskey-js/src/autogen/` and `packages/misskey-js/etc/misskey-js.api.md`

**Interfaces:**
- Produces a validated, reviewable Misskey change with no locale modifications.

- [ ] **Step 1: Add the user-facing server changelog entry**

Under `## Unreleased` / `### Server` add:

```markdown
- Enhance: Improve Mastodon OAuth application-token support, access-token management, and core API compatibility
```

- [ ] **Step 2: Regenerate native API artifacts**

Run: `pnpm build-misskey-js-with-types`

Expected: command exits 0. Review generated changes; `i/apps` and `i/revoke-token` types remain compatible.

- [ ] **Step 3: Run the focused unit and route suite**

Run:

```bash
pnpm --filter backend test -- --run test/unit/mastodon-oauth-token-migration.ts src/server/api/mastodon src/server/api/endpoints/i/apps.test.ts src/server/api/endpoints/i/revoke-token.test.ts
```

Expected: all Mastodon, migration, and token-manager test files pass with no warnings or unhandled rejections.

- [ ] **Step 4: Run backend static and migration validation**

Run:

```bash
pnpm --filter backend lint
pnpm --filter backend check-migrations
```

Expected: both commands exit 0; migration checker reports no pending DDL. Do not run `test:e2e`.

- [ ] **Step 5: Run repository validation**

Run:

```bash
pnpm lint
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 6: Verify SPDX, locale safety, migration scope, and secrets**

Run PowerShell checks against the design commit baseline:

```powershell
git diff --name-only d54000a26d -- 'locales/*.yml'
git diff --name-only --diff-filter=A d54000a26d
git diff d54000a26d -- packages/backend/migration packages/backend/src/models/MastodonOAuthToken.ts
git diff d54000a26d | Select-String -Pattern '(client_secret|access_token|authorization).*[:=].*[A-Za-z0-9_-]{32,}' -CaseSensitive:$false
```

Expected:

- locale output is empty;
- every new AGPL file listed has the SPDX header;
- migration/entity diff changes only compatibility token nullability;
- secret scan finds only test fixtures, field names, and generated random-token handling, never a real credential.

- [ ] **Step 7: Request the required API review**

Dispatch the repository's `misskey-api-reviewer` review agent with the diff from `d54000a26d` and ask it to check route registration, Mastodon/native scope separation, `i/apps` response compatibility, misskey-js regeneration, and migration reversibility. Address every actionable finding with a new failing test before changing production code.

- [ ] **Step 8: Re-run affected tests after review fixes**

Run the focused command from Step 3 plus `pnpm --filter backend lint`.

Expected: all pass after review changes.

- [ ] **Step 9: Commit final generated/documentation changes**

```bash
git add CHANGELOG.md packages/misskey-js
git commit -m "chore: finalize Mastodon API compatibility"
```

- [ ] **Step 10: Inspect the final range**

Run:

```bash
git status --short
git log --oneline d54000a26d..HEAD
git diff --stat d54000a26d
```

Expected: clean worktree; commits correspond to the eight tasks; diff contains only the approved migration, backend compatibility implementation/tests, generated API files if changed, and CHANGELOG entry.
