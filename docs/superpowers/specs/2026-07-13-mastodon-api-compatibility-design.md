# Mastodon API Compatibility Design

**Status:** Approved for autonomous implementation on 2026-07-13

## Context

Misskey exposes its own JSON API, MiAuth, and an OAuth 2.0 provider whose clients are identified by HTTPS URLs discovered through IndieAuth client metadata. The existing OAuth provider requires PKCE with S256. Mastodon clients use a different registration model: they first call `POST /api/v1/apps`, receive an opaque `client_id` and `client_secret`, and then use the authorization-code flow. Current Elk and Tusky releases still depend on confidential-client authentication without PKCE, while Phanpy uses PKCE when server metadata advertises S256.

This repository previously carried a 2024 Mastodon compatibility experiment based on Megalodon. That implementation proxied requests back into the local Misskey HTTP API, vendored a large client library, and replaced substantial parts of the OAuth provider. It is useful as an endpoint inventory but is not safe to restore because it weakens the isolation required by the current OAuth implementation.

## Goals

- Let a Misskey account sign in to Elk, Phanpy, Tusky, and similarly conventional Mastodon clients.
- Support the core client experience: instance discovery, authentication, profiles, timelines, statuses, media, notifications, relationships, search, favourites, bookmarks, polls, lists, and foreground streaming.
- Keep existing Misskey API, MiAuth, native tokens, and URL-client OAuth behavior unchanged.
- Keep Mastodon credentials and tokens unable to authenticate the native Misskey API.
- Reuse Misskey endpoint policy, rate-limit, suspension, role, and telemetry enforcement instead of reimplementing business rules.
- Make the compatibility layer always available on this branch without adding an administrator setting.

## Non-goals

- Complete parity with every Mastodon endpoint or every historical Mastodon version.
- Background Web Push and `/api/v1/push/subscription` in the first release.
- Account registration, administration APIs, scheduled statuses, notification policies/requests, collections, profile editing, filter editing, markers, reports, or direct-message conversation emulation.
- Making native Misskey/MiAuth tokens valid on Mastodon endpoints.
- Making Mastodon-issued tokens valid on native Misskey endpoints.
- HTTP loopback calls from the compatibility layer to the same Misskey process.

## Compatibility target

The acceptance clients are:

- Elk: sign in, initialize the instance, load home/public/list/tag timelines, open threads and profiles, compose with media and polls, interact with statuses, search, read notifications, and receive foreground stream events.
- Phanpy: the same core flows, including OAuth PKCE when advertised.
- Tusky: confidential-client sign in without PKCE, instance/filter initialization, timelines, notifications, compose/media, profiles, relationships, search, bookmarks, favourites, and polls.

Optional calls made by those clients, including push-subscription, marker, filter-v2, scheduled-status, or newer notification-policy calls, may return a normal Mastodon-style 404 without preventing the core experience.

## Architecture

### Module boundary

Add a self-contained backend module under `packages/backend/src/server/api/mastodon/`:

- `MastodonApiServerService` owns compatible REST routes below `/api/v1` and `/api/v2`.
- `MastodonStreamingApiServerService` owns Mastodon WebSocket upgrades below `/api/v1/streaming`.
- `MastodonOAuthService` owns dynamic clients, registered-client authorization, token exchange, and revocation.
- `MastodonAuthenticateService` accepts only compatibility tokens and produces a local user plus granted Mastodon scopes.
- `MastodonApiCallService` invokes existing Misskey endpoint executors through an internal `ApiCallService` entry point.
- `MastodonEntityService` converts packed Misskey users, notes, notifications, files, lists, and relationships into Mastodon entities.
- `MastodonPaginationService` translates cursor parameters and writes RFC 8288 `Link` headers.
- `MastodonScopeService` validates Mastodon scopes and derives only the Misskey permissions needed for an invoked native endpoint.

The compatibility layer is registered alongside `ApiServerService`; it does not change the native `/api/<misskey-endpoint>` route loop. Exact compatible routes already present, currently `/api/v1/instance/peers`, remain owned by the existing server and are not registered twice.

### Native endpoint gateway

Expose a narrow public `invoke` method on `ApiCallService` that delegates to its existing private call path. Native HTTP handling continues to use the same code and receives no changed parameters or response shape.

`MastodonApiCallService` resolves an endpoint definition and its NestJS executor, constructs a synthetic in-memory `MiAccessToken` containing only the Misskey permissions derived for that Mastodon request, and calls `ApiCallService.invoke`. It never inserts that synthetic token and never passes the external Mastodon bearer token into native authentication.

This preserves native parameter validation, credential checks, moved/suspended-account restrictions, role policies, rate limiting, logging, and telemetry. Mastodon routes translate resulting `ApiError` objects at the outer boundary.

### Persistent data

Add two isolated entities and a reversible migration:

`mastodon_oauth_client`:

- opaque random `id` used as `client_id`;
- SHA-256 hash of a high-entropy random `client_secret`;
- client name and optional website;
- exact redirect URI array;
- registered Mastodon scope array;
- creation timestamp.

`mastodon_oauth_token`:

- opaque primary ID;
- SHA-256 hash of a high-entropy bearer token;
- local user ID and client ID foreign keys with cascade deletion;
- granted Mastodon scope array;
- creation and last-used timestamps.

Plaintext client secrets and bearer tokens are returned once and never stored. A digest is sufficient because both values are generated with at least 256 bits of entropy and are not user-selected passwords.

Authorization transactions and one-time authorization codes are stored in Redis with distinct `mastodon-oauth:transaction:` and `mastodon-oauth:grant:` prefixes and five-minute expiry. Code consumption is atomic. Reuse fails with `invalid_grant`; if a token was already issued during a race, that token is revoked.

## OAuth design

### Dynamic registration

`POST /api/v1/apps` accepts JSON and `application/x-www-form-urlencoded` bodies used by the target clients. It validates:

- non-empty `client_name` with a bounded length;
- one or more newline-separated `redirect_uris`;
- exact registered Mastodon scopes;
- HTTPS redirects, loopback HTTP redirects, custom application schemes, and the standard OOB URN;
- rejection of `javascript:`, `data:`, `file:`, `vbscript:`, credential-bearing URLs, fragments, and malformed URIs.

The response is a Mastodon `CredentialApplication` with `id`, `name`, `website`, `redirect_uri`, `redirect_uris`, `scopes`, `client_id`, `client_secret`, and `client_secret_expires_at: 0`.

### Authorization dispatch

The shared `/oauth/authorize` and `/oauth/token` paths classify clients only by identifier:

- a valid URL-shaped `client_id` goes through the existing URL-client OAuth code without weakened validation;
- a non-URL opaque ID must exactly match `mastodon_oauth_client` and goes through registered-client OAuth;
- missing or unknown clients fail; the server never selects a flow based on absence of PKCE.

Registered clients must request `response_type=code`, an exact registered redirect URI, and a scope subset of the registration. PKCE is optional for compatibility. When supplied, it must use S256. The authorization page reuses the existing Misskey OAuth UI, displaying the derived Misskey permissions while the grant records the original Mastodon scopes.

At token exchange, registered clients must authenticate with their `client_secret`. A code created with PKCE additionally requires a valid `code_verifier`. Codes are bound to client ID, redirect URI, user, scopes, and optional challenge.

The token response contains `access_token`, `token_type: Bearer`, space-separated `scope`, and `created_at`. `POST /oauth/revoke` validates client credentials and idempotently deletes only a token belonging to that client.

The OAuth metadata response keeps all existing Misskey scopes and properties, and additively advertises Mastodon high-level/granular scopes plus `app_registration_endpoint`. `code_challenge_methods_supported` remains `S256`.

### Scope enforcement

Mastodon scopes are hierarchical. `read`, `write`, and the deprecated `follow` imply their documented granular scopes. Route metadata declares the narrow required Mastodon scope, for example `read:statuses`, `write:statuses`, `read:notifications`, or `write:follows`.

Scope checks happen before native endpoint invocation. The gateway then provides only the corresponding Misskey permission such as `read:account`, `write:notes`, `read:notifications`, `write:following`, `write:reactions`, `write:votes`, `read:drive`, or `write:drive`. Unsupported `push` may be registered and granted so common clients can sign in, but no push endpoint is advertised in instance capabilities.

## REST endpoint scope

### Discovery and initialization

- `POST /api/v1/apps`
- `GET /api/v1/apps/verify_credentials` when supplied a user token
- `GET /api/v1/instance`
- `GET /api/v2/instance`
- `GET /api/v1/custom_emojis`
- `GET /api/v1/preferences`
- `GET /api/v1/filters` returning an empty list until filter translation is implemented
- `GET /api/v2/filters` returning an empty list
- `GET /api/v1/announcements`

The v2 instance response includes `api_versions.mastodon`, character/media/poll limits, account limits, supported languages, registrations state, streaming URL, and feature flags that reflect only implemented behavior. It does not advertise Web Push.

### Accounts and relationships

- `GET /api/v1/accounts/verify_credentials`
- `GET /api/v1/accounts/lookup`
- `GET /api/v1/accounts/:id`
- `GET /api/v1/accounts/:id/statuses`
- `GET /api/v1/accounts/:id/followers`
- `GET /api/v1/accounts/:id/following`
- `GET /api/v1/accounts/relationships`
- `POST /api/v1/accounts/:id/follow`
- `POST /api/v1/accounts/:id/unfollow`
- `POST /api/v1/accounts/:id/block`
- `POST /api/v1/accounts/:id/unblock`
- `POST /api/v1/accounts/:id/mute`
- `POST /api/v1/accounts/:id/unmute`
- `GET /api/v1/blocks`
- `GET /api/v1/mutes`
- `GET /api/v1/follow_requests`
- `POST /api/v1/follow_requests/:id/authorize`
- `POST /api/v1/follow_requests/:id/reject`

### Timelines and status reading

- `GET /api/v1/timelines/home`
- `GET /api/v1/timelines/public`
- `GET /api/v1/timelines/tag/:hashtag`
- `GET /api/v1/timelines/list/:id`
- `GET /api/v1/statuses/:id`
- `GET /api/v1/statuses/:id/context`
- `GET /api/v1/statuses/:id/source` for the authenticated author
- `GET /api/v1/statuses/:id/reblogged_by`
- `GET /api/v1/statuses/:id/favourited_by`
- `GET /api/v1/bookmarks`
- `GET /api/v1/favourites`

`local=true` maps to the local timeline and the default public timeline maps to the global timeline. Home maps to Misskey's home timeline so followed users and the account's own posts behave like a Mastodon home feed without depending on the optional hybrid-timeline policy.

### Status writing and media

- `POST /api/v1/statuses`
- `PUT /api/v1/statuses/:id`
- `DELETE /api/v1/statuses/:id`
- favourite/unfavourite
- reblog/unreblog
- bookmark/unbookmark
- pin/unpin
- `POST /api/v1/polls/:id/votes`
- `POST /api/v1/media`
- `POST /api/v2/media`
- `GET /api/v1/media/:id`
- `PUT /api/v1/media/:id`

Mastodon favourite maps to a neutral heart Misskey reaction, and unfavourite removes the current user's reaction. Bookmark maps to Misskey note favourites. Reblog maps to a renote. Mastodon visibility maps as follows: `public` to `public`, `unlisted` to `home`, `private` to `followers`, and `direct` to `specified` with mentioned recipients. Content warnings map to `cw`; media IDs, sensitivity, reply IDs, polls, and idempotency keys are preserved where Misskey has equivalents.

`Idempotency-Key` is cached per compatibility token and route in Redis long enough to return the original created status for a retry, preventing duplicate posts.

### Notifications, search, and lists

- `GET /api/v1/notifications`
- `GET /api/v1/notifications/:id`
- `POST /api/v1/notifications/clear`
- `GET /api/v2/search`
- `GET /api/v1/lists`
- `GET /api/v1/lists/:id`
- create, update, and delete list
- get, add, and remove list accounts
- `GET /api/v1/accounts/:id/lists`

Unsupported Misskey notification types are omitted, not relabelled. Reaction notifications map to `favourite`; renotes map to `reblog`; mentions, follows, follow requests, and polls map directly.

## Entity conversion

All IDs remain opaque strings. Existing Misskey IDs are emitted unchanged, allowing cursor translation without a second ID map.

`MastodonEntityService` owns conversion and recursively handles renotes as `reblog`. It converts:

- local and remote usernames into Mastodon `username` and `acct` conventions;
- MFM into sanitized HTML for `content` and profile `note`, while `source.text` retains editable plain/MFM source for the author;
- Misskey visibility, CW, replies, files, polls, mentions, hashtags, emojis, reactions, counts, and current-user state;
- Drive files into media attachments with description, blurhash, dimensions, preview URL, and type;
- Misskey user relations into Mastodon `Relationship` with unsupported flags set conservatively;
- Misskey lists into Mastodon list entities.

Converters consume already-packed Misskey entities and avoid additional account or note lookups. The bounded direct-recipient resolver is the exception because Misskey requires concrete user IDs for `specified` visibility. HTML is produced through existing MFM rendering/sanitization services rather than string replacement.

## Pagination

Mastodon `max_id`, `min_id`, and `since_id` map to Misskey `untilId` and `sinceId` semantics. Limits are clamped per Mastodon endpoint and never exceed the underlying Misskey maximum. Collection responses include `Link` headers with exact encoded `next` and `prev` URLs when a page boundary exists.

The service does not assume numeric IDs and never parses IDs into JavaScript numbers.

## Foreground streaming

Expose Mastodon-compatible WebSocket streaming at `/api/v1/streaming` and advertise that URL through the instance response. Authenticate the bearer token from the header or documented query parameter, validate the requested stream, and subscribe to existing Misskey global events/stream channels.

First-release streams:

- `user`: home updates, deletes, and notifications;
- `public`, `public:local`, and their media variants;
- `hashtag` and `hashtag:local`;
- `list`.

Events use Mastodon envelopes with `event`, `payload`, and optional `stream`. Payload entities use the same converter as REST. Connections are removed on close, token revocation, user suspension, or server shutdown. Backpressure is bounded; slow clients are disconnected instead of accumulating unbounded messages.

## Errors and security

- Authentication errors use HTTP 401 and `WWW-Authenticate: Bearer` with Mastodon `{ "error": ... }` bodies.
- Missing scopes use HTTP 403; invalid parameters use 400 or 422; absent records use 404; rate limits use 429 and preserve `Retry-After`.
- Internal errors receive a correlation ID in logs but no stack trace or Misskey internal error object in the public response.
- OAuth, registration, token, and media routes have explicit body-size and rate limits.
- Redirect URIs are exact-match only. Authorization codes and tokens are never placed in logs.
- Client secrets and bearer tokens are compared using constant-time digest comparison.
- CORS is enabled only with the same public policy required by Mastodon browser clients; OAuth token responses use `Cache-Control: no-store`.
- No compatibility route accepts the native `i` body parameter.

## Testing

Implementation follows red-green-refactor. Automated coverage includes:

1. Dynamic registration for JSON and form clients, redirect validation, scope validation, and secret hashing.
2. URL-client OAuth regression tests proving existing PKCE and client-discovery behavior is unchanged.
3. Registered-client OAuth with and without PKCE, exact redirects, client-secret validation, state propagation, single-use codes, revocation, expiry, and cross-client rejection.
4. Proof that Mastodon tokens fail native `/api` authentication and native tokens fail Mastodon authentication.
5. Scope hierarchy and endpoint permission tests.
6. Converter fixtures for local/remote accounts, MFM, CW, renotes, replies, media, polls, emojis, visibility, and notifications.
7. Pagination mapping and `Link` headers with opaque string IDs.
8. Route tests for login initialization and each core read/write family.
9. Streaming authentication, subscription filtering, payload conversion, cleanup, and backpressure.
10. Contract smoke tests that reproduce the current Elk, Phanpy, and Tusky login sequences.

Final validation includes focused backend unit/e2e tests, existing OAuth e2e tests, backend lint/typecheck, repository lint where practical, migration checking, SPDX checking, locale safety, and a secret scan of the diff.

## User-facing changes

Add a `Server` entry under `CHANGELOG.md` Unreleased describing Mastodon API client compatibility. No locale change is required because the existing OAuth consent UI displays already-localized Misskey permission labels and no new setting is exposed.

## Acceptance criteria

- Elk, Phanpy, and Tusky can register an app, authorize a Misskey user, exchange a code, verify credentials, and load their initial authenticated view.
- Users can read core timelines, profiles, threads, and notifications; compose text/media/polls; reply, delete, boost, favourite, bookmark, vote, follow, mute, and block.
- Elk and Phanpy receive foreground stream updates.
- Background push may be unavailable without preventing sign-in or normal foreground use.
- Existing OAuth e2e tests pass without loosening URL-client PKCE or redirect validation.
- Existing Misskey API and MiAuth tests pass.
- Compatibility tokens are cryptographically and behaviorally isolated from native tokens.
