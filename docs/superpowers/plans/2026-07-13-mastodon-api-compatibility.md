# Mastodon API Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated Mastodon API and OAuth compatibility layer that lets Misskey users sign into Elk, Phanpy, Tusky, and similar clients without changing native Misskey API, MiAuth, token, or URL-client OAuth behavior.

**Architecture:** A dedicated Fastify/NestJS compatibility module owns Mastodon REST and WebSocket routes. Opaque registered clients share the `/oauth` entry paths through explicit client-ID dispatch, while separate database entities and Redis records isolate Mastodon credentials from native credentials. Compatibility routes reuse `ApiCallService` policy enforcement through a narrow internal invocation interface and translate packed Misskey responses into Mastodon entities.

**Tech Stack:** TypeScript, NestJS, Fastify 5, TypeORM/PostgreSQL, ioredis, ws, Vitest, existing Misskey endpoint executors and entity packers.

## Global Constraints

- Keep existing `/api/<misskey-endpoint>`, MiAuth, native bearer-token, and URL-client OAuth response and validation behavior unchanged.
- URL-client OAuth continues to require PKCE S256 and remote client-information discovery.
- Mastodon clients and tokens use separate storage and cannot authenticate native APIs; native tokens cannot authenticate Mastodon APIs.
- The compatibility layer is always enabled on this branch and adds no administrator setting or locale key.
- First release excludes background Web Push and the push-subscription API.
- Every new backend TypeScript file and migration carries the repository AGPL SPDX header.
- Edit no locale other than `locales/ja-JP.yml`; this change requires no locale edit.
- Add a `CHANGELOG.md` Unreleased Server entry.

---

## File Structure

Create focused files under `packages/backend/src/server/api/mastodon/`:

- `types.ts`: Mastodon request/entity/auth types used across the module.
- `MastodonScopeService.ts`: scope normalization, hierarchy, and Misskey permission derivation.
- `MastodonAuthenticateService.ts`: compatibility bearer-token digest lookup and local-user loading.
- `MastodonOAuthService.ts`: dynamic registration, authorization transactions/codes, exchange, and revocation.
- `MastodonApiCallService.ts`: endpoint resolution and policy-preserving native invocation.
- `MastodonEntityService.ts`: Account, Status, Notification, Relationship, Attachment, Poll, and List conversion.
- `MastodonPaginationService.ts`: cursor translation, limit clamping, and Link headers.
- `MastodonApiServerService.ts`: route registration and request/response translation.
- `MastodonStreamingApiServerService.ts`: Mastodon WebSocket upgrade handling and Redis stream translation.
- `errors.ts`: typed Mastodon HTTP/OAuth errors and Fastify response helpers.
- `utils.ts`: constant-time digest helpers, form/array parsing, visibility mapping, and redirect validation.

Create model and migration files:

- `packages/backend/src/models/MastodonOAuthClient.ts`
- `packages/backend/src/models/MastodonOAuthToken.ts`
- `packages/backend/migration/1783956161436-mastodon-api-compatibility.js`

Create focused tests:

- `packages/backend/src/server/api/mastodon/MastodonScopeService.test.ts`
- `packages/backend/src/server/api/mastodon/utils.test.ts`
- `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- `packages/backend/test/e2e/mastodon-api.ts`

Modify integration points:

- `packages/backend/src/models/_.ts`
- `packages/backend/src/models/RepositoryModule.ts`
- `packages/backend/src/postgres.ts`
- `packages/backend/src/di-symbols.ts`
- `packages/backend/src/server/api/ApiCallService.ts`
- `packages/backend/src/server/oauth/OAuth2ProviderService.ts`
- `packages/backend/src/server/WellKnownServerService.ts` only if metadata routing needs no OAuth-service change
- `packages/backend/src/server/ServerModule.ts`
- `packages/backend/src/server/ServerService.ts`
- `packages/backend/test/e2e/oauth.ts`
- `CHANGELOG.md`

---

### Task 1: Persistence and cryptographic utilities

**Files:**
- Create: `packages/backend/src/models/MastodonOAuthClient.ts`
- Create: `packages/backend/src/models/MastodonOAuthToken.ts`
- Create: `packages/backend/migration/1783956161436-mastodon-api-compatibility.js`
- Create: `packages/backend/src/server/api/mastodon/utils.ts`
- Test: `packages/backend/src/server/api/mastodon/utils.test.ts`
- Modify: `packages/backend/src/models/_.ts`
- Modify: `packages/backend/src/models/RepositoryModule.ts`
- Modify: `packages/backend/src/postgres.ts`
- Modify: `packages/backend/src/di-symbols.ts`

**Interfaces:**
- Produces: `MiMastodonOAuthClient`, `MiMastodonOAuthToken`, their repository DI symbols, `generateCredential()`, `digestCredential(value)`, `timingSafeDigestEqual(value, digest)`, `parseRedirectUris(value)`, and `validateRedirectUri(value)`.
- Consumes: `IdService`, `MiUser`, TypeORM entity decorators, Node `crypto`.

- [ ] **Step 1: Write failing utility tests**

```ts
test('generated credentials round-trip only through their digest', () => {
	const credential = generateCredential();
	const digest = digestCredential(credential);
	expect(credential).toHaveLength(64);
	expect(timingSafeDigestEqual(credential, digest)).toBe(true);
	expect(timingSafeDigestEqual(`${credential}x`, digest)).toBe(false);
});

test.each(['javascript:alert(1)', 'data:text/plain,x', 'file:///tmp/x', 'https://u:p@example.com/cb#x'])(
	'rejects unsafe redirect %s', value => expect(() => validateRedirectUri(value)).toThrow(),
);
```

- [ ] **Step 2: Run the focused test and confirm red**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/utils.test.ts`

Expected: FAIL because `utils.ts` and its exports do not exist.

- [ ] **Step 3: Implement utilities and entities**

Use 32 random bytes encoded as hex and SHA-256 encoded as hex:

```ts
export function generateCredential(): string {
	return randomBytes(32).toString('hex');
}

export function digestCredential(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}
```

Define clients with `id`, `secretHash`, `name`, nullable `website`, `redirectUris`, `scopes`, and `createdAt`. Define tokens with `id`, `tokenHash`, `userId`, `clientId`, `scopes`, `createdAt`, and nullable `lastUsedAt`. Add cascade foreign keys in both entity metadata and migration. Migration `down()` drops token before client.

- [ ] **Step 4: Run utility tests and migration check**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/utils.test.ts`

Expected: PASS.

Run: `pnpm --filter backend check-migrations`

Expected: exit 0 with no pending schema DDL after migrations are applied by the checker.

---

### Task 2: Scope hierarchy, authentication, and native endpoint gateway

**Files:**
- Create: `packages/backend/src/server/api/mastodon/types.ts`
- Create: `packages/backend/src/server/api/mastodon/errors.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonScopeService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonAuthenticateService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonApiCallService.ts`
- Test: `packages/backend/src/server/api/mastodon/MastodonScopeService.test.ts`
- Modify: `packages/backend/src/server/api/ApiCallService.ts`

**Interfaces:**
- Produces: `MastodonAuth { user: MiLocalUser; token: MiMastodonOAuthToken }`, `MastodonScopeService.assert(tokenScopes, requiredScope)`, `MastodonScopeService.toMisskeyPermissions(scopes)`, `MastodonApiCallService.invoke(name, params, auth, request, file?)`.
- Consumes: repository DI from Task 1, `CacheService`, `ModuleRef`, endpoint-list metadata, `ApiCallService.invoke`.

- [ ] **Step 1: Write scope tests**

```ts
expect(service.allows(['read'], 'read:statuses')).toBe(true);
expect(service.allows(['read:accounts'], 'read:statuses')).toBe(false);
expect(service.allows(['follow'], 'write:follows')).toBe(true);
expect(service.toMisskeyPermissions(['write:statuses'])).toContain('write:notes');
expect(service.toMisskeyPermissions(['read:notifications'])).toEqual(['read:notifications']);
```

- [ ] **Step 2: Run and confirm red**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonScopeService.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the scope service and auth lookup**

Declare route-level granular scopes. Treat `read` and `write` as parents by prefix, and map deprecated `follow` only to follow read/write scopes. Token lookup hashes the incoming value, queries the compatibility-token repository, updates `lastUsedAt`, loads the local user cache, and rejects missing/deleted/suspended users.

- [ ] **Step 4: Add the policy-preserving internal invocation API**

Refactor the private `ApiCallService.call` body to a public method without changing its callers:

```ts
public invoke(
	ep: IEndpoint & { exec: IEndpoint['exec'] },
	user: MiLocalUser | null,
	token: MiAccessToken | null,
	data: unknown,
	file: { name: string; path: string } | null,
	request: FastifyRequest,
): Promise<unknown> {
	return this.call(ep, user, token, data, file, request);
}
```

`MastodonApiCallService` resolves `ep:${name}`, supplies the definition from `endpoint-list`, and constructs an unpersisted token with only mapped permissions.

- [ ] **Step 5: Run scope tests and existing API tests**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonScopeService.test.ts`

Expected: PASS.

Run: `pnpm --filter backend test:e2e -- --runInBand api.ts`

Expected: existing API authentication and permission cases pass.

---

### Task 3: Dynamic registration and dual OAuth strategy

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonOAuthService.ts`
- Modify: `packages/backend/src/server/oauth/OAuth2ProviderService.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`
- Modify: `packages/backend/test/e2e/oauth.ts`
- Test: `packages/backend/test/e2e/mastodon-api.ts`

**Interfaces:**
- Produces: `registerApplication(body)`, `resolveRegisteredAuthorization(params)`, `approveRegisteredAuthorization(transaction, user)`, `exchangeRegisteredCode(body)`, `revoke(body)`, `authenticateClient(id, secret)`.
- Consumes: Task 1 repositories/utilities, Redis, `OAuthPage`, existing OAuth error types, Task 2 scope service.

- [ ] **Step 1: Add failing e2e registration and OAuth tests**

Cover JSON registration (Elk), form registration (Phanpy/Tusky), exact redirect matching, unsafe redirect rejection, secret mismatch, confidential flow without PKCE, S256 flow with PKCE, state propagation, code reuse, and revoke.

Use the existing OAuth e2e login helper to submit `/oauth/decision`; assert that a registered opaque client succeeds while an unknown opaque client fails and an existing URL client still requires PKCE.

- [ ] **Step 2: Run focused OAuth tests and confirm red**

Run: `pnpm --filter backend test:e2e -- --runInBand oauth.ts mastodon-api.ts`

Expected: new registration routes are 404 and registered authorization fails.

- [ ] **Step 3: Implement registration and Redis records**

Store transactions and codes as JSON with `SET key value EX 300`. Consume codes with `GETDEL`; bind stored records to client, redirect, user, scopes, and optional challenge. For the rare issue-race, store the created token ID in a short-lived reuse marker and delete it when reuse is detected.

- [ ] **Step 4: Split OAuth client resolution without changing URL-client validation**

Add an explicit discriminated result:

```ts
type ResolvedOAuthClient =
	| { kind: 'url'; seed: AuthorizationRequestSeed }
	| { kind: 'mastodon'; seed: MastodonAuthorizationSeed };
```

Attempt `validateClientId` only for URL-shaped identifiers. Opaque identifiers are exact database lookups. Keep the current `#resolveAuthorizationRequest`, `#finalizeAuthorizationRequest`, grant cache, and token insertion for `kind: 'url'`; delegate only `kind: 'mastodon'` to the new service.

- [ ] **Step 5: Add `/oauth/revoke` and metadata additions**

Register form parsing, no-store headers, and Mastodon error bodies. Add `app_registration_endpoint` and the union of native and Mastodon scopes to RFC 8414 metadata without removing existing properties.

- [ ] **Step 6: Run OAuth regression and compatibility tests**

Run: `pnpm --filter backend test:e2e -- --runInBand oauth.ts mastodon-api.ts`

Expected: all original OAuth tests plus new registered-client tests pass.

---

### Task 4: Entity conversion and pagination

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonPaginationService.ts`
- Test: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`

**Interfaces:**
- Produces: `account(user, viewer?)`, `status(note, viewer?)`, `notification(value, viewer)`, `relationship(relation)`, `attachment(file)`, `poll(note.poll)`, `list(value)`, `toMisskeyCursor(query)`, and `applyLinkHeader(reply, request, items)`.
- Consumes: packed Misskey response types, `MfmService`, `UserEntityService`, `NoteEntityService`, config, request-local memo maps.

- [ ] **Step 1: Add converter fixture tests**

Test local versus remote `acct`, `home` to `unlisted`, `followers` to `private`, renote to `reblog`, CW, mentions, hashtags, custom emoji, media, poll, current-user reaction/bookmark state, and opaque alphanumeric IDs.

- [ ] **Step 2: Run and confirm red**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts`

Expected: FAIL because converter and paginator do not exist.

- [ ] **Step 3: Implement converters with a per-request memo**

Use existing MFM parsing/rendering and sanitation. Do not mutate packed Misskey objects. Convert pure renotes recursively into `reblog`, and cap recursion at one nested reblog because Mastodon does not recursively reblog reblogs.

- [ ] **Step 4: Implement opaque cursor translation and Link headers**

Map `max_id` to `untilId`, `since_id`/`min_id` to `sinceId`, clamp limits, and build URLs through WHATWG `URL` and `URLSearchParams`. Never compare IDs numerically.

- [ ] **Step 5: Run converter tests**

Run: `pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts`

Expected: PASS.

---

### Task 5: Discovery and login-initialization REST routes

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`
- Modify: `packages/backend/src/server/ServerService.ts`
- Test: `packages/backend/test/e2e/mastodon-api.ts`

**Interfaces:**
- Produces: Fastify routes for apps, instance v1/v2, custom emoji, preferences, empty filters, announcements, and verify credentials.
- Consumes: Tasks 2-4 services, `DI.meta`, `DI.config`, emoji/announcement repositories.

- [ ] **Step 1: Add failing Elk/Phanpy/Tusky initialization tests**

After obtaining a compatibility token, call the exact sequences used by the three clients: v2 instance with v1 fallback, verify credentials, preferences, filters v1/v2, custom emojis, and announcements. Assert Mastodon-shaped required fields.

- [ ] **Step 2: Run and confirm red**

Run: `pnpm --filter backend test:e2e -- --runInBand mastodon-api.ts`

Expected: discovery and initialization endpoints return 404.

- [ ] **Step 3: Register the service and implement routes**

Use a local form parser only where necessary, CORS matching the native public API, `Cache-Control: no-store` for authenticated responses, and Task 2 authentication/scope guards. Do not register `/api/v1/instance/peers` twice.

- [ ] **Step 4: Run initialization tests**

Run: `pnpm --filter backend test:e2e -- --runInBand mastodon-api.ts`

Expected: all three initialization sequences pass.

---

### Task 6: Core timelines, statuses, media, interactions, and polls

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiCallService.ts`
- Test: `packages/backend/test/e2e/mastodon-api.ts`

**Interfaces:**
- Produces: home/public/tag/list timelines; status read/context/source; create/update/delete; favourite, reblog, bookmark, pin pairs; media v1/v2; poll vote.
- Consumes: native endpoints including `notes/timeline`, `notes/hybrid-timeline`, `notes/local-timeline`, `notes/global-timeline`, `notes/show`, `notes/conversation`, `notes/children`, `notes/create`, `notes/update`, `notes/delete`, `notes/unrenote`, `notes/reactions/create`, `notes/reactions/delete`, `notes/favorites/create`, `notes/favorites/delete`, `i/pin`, `i/unpin`, `notes/polls/vote`, `drive/files/create`, `drive/files/show`, and `drive/files/update`.

- [ ] **Step 1: Add failing core-flow e2e tests**

Create users and notes with existing test helpers. Assert cursor behavior, visibility mapping, reply context, compose with CW/media/poll, idempotency-key retry, delete, favourite/unfavourite, reblog/unreblog, bookmark/unbookmark, pin/unpin, and poll voting.

- [ ] **Step 2: Run and confirm red**

Run: `pnpm --filter backend test:e2e -- --runInBand mastodon-api.ts`

Expected: core route tests fail with 404.

- [ ] **Step 3: Implement read routes and pagination**

Use only Task 2 gateway calls for user-sensitive reads. Convert every result through one request-scoped `MastodonEntityService` context and apply `Link` headers.

- [ ] **Step 4: Implement writes and idempotency**

Map Mastodon form/JSON fields to native parameters. Cache successful status-create responses under `mastodon:idempotency:<token-id>:<key>` with `SET NX EX 86400`. A repeated key returns the same converted status.

- [ ] **Step 5: Implement multipart media through the existing native file path**

Write uploaded streams to the existing temporary-file helper, invoke `drive/files/create`, and guarantee cleanup on success/error. Update description/focus only on unattached files.

- [ ] **Step 6: Run core tests**

Run: `pnpm --filter backend test:e2e -- --runInBand mastodon-api.ts`

Expected: core flow tests pass.

---

### Task 7: Accounts, notifications, search, and lists

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Test: `packages/backend/test/e2e/mastodon-api.ts`

**Interfaces:**
- Produces: account/profile/status/follower/following routes, relation actions, blocks/mutes/follow requests, notification routes, search v2, and list CRUD/membership/timeline support.
- Consumes: native user, relation, following, blocking, muting, notification, search, and user-list endpoints through Task 2 gateway.

- [ ] **Step 1: Add failing account and relationship tests**

Cover local/remote lookup, account statuses, relationship arrays, follow/unfollow, block/unblock, mute/unmute, and follow-request accept/reject.

- [ ] **Step 2: Add failing notification/search/list tests**

Cover supported notification filtering, single notification, clear, account/status/hashtag search, list CRUD, membership, and list timeline.

- [ ] **Step 3: Implement account and relation routes**

Translate Rails-style array keys such as `id[]` and `account_ids[]`. Return conservative false/null values for relationship fields Misskey does not model.

- [ ] **Step 4: Implement notification, search, and list routes**

Omit unsupported Misskey notification types. Convert reaction notifications to `favourite` and renotes to `reblog`. Preserve native search visibility restrictions.

- [ ] **Step 5: Run compatibility e2e tests**

Run: `pnpm --filter backend test:e2e -- --runInBand mastodon-api.ts`

Expected: account, notification, search, and list tests pass.

---

### Task 8: Foreground WebSocket streaming

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.ts`
- Modify: `packages/backend/src/server/api/StreamingApiServerService.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`
- Modify: `packages/backend/src/server/ServerService.ts`
- Test: `packages/backend/test/e2e/mastodon-api.ts`

**Interfaces:**
- Produces: `attach(http.Server)`, `detach()`, user/public/local/tag/list subscriptions and Mastodon event envelopes.
- Consumes: Task 2 authentication, Task 4 conversion, `DI.redisForSub`, Misskey pub/sub channel names, `ws`.

- [ ] **Step 1: Add failing WebSocket tests**

Assert invalid-token rejection, user-stream update and notification, public/local filtering, tag filtering, list filtering, delete events, ping/pong cleanup, and shutdown detach.

- [ ] **Step 2: Run and confirm red**

Run: `pnpm --filter backend test:e2e -- --runInBand mastodon-api.ts`

Expected: upgrade requests to `/api/v1/streaming` are not handled.

- [ ] **Step 3: Implement path-gated upgrade handling**

First gate the existing native listener to the exact `/streaming` path, preserving all behavior after that check. The new listener must immediately return without touching sockets for paths it does not own, so the two WebSocket servers cannot race for the same socket. Authenticate header or `access_token` query values, validate stream parameters, and use bounded send buffering.

- [ ] **Step 4: Translate Redis events and clean up**

Subscribe only to the channel set needed by each connection. Emit `{ event, payload, stream }` JSON. Remove Redis/event listeners and intervals on close and detach.

- [ ] **Step 5: Run streaming and native streaming tests**

Run: `pnpm --filter backend test:e2e -- --runInBand mastodon-api.ts streaming.ts`

Expected: both Mastodon and native streaming suites pass.

---

### Task 9: Documentation, full regression validation, commit, and push

**Files:**
- Modify: `CHANGELOG.md`
- Review: all files changed by Tasks 1-8

**Interfaces:**
- Produces: validated, documented branch commits pushed to `origin/pari-dev`.
- Consumes: all earlier tasks.

- [ ] **Step 1: Add the changelog entry**

Under `## Unreleased` -> `### Server`, add:

```md
- Feat: Mastodon API互換レイヤーを追加し、対応クライアントからMisskeyアカウントを利用できるように
```

- [ ] **Step 2: Run focused and required validation**

Run:

```text
pnpm --filter backend test -- --run src/server/api/mastodon
pnpm --filter backend test:e2e -- --runInBand oauth.ts mastodon-api.ts streaming.ts api.ts
pnpm --filter backend check-migrations
pnpm --filter backend typecheck
pnpm lint
```

Expected: every command exits 0. If full `pnpm lint` exposes a pre-existing unrelated failure, record it with the focused validation results and do not conceal it.

- [ ] **Step 3: Run repository safety checks**

Run `git diff --check`, verify every new TS/JS file has SPDX headers, confirm no locale other than `ja-JP.yml` changed, inspect `git diff --stat` and `git status --short`, and scan changed text for private keys, bearer tokens, passwords, and production configuration.

- [ ] **Step 4: Commit intentionally**

Stage only files belonging to this change and commit without bypassing hooks:

```text
git commit -m "feat(backend): add Mastodon API compatibility"
```

- [ ] **Step 5: Push the current branch**

Run: `git push origin pari-dev`

Expected: the remote updates without force.
