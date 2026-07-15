# Mastodon API Compatibility Follow-up Design

**Status:** Approved on 2026-07-15

## Context

The branch already contains an isolated Mastodon REST, streaming, and OAuth compatibility layer. It supports the authorization-code flow and many common user endpoints, but it has three protocol-level gaps:

- Mastodon OAuth user tokens are stored separately from native Misskey access tokens, while `i/apps` and `i/revoke-token` only operate on the native table. Authorized Mastodon clients therefore do not appear in the existing access-token management page.
- Mastodon clients can obtain a client-credentials application token and use either an application token or a user token with `GET /api/v1/apps/verify_credentials`. The current implementation only issues and authenticates user tokens.
- The instance document advertises Mastodon API version 4 even though several versioned capabilities are not implemented. Some public endpoints also require a user token despite being public in the Mastodon contract.

This follow-up is contract-driven rather than tied to a particular third-party client failure report. Validation intentionally excludes backend end-to-end tests at the user's request.

## Goals

- Complete the application-token OAuth flow needed by conventional Mastodon clients.
- Show and revoke Mastodon user tokens through Misskey's existing access-token management UI.
- Make common account, status, public timeline, notification, poll, media, emoji, and instance endpoints follow the Mastodon contract more closely.
- Preserve the existing security boundary: Mastodon tokens cannot authenticate the native Misskey API, and native tokens cannot authenticate Mastodon endpoints.
- Reuse native Misskey endpoints and policy enforcement wherever Misskey has an equivalent capability.
- Keep schema and runtime changes small, independently removable, and reversible.

## Non-goals

- Full Mastodon 4.6.x or API version 11 parity.
- Web Push, scheduled statuses, account/profile editing, grouped notifications, collections, administration APIs, or moderation APIs.
- Emulating functionality that Misskey cannot safely represent by returning a misleading successful mutation.
- Making application tokens visible in a user's access-token list; application tokens do not belong to a user.
- Running backend end-to-end tests as part of this change.

## Compatibility Baseline

The instance document will conservatively advertise Mastodon API version 1 and a `4.3.0 (compatible; Misskey ...)` version string. Newer backwards-compatible request parameters may be accepted when they map safely to Misskey, but the service will not advertise later API-version capabilities until their complete contract is implemented.

Safe empty initialization reads remain available for filters, announcements, conversations, featured tags, and followed tags. They return the correct collection shape without claiming that the corresponding write functionality exists.

## Authentication and Token Model

### Token kinds

`mastodon_oauth_token` remains the only persistent bearer-token table for the compatibility layer. Token kind is derived without adding a redundant discriminator column:

- `userId IS NOT NULL`: user token issued by the authorization-code flow;
- `userId IS NULL`: application token issued by the client-credentials flow.

Both kinds retain the existing client foreign key, scopes, token digest, creation time, and last-used time. Plaintext bearer tokens continue to be returned once and never stored.

Authentication returns a discriminated result so route helpers can enforce one of three policies:

- any valid application or user token;
- a user token with a required Mastodon scope;
- optional authentication for a public endpoint, where a valid user token adds viewer-specific state and a valid application token remains anonymous.

An application token presented to a user-only endpoint returns the Mastodon-compatible "authenticated user required" response. A compatibility token is never passed to native Misskey authentication.

### Minimal migration

Add one new migration; do not edit the existing Mastodon compatibility migration.

The forward migration performs only:

```sql
ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" DROP NOT NULL;
```

The reverse migration deletes rows that the old schema cannot represent and restores the constraint:

```sql
DELETE FROM "mastodon_oauth_token" WHERE "userId" IS NULL;
ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" SET NOT NULL;
```

This does not touch the native `access_token` table, change the column type, rewrite existing user IDs, or alter the existing user/client foreign keys and indexes. Existing user-token rows remain unchanged in both directions. Rolling back only revokes application tokens introduced by this follow-up.

### Client-credentials grant

`POST /oauth/token` accepts `grant_type=client_credentials` for registered Mastodon clients. Client authentication supports the existing request-body and HTTP Basic mechanisms. Requested scopes must be a subset of the registered application scopes; an omitted scope defaults to `read`, which every default registration includes. If a redirect URI is supplied, it must exactly match a registered URI.

The issued token has no user ID. Its response uses the existing Mastodon token response shape with `access_token`, `token_type`, `scope`, and `created_at`.

`GET /api/v1/apps/verify_credentials` accepts either token kind and returns the owning application, including array-valued `scopes` and `redirect_uris`. It requires no specific scope after the token has been validated. `POST /oauth/revoke` can revoke either kind but only when the token belongs to the authenticated client.

## Native Access-token Management

`i/apps` aggregates two sources:

- existing native access-token rows;
- Mastodon user-token rows joined to their registered Mastodon client.

Mastodon rows are projected into the existing response schema:

- `id`: Mastodon token ID;
- `name`: registered client name;
- `createdAt` and `lastUsedAt`: token timestamps;
- `permission`: Mastodon scopes converted through the existing least-privilege Misskey permission map;
- `iconUrl`: `null`;
- `description`: the client website when available, otherwise a Mastodon API label.

The combined result is sorted in memory using the endpoint's existing sort options. The frontend continues to use `i/apps`; no Vue or locale change is required.

`i/revoke-token` first applies its existing native-token deletion semantics, then supports deleting a Mastodon user token with the same ID only when `userId` matches the authenticated user. Raw Mastodon token revocation hashes the supplied value before lookup because plaintext is not stored. Application tokens are not user-owned and cannot be deleted through `i/revoke-token`; clients revoke them through `/oauth/revoke`.

## Public and Authenticated Data Flow

`MastodonApiCallService` gains an anonymous invocation path that calls `ApiCallService.invoke` with no user and no synthetic token. It is used only for native endpoints whose metadata permits anonymous access. This retains Misskey parameter validation, IP-based rate limiting, visibility filtering, and error handling.

Public Mastodon routes accept no token, an application token, or a user token:

- no token or application token invokes the native endpoint anonymously and returns public data;
- a user token invokes it as that user and may include private data the user can see plus viewer-specific fields;
- a malformed or unknown token explicitly supplied in `Authorization` returns 401 instead of silently degrading to anonymous access.

User-only routes continue to use a synthetic in-memory `MiAccessToken` derived from the granted Mastodon scopes. The synthetic token is never inserted into `access_token`.

## Endpoint Work

### OAuth and application identity

- Add `client_credentials` handling to `/oauth/token`.
- Allow application and user tokens on `GET /api/v1/apps/verify_credentials`.
- Revoke either token kind through `/oauth/revoke` with client ownership enforcement.

### Accounts and statuses

- Add public `GET /api/v1/accounts?id[]=...`.
- Add authenticated `GET /api/v1/accounts/search`.
- Add public `GET /api/v1/statuses?id[]=...`.
- Make account lookup by ID, public account statuses, followers, following, individual public statuses, context, reblogged-by, and favourited-by usable without a user token when the underlying data is public.
- Respect `only_media`, `exclude_replies`, `exclude_reblogs`, and `pinned` account-status parameters where Misskey has corresponding data.
- Preserve opaque string IDs and existing cursor translation.
- Return delete-and-redraft source fields after deleting a status.
- Reject `scheduled_at` with 422 so an unsupported scheduled post is never published immediately.

### Timelines and search

- Keep home and list timelines user-only.
- Make public and hashtag timelines public, with optional user authentication.
- Respect `local`, `remote`, and `only_media` where native endpoints provide an equivalent filter; reject contradictory combinations rather than silently returning the wrong timeline.
- Continue to provide v2 search and add the narrower account-search route expected by older clients.

### Notifications

Translate Mastodon `types[]` and `exclude_types[]` into the existing Misskey notification type filters. Apply `account_id` after conversion when the native endpoint cannot express it directly.

Misskey exposes account-wide "mark all read" but not a single-notification dismissal. Implement Mastodon single dismissal as a user-scoped Redis suppression set:

- the dismiss route records the notification ID under the user, not the token, so all Mastodon clients see the same result;
- list and single-notification reads omit suppressed IDs;
- entries have a bounded lifetime and old entries are trimmed, preventing unbounded growth;
- the original Misskey notification remains available to native Misskey clients.

This state uses a dedicated `mastodon-api:dismissed-notifications:` prefix and requires no database migration.

### Polls, media, emoji, and instance discovery

- Add `GET /api/v1/polls/:id` by loading the owning note and converting its poll.
- Add `DELETE /api/v1/media/:id` through the native Drive deletion endpoint.
- Populate `GET /api/v1/custom_emojis` from the native public emoji endpoint.
- Populate instance rules from `MiMeta.serverRules` and expose them through the instance documents and `GET /api/v1/instance/rules`.
- Use the configured instance icon/banner with a safe local fallback and report only implemented streaming and authoring capabilities.
- Change `api_versions.mastodon` from 4 to 1 until all later versioned contracts are implemented.

## Request and Response Compatibility

REST routes continue to accept JSON and `application/x-www-form-urlencoded`. Parameter normalization handles scalar, repeated, bracketed, comma-separated, and nested JSON forms used by Mastodon clients, including `id[]`, `media_ids[]`, `choices[]`, and poll fields.

Bearer scheme matching is case-insensitive while query-string access tokens remain rejected on REST routes. Streaming keeps its separately documented query-token behavior.

Entity converters retain required fields with conservative defaults. Viewer-specific flags are computed only for user-authenticated requests; anonymous and application-token responses never invent a user state.

## Errors and Security

- Missing, malformed, or unknown required tokens return 401 with a Mastodon Bearer challenge.
- A valid token without a required scope returns 403.
- An application token on a user-only route returns 422 because the token has no authorized user.
- Invalid parameters and unsupported safe-to-reject operations return 400 or 422.
- Missing or inaccessible records return 404 without leaking whether private data exists.
- Native rate limits and `Retry-After` propagation remain in force.
- OAuth token responses use `Cache-Control: no-store`.
- Client secrets, bearer tokens, authorization codes, and token digests are not logged.

## Rollback and Impact Boundary

The change has three removable pieces:

1. The migration only permits null `userId` values in the compatibility token table. Its reverse deletes application tokens and restores the old constraint.
2. Redis notification suppression is namespaced, bounded, and expiring. Removing the code merely causes dismissed notifications to become visible again in Mastodon clients until the underlying notification ages out.
3. REST and token-management changes are additive or correct overly broad capability claims. Removing them restores the previous behavior without converting native Misskey data.

No native access token, user, note, notification, Drive file, or application table schema is changed.

## Testing and Validation

Implementation follows red-green-refactor. Tests cover:

1. Application-token issuance, authentication, scope subset validation, Basic/body client authentication, and revocation.
2. User-token behavior remaining unchanged and both token classes remaining invalid on the native Misskey API.
3. Application tokens accepted only where allowed and rejected on user-only routes.
4. `i/apps` aggregation, sorting, ownership, permission projection, and Mastodon token revocation.
5. Anonymous, application-token, and user-token behavior on public routes, including rejection of explicitly invalid tokens.
6. Batch accounts/statuses, account search, poll retrieval, media deletion, custom emoji, and instance rules response contracts.
7. Notification type filters and bounded user-scoped single-dismiss suppression.
8. Parameter normalization and explicit rejection of unsupported scheduled posting.
9. Truthful instance version and capability output.

Fastify injection tests and service unit tests are used instead of backend end-to-end tests. Final validation runs the focused Mastodon unit suite, backend typecheck/lint, migration cleanliness checks, SPDX checks, `misskey-js` generation when native API response types change, CHANGELOG review, locale safety, and diff inspection.

## User-facing Change

Add a Server entry under `CHANGELOG.md` Unreleased covering improved Mastodon OAuth/API compatibility and access-token management. No locale change is needed.

## Acceptance Criteria

- A registered Mastodon client can obtain and verify an application token.
- A user can authorize a Mastodon client, use the resulting token for core read/write operations, see it in Misskey's access-token management page, and revoke it there.
- Application, Mastodon user, and native Misskey tokens remain mutually isolated according to their intended API surfaces.
- Public account, status, and public timeline reads work without authentication and do not expose non-public data.
- Common account/status batch reads, account search, notification filters/dismissal, poll reads, media deletion, emoji discovery, and instance rules follow the documented response contract.
- Unsupported scheduled posts fail before creating a Misskey note.
- The instance document does not advertise an API version higher than the implemented compatibility baseline.
- The migration can be reversed without altering existing user-token rows or any native Misskey table.
