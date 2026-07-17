# Mastodon API Isolation Hardening Design

**Status:** Approved in conversation on 2026-07-16

## Context

The Mastodon-compatible API is intentionally implemented as an adapter over Misskey's native domain services so third-party clients operate on the same notes, profiles, follow relationships, notifications, drafts, and abuse reports as the native client. The protocol and serialization layer is mostly isolated, but the current integration is always enabled and directly participates in the shared HTTP, OAuth, WebSocket, and token-management lifecycle.

This creates three hardening needs:

1. Operators need a runtime switch that restores the native Misskey surface without registering or dispatching Mastodon compatibility behavior.
2. Native OAuth needs database-free regression coverage proving that Mastodon dispatch does not alter its supported authorization-code flow.
3. `AbuseReportService.report()` must retain its original return contract while the Mastodon report adapter can still obtain the created report entity.

## Goals

- Add `enableMastodonApi`, defaulting to `true`, so existing third-party client compatibility remains enabled after upgrade.
- When disabled, do not register Mastodon REST routes, attach Mastodon streaming, extend OAuth metadata, register Mastodon OAuth endpoints, dispatch OAuth requests to Mastodon handlers, query Mastodon token repositories from native token-management endpoints, or publish Mastodon token-revocation events.
- Preserve the complete native OAuth authorization-code and PKCE flow in both enabled and disabled configurations.
- Restore the original `AbuseReportService.report()` return value and expose a separate method for callers that need created report entities.
- Add only unit and Fastify injection tests; do not add or run backend E2E tests.
- Do not add, edit, or remove any entity or migration.

## Non-goals

- Moving Mastodon compatibility to a separate process, port, or reverse proxy.
- Dynamically removing Mastodon providers or entities from the NestJS module graph.
- Silently swallowing Mastodon registration errors while compatibility is enabled.
- Removing existing Mastodon OAuth tables or stored credentials.
- Changing any Mastodon route contract or expanding API coverage.

## Configuration and lifecycle boundary

The source configuration accepts an optional `enableMastodonApi` boolean. The normalized `Config` always contains a boolean and resolves an omitted value to `true`.

The setting is documented in the normal example configuration and Helm default configuration. Existing installations that omit it retain the current enabled behavior.

A focused `MastodonApiIntegrationService` owns the compatibility server lifecycle:

- When enabled, it registers `MastodonApiServerService.createServer`, attaches `MastodonStreamingApiServerService` to the shared HTTP server, records that streaming was attached, and detaches it during shutdown.
- When disabled, registration and attachment are no-ops, and shutdown does not call detach for a server that was never attached.
- `ServerService` depends on this integration boundary instead of directly operating the REST and streaming services.

This is an operational registration boundary rather than full NestJS provider isolation. Mastodon providers remain available in the dependency-injection container, but disabled mode performs no route registration, WebSocket listener attachment, Redis subscription attachment, or Mastodon database access through the compatibility entrypoints.

Enabled mode remains strict: a route conflict or registration error fails startup. The configuration switch is an explicit operator choice, not an automatic fail-open mechanism.

## OAuth behavior

`OAuth2ProviderService` uses `config.enableMastodonApi` at each shared integration point.

When enabled, current behavior remains:

- RFC 8414 metadata advertises recognized Mastodon scopes, client credentials, supported client-authentication methods, revocation, app registration, and userinfo.
- `/oauth/authorize`, `/oauth/decision`, and `/oauth/token` dispatch Mastodon clients and transactions to `MastodonOAuthService`.
- `/oauth/revoke` and GET/POST `/oauth/userinfo` are registered.

When disabled, behavior matches the native provider before Mastodon integration:

- metadata advertises only native scopes and the authorization-code grant;
- Mastodon-only metadata fields are omitted;
- Mastodon-only OAuth routes are not registered and therefore retain the provider's existing unknown-endpoint response;
- authorize, decision, and token requests never call `MastodonOAuthService`;
- non-URL client identifiers are validated and rejected by the native IndieAuth-compatible provider.

Native OAuth client identifiers remain HTTP(S) URLs. Enabled dispatch continues to distinguish them from generated Mastodon client identifiers without client-name, user-agent, or redirect-scheme heuristics.

## Native token-management behavior

The native `i/apps` and `i/revoke-token` endpoints use the same configuration switch.

When enabled, they retain their current user-facing integration: `i/apps` combines user-owned native and Mastodon tokens, and `i/revoke-token` can revoke either token kind and notify active Mastodon streams.

When disabled:

- `i/apps` executes only the native access-token query and returns the original projection and ordering;
- `i/revoke-token` deletes only from the native access-token repository;
- neither endpoint calls a Mastodon repository;
- token revocation does not publish a Mastodon Redis event.

Existing Mastodon token rows are preserved while disabled and become manageable again when the feature is re-enabled.

## Abuse report service contract

`AbuseReportService` exposes two public operations backed by one private create-and-notify implementation:

- `report()` creates the requested reports, awaits the three existing notification operations, and returns the original `Promise.all` notification result.
- `reportAndGetCreated()` performs the same creation and notifications but returns the created report entities.

Both methods insert exactly once, notify exactly once, preserve notification ordering and error propagation, and share the same validation and persistence path. Existing ActivityPub and native API callers continue using `report()` without modification. `MastodonReportService` uses `reportAndGetCreated()` to build a Mastodon Report from the real persisted identity.

## Testing strategy

All production changes follow red-green-refactor and use tests that do not require PostgreSQL, Redis, or a deployed Misskey server.

### Configuration and lifecycle

- Verify omitted configuration resolves `enableMastodonApi` to `true` and an explicit `false` is preserved.
- Verify the integration service registers and attaches exactly once while enabled.
- Verify disabled mode calls neither the REST nor streaming service.
- Verify detach is called only after a successful attach.

### Native OAuth

A Fastify injection fixture uses a mocked HTTP client-discovery response, user lookup, cache, ID generator, and access-token repository to execute the native flow:

1. discover an HTTP(S) client;
2. validate exact redirect URI, native scope, and S256 PKCE parameters;
3. render and submit the authorization decision;
4. exchange the authorization code with the correct verifier;
5. insert a native access token and return the normal OAuth token response.

The test asserts that no Mastodon authorization or token-exchange method is called. Additional disabled-mode tests verify native-only RFC 8414 metadata, absence of userinfo and revoke routes, and native rejection of a non-URL client identifier.

### Native token management

- Verify disabled `i/apps` returns native tokens without calling the Mastodon repository.
- Verify disabled `i/revoke-token` revokes a native token without querying Mastodon storage or publishing Redis events.
- Retain enabled-mode combined listing, sorting, ownership, and revocation tests.

### Abuse reports

- Verify `report()` returns the three notification results in their original order.
- Verify `reportAndGetCreated()` returns the inserted reports.
- Verify each public path performs one insertion sequence and one invocation of each notification channel.
- Update the Mastodon report test to require `reportAndGetCreated()`.

The complete Mastodon unit directory, OAuth provider tests, native streaming test, native token-management tests, and abuse-report tests form the focused regression suite. Backend E2E tests remain out of scope because the environment has no deployed test database.

## Failure and rollback behavior

- Disabled mode restores native route and OAuth behavior without deleting compatibility data.
- Enabled mode continues to fail startup on invalid compatibility registration rather than silently serving a partially broken API.
- A normal code revert restores the previous always-enabled behavior.
- No schema rollback or data migration is involved.

## Acceptance criteria

- `enableMastodonApi` defaults to `true` and is documented.
- Setting it to `false` prevents all Mastodon REST, streaming, OAuth dispatch/metadata, native token-list integration, and Mastodon token-revocation side effects described above.
- Setting it to `true` preserves current Mastodon compatibility behavior.
- A database-free test completes the native OAuth authorization-code and PKCE flow without invoking Mastodon handlers.
- `AbuseReportService.report()` has its original return contract, while Mastodon reports retain real persisted IDs through `reportAndGetCreated()`.
- No migration, entity, locale, frontend, or generated misskey-js API file changes.
- Focused unit/Fastify tests and targeted lint pass, subject to documented repository-wide baseline failures outside this change.
