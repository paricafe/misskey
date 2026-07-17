# Mastodon 4.6.3 User API Compatibility Design

**Status:** Approved for implementation on 2026-07-16

## Context

The current branch contains an isolated Mastodon-compatible OAuth, REST, and WebSocket layer. It already supports application registration, authorization-code and client-credentials grants, PKCE, token revocation, account and status reads, timelines, status creation and interactions, media, polls, notifications, search, lists, trends, and common streaming channels.

The remaining problem is broader than the method list exposed by one SDK. Third-party Mastodon clients and platforms commonly assume that the server follows the official Mastodon API contract, including legacy aliases and secondary endpoints used after login. An unregistered route produces an accidental 404, which clients cannot distinguish from an incompatible server. A successful placeholder write is worse because it tells a client that state was saved when it was not.

The compatibility target is therefore the official Mastodon 4.6.3 non-administrative user API. Megalodon may be used as a representative client-surface reference, but it is not the protocol source of truth.

## Sources of truth

Contract decisions use these sources in order:

1. Mastodon 4.6.3's official [`config/routes/api.rb`](https://github.com/mastodon/mastodon/blob/v4.6.3/config/routes/api.rb).
2. The official [Mastodon API method documentation](https://docs.joinmastodon.org/methods/), including version history, authentication, parameters, response entities, and status codes.
3. Mastodon 4.6.3 serializers and controller behavior when the method documentation is ambiguous.
4. Representative clients such as Megalodon only to identify commonly exercised flows and parameter encodings.

Client names, User-Agent values, redirect URI schemes, and request fingerprints must never select behavior.

## Goals

- Allow ordinary third-party Mastodon clients and Mastodon-OAuth platforms to register, authorize, obtain and revoke tokens, verify the signed-in account, and complete everyday user workflows.
- Cover every documented non-administrative Mastodon 4.6.3 REST method and path with either a real implementation or an explicit, contract-shaped compatibility response.
- Preserve compatibility with older clients by retaining documented legacy aliases and entity fields.
- Implement missing operations when Misskey already has equivalent persisted state or a semantically accurate native endpoint.
- Return type-correct empty reads, 404 for unavailable singleton resources, or explicit 422 errors when state cannot be represented without new persistence.
- Preserve Misskey's native authorization, visibility, rate-limit, federation, and request-safety checks.
- Keep capability and API-version reporting conservative.
- Add no database migration and make no native schema change.

## Non-goals

- Mastodon administrative or moderation APIs under `/api/v1/admin/**` or `/api/v2/admin/**`.
- Experimental APIs, including `/api/v1_alpha/**`.
- Claiming complete Mastodon server parity or changing Misskey's ActivityPub behavior.
- Implementing stateful features by adding tables, columns, migrations, or process-local ephemeral storage.
- Pretending that unsupported writes succeeded.
- Supporting a client through client-specific response branches.
- Raising the advertised Mastodon human-readable version or `api_versions.mastodon` value in this phase.
- Backend end-to-end, federation, browser, or external-client test execution. The available environment has no deployed test database.

## Compatibility boundary

The covered surface consists of:

- Mastodon OAuth discovery, application registration, authorization, token exchange, and revocation;
- documented non-admin `/api/v1/**` and `/api/v2/**` methods;
- the documented Mastodon streaming endpoint and user-facing stream categories;
- legacy aliases still documented for client compatibility;
- public discovery methods used by clients before authentication.

Admin scopes and admin routes remain rejected. Undocumented Rails-internal methods and web application endpoints are outside the compatibility manifest.

## User-journey priorities

Implementation and regression triage follow user impact rather than file or controller order.

### Priority 0: login and discovery

- register an OAuth application;
- authorize confidential and public clients;
- support S256 PKCE and exact redirect validation;
- exchange authorization codes and client credentials;
- revoke tokens;
- read OAuth server metadata and instance metadata;
- verify application and user credentials.

### Priority 1: daily client use

- read home, public, tag, and list timelines;
- create, edit, delete, boost, favourite, bookmark, mute, and pin statuses;
- upload and update media;
- create and vote in polls;
- read and control notifications;
- search accounts, statuses, tags, and resolvable ActivityPub URLs;
- follow, mute, block, and list accounts;
- receive streaming updates.

### Priority 2: common secondary flows

- update profile and credential-account fields;
- file abuse reports;
- read and dismiss announcements;
- create and manage scheduled statuses;
- read status edit history and request translation;
- save personal account notes and remove followers;
- read directory and instance peer/activity information;
- serve documented deprecated aliases used by older clients.

### Priority 3: optional stateful features

Filters, conversations, markers, Web Push subscriptions, followed and featured tags, endorsements, collections, annual reports, grouped notifications, and similar features receive explicit routes and truthful fallback behavior when Misskey has no equivalent state.

## Architecture

The request path remains a one-way compatibility pipeline:

```text
Mastodon HTTP request
  -> official method/path/parameter contract
  -> token-type and scope authorization
  -> normalized query, JSON, form, or multipart input
  -> Misskey native endpoint invocation
  -> Mastodon entity conversion
  -> Mastodon pagination, headers, and errors
```

`MastodonApiServerService` remains the Fastify entrypoint. Route registration is grouped by OAuth/discovery, accounts/profile, statuses/media, timelines, notifications, search, lists, and secondary compatibility features. Large unrelated refactors are not part of this work, but new routes must be added through focused registration methods rather than a new monolithic block.

`MastodonApiCallService` remains the normal bridge to native endpoint executors. This preserves native parameter validation, permissions, suspension and move checks, rate limits, federation rules, and telemetry. A narrowly scoped helper service may use an existing core service directly only when the native endpoint intentionally discards data required by the Mastodon response; it must preserve the same validation and authorization behavior.

`MastodonEntityService` owns every Mastodon response entity. Native packed objects must not be returned directly. New converters cover Profile, Announcement, ScheduledStatus, Report, StatusEdit, Translation, Instance Activity, and any compatibility entity required by the route manifest.

## Official route manifest

A declarative manifest records each covered route's:

- HTTP method and a concrete sample path;
- Mastodon version in which it appeared;
- public, application-token, or user-token authentication mode;
- required scope;
- response entity or envelope;
- implementation classification: native, projection, safe read, singleton-not-found, or unsupported write.

A Fastify contract test uses route introspection to prove that every method and sample path is registered. The manifest is a coverage and test artifact, not a claim that every route has persisted semantics.

Fallback routes are registered from focused declarative tables. When a fallback is replaced by a real implementation, duplicate Fastify registration must fail during startup or tests rather than silently selecting one handler.

## Route behavior classifications

### Native mappings

Use existing Misskey state and endpoints when semantics align:

| Mastodon operation | Misskey source |
| --- | --- |
| profile and credential updates | `i/update`, Drive-backed avatar/header handling |
| abuse report creation | existing abuse-report validation and persistence |
| announcement list | `announcements` |
| announcement dismissal | `i/read-announcement` |
| scheduled status create/list/show/update/delete | `notes/drafts/*` with `isActuallyScheduled = true` |
| personal account note | `users/update-memo` |
| remove follower | `following/invalidate` |
| status edit history | packed Note `history` plus current revision |
| status translation | `notes/translate` |
| profile directory | native user discovery/listing endpoints with bounded offset pagination |
| instance peers | `federation/instances` projected to domain strings |
| instance activity | bounded native chart data projected to Mastodon weekly activity |

`POST /api/v1/statuses` with `scheduled_at` creates a scheduled Note draft and returns ScheduledStatus instead of publishing immediately. Scheduled status CRUD must only expose drafts owned by the authenticated user and marked as actually scheduled.

Profile updates support both the legacy `PATCH /api/v1/accounts/update_credentials` contract and the Mastodon 4.6 profile methods. Shared fields produce consistent Account, CredentialAccount, and Profile responses. Removing an avatar or header updates the real Misskey profile instead of returning a local-only projection.

Abuse reports must create a real existing Misskey report. Attached status identifiers, category, rule identifiers, and forwarding intent are preserved as safe report context where the native model has no separate field. The returned Report uses the actual created report identity; it must not use an unrelated or fabricated success record.

### Compatible projections

Projection is allowed only when it is deterministic, bounded, and derived from real existing state:

- Misskey announcements become Mastodon Announcement entities; unsupported emoji-reaction mutations return 422.
- scheduled Note drafts become ScheduledStatus entities, including params, media attachments, poll options, reply target, and scheduled time;
- Note history becomes StatusEdit entities with the correct content, spoiler text, media and poll fields available for each stored revision;
- native translation output becomes a Mastodon Translation entity without claiming provider data Misskey does not expose;
- federation and chart results become peer and activity responses without external requests or new stored aggregates.

Unknown optional fields use the exact documented null, empty string, empty array, or omission semantics. Required URL fields are valid absolute URLs.

### Safe reads

When no equivalent persisted state exists:

- collection routes return an empty array only when the contract returns a collection;
- marker reads return an empty object;
- retrieval of a single filter, subscription, collection, or other unavailable singleton returns 404;
- reads still enforce their documented authentication mode and scope;
- a valid empty response never advertises a feature flag that is not operational.

Typical safe-read families include filters, conversations, markers, push subscriptions, followed/featured tags, endorsements, collections, annual reports, donation campaigns, and grouped-notification extensions. A family moves out of this category only after an accurate Misskey mapping exists.

### Unsupported writes

State-changing methods with no safe native representation return a Mastodon-shaped 422 after request authentication, scope validation, and basic parameter validation. They never return a fabricated entity or an empty success body.

This applies to unsupported filter CRUD, conversation state changes, marker saves, push-subscription mutations, tag follow/feature operations, collection mutations, announcement reactions, and other unmappable writes. Missing or invalid credentials still return 401, and insufficient scope still returns 403 before the 422 compatibility response.

## OAuth and scopes

Scopes have three policies:

1. Implemented official non-admin scopes are accepted, mapped to the minimum required Misskey permissions, and enforced by routes.
2. Official Mastodon 4.6.3 non-admin scopes whose feature is not persisted are recognized during application registration and authorization so a broad-scope client can still log in. They grant no unrelated Misskey permission, and their route returns the documented safe read, 404, or 422 behavior.
3. `admin:*` and non-official scopes are rejected as unsupported.

The generic `read`, `write`, and `follow` parent-scope rules remain compatible with Mastodon. OAuth metadata lists scopes recognized by the authorization server. Instance capability fields and `api_versions.mastodon` remain conservative and are not increased merely because a route or scope is recognized.

## Input normalization

Official parameter names and encodings are accepted consistently across query strings, JSON bodies, URL-encoded forms, and multipart forms where the method permits them. Bracketed arrays, repeated keys, nested objects, Mastodon booleans, empty values, and opaque string IDs use shared normalization helpers.

Limits are clamped to the documented maximum. Unsupported but syntactically valid options return 422 instead of being silently ignored when ignoring them would change the requested meaning. Compatibility code never converts opaque IDs to JavaScript numbers.

## Authentication and error policy

Error precedence is fixed:

1. malformed syntax or missing required request parameters: 400;
2. missing, invalid, expired, revoked, or wrong-kind credentials: 401;
3. valid token with insufficient scope: 403;
4. missing or inaccessible resource: 404;
5. valid request for unsupported semantics: 422;
6. native rate limit: 429 with `Retry-After` preserved;
7. unexpected internal error: 500.

Public routes accept no token, a valid application token, or a valid user token according to the official contract. An explicitly supplied malformed or unknown bearer token returns 401. Mastodon errors never expose native error objects, internal identifiers, SQL details, or stack traces.

## Pagination and caching

Cursor-based collections retain opaque `max_id`, `since_id`, and `min_id` semantics and RFC 8288 `Link` headers. Offset-based methods preserve unrelated query parameters when constructing next and previous links. Empty results do not invent cursors.

User-specific responses remain private and revalidated. Public compatibility responses must not introduce caching behavior that could mix authenticated and anonymous entity state.

## Testing strategy

Implementation follows red-green-refactor. Production behavior is not added before a focused test has failed for the expected reason.

The test layers are:

1. Route-manifest unit tests proving every documented non-admin method and concrete sample path is registered.
2. Scope tests covering implemented, recognized-but-unmapped, generic parent, invalid, and admin scopes.
3. Fastify injection tests for application-token, user-token, missing-token, invalid-token, and insufficient-scope behavior.
4. Entity tests for Mastodon 4.6.3 required fields, legacy fields, URLs, nullability, and stable empty values.
5. User-flow injection tests covering registration, PKCE authorization, token exchange, account verification, timeline reads, posting, media, notifications, search, profile update, scheduled statuses, report creation, and revocation.
6. Unsupported-route tests proving correct response shapes and proving 401/403 take precedence over 422.
7. The complete existing Mastodon and OAuth unit-test regression set.

No backend E2E, federation, browser, or external-client test is added or run because the available environment has no deployed test database. Unit and Fastify tests use existing mocks and injection fixtures only.

Final validation includes focused tests, the complete Mastodon unit directory, the broader OAuth regression set, backend lint, repository lint, `git diff --check`, SPDX verification for new source files, locale safety, and CHANGELOG review. Migration checking is unnecessary unless an entity or migration unexpectedly changes; such a change would violate this design.

## Data, migration, and rollback

No table, column, index, entity, or migration is added or modified. Existing Note drafts, announcements, reports, user memos, followings, Note history, and chart data remain the sole sources of persisted state.

Rollback is a normal code revert. Unsupported-route declarations and entity projections create no data. Native-backed writes remain ordinary Misskey writes and follow their existing lifecycle.

## Acceptance criteria

- A generic Mastodon client or OAuth platform can register, authorize with supported or recognized official non-admin scopes, exchange a token, verify credentials, and revoke the token.
- Login and core daily workflows work without client-name or User-Agent exceptions.
- Every documented Mastodon 4.6.3 non-admin REST method and path in scope is registered.
- Existing timelines, posting, media, notification, search, list, interaction, and streaming behavior does not regress.
- Profile updates, reports, announcements, scheduled statuses, status history, translation, account notes, follower removal, directory, peers, and activity use real Misskey state where specified.
- Unsupported collection reads, singleton reads, and writes follow their declared empty, 404, and 422 policies after correct auth and scope checks.
- No unsupported write returns a fabricated success.
- Instance version and capability reporting remains conservative.
- No admin or experimental API is implemented.
- No migration, native entity schema change, locale edit outside `ja-JP.yml`, or generated misskey-js API change is introduced.
- Focused and full Mastodon/OAuth unit suites pass; no E2E coverage is claimed.
