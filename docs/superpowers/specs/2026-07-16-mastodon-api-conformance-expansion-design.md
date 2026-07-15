# Mastodon 4.3 Core API Conformance Expansion Design

**Status:** Approved for implementation on 2026-07-16

## Context

The branch already contains an isolated Mastodon-compatible OAuth, REST, and foreground-streaming layer. It supports dynamic application registration, application and user tokens, token management, common accounts/statuses/timelines/media/notification/list operations, and conservative capability discovery. The implementation deliberately reuses Misskey endpoint executors and keeps Mastodon credentials separate from native Misskey credentials.

Recent compatibility failures expose protocol-level gaps rather than application-specific defects:

- some Mastodon entities contain syntactically invalid values for required URL fields;
- some public discovery routes return unconditional empty arrays even when Misskey has equivalent ranked data;
- search ignores `type` and `resolve`, cannot resolve ActivityPub URLs, and always requires a user token;
- several standard read routes are absent even though native Misskey endpoints can supply equivalent data;
- unsupported semantics are sometimes hidden behind successful empty responses instead of being distinguished from an actually empty result.

This design extends the existing compatibility layer by Mastodon API contract. It must not inspect a client name, User-Agent, redirect scheme, or request fingerprint to select behavior.

## Goals

- Use Mastodon 4.3 core client API behavior as the compatibility baseline currently advertised by the instance document.
- Make existing response entities structurally decodable by strict clients, including valid absolute URLs and required legacy/current fields.
- Complete common discovery, trends, suggestions, tags, and search flows using native Misskey data.
- Support URL resolution through the existing ActivityPub resolver with Misskey federation and request-safety checks intact.
- Apply Mastodon authentication, scope, query, pagination, and error semantics consistently across public, app-token, and user-token routes.
- Replace misleading placeholders when an equivalent native data source exists.
- Keep all changes inside the Mastodon compatibility boundary and existing generic conversion services.
- Avoid database migrations and changes to native Misskey entities, endpoint schemas, and generated misskey-js API types.
- Validate with unit and Fastify injection tests only; do not run backend end-to-end tests.

## Non-goals

- Client-specific branches or acceptance logic tied to particular applications.
- Claiming complete Mastodon 4.3 server parity, administrative API parity, or compatibility with every historical extension.
- Adding persistence for scheduled statuses, Web Push subscriptions, followed hashtags, featured hashtags, filters, markers, conversations, grouped notifications, or link-trend history.
- Implementing Mastodon 4.4–4.6-only features such as newer quote controls or grouped-notification policy APIs.
- Making Mastodon tokens valid on native Misskey API routes or native tokens valid on Mastodon routes.
- Weakening redirect validation, scope validation, ActivityPub federation allowlists, SSRF protection, or native endpoint authorization.

## Compatibility baseline and capability policy

The server continues to identify itself as `4.3.0 (compatible; Misskey <version>)` and to advertise `api_versions.mastodon = 1`. The compatibility statement means the implemented core client surface follows Mastodon 4.3 entity and method contracts; it does not claim every optional endpoint.

Capability reporting must be conservative:

- advertise only implemented streaming and configuration features;
- return a Mastodon-style 404 or explicit 422 for unsupported operations whose semantics cannot be represented safely;
- return an empty collection only when the underlying supported collection is actually empty or when an existing documented compatibility placeholder has no truthful native equivalent;
- never acknowledge an unsupported write as successful.

## Architecture

### Contract-driven routing

All work stays under `packages/backend/src/server/api/mastodon/` and the existing OAuth provider integration. `MastodonApiServerService` owns route policy and native endpoint composition. `MastodonEntityService` owns all Mastodon entity construction. `MastodonApiCallService` remains the only bridge to native Misskey endpoint executors.

Routes are selected by HTTP path and Mastodon parameters only. No client identifier or User-Agent is passed to entity conversion or route selection.

### Native-first mappings

Use an existing native endpoint whenever the semantics align:

| Mastodon contract | Misskey source |
| --- | --- |
| trending statuses | `notes/featured` |
| trending tags | `hashtags/trend` |
| account suggestions | `users/recommendation` |
| hashtag search | `hashtags/search` |
| tag metadata | `hashtags/show` |
| ActivityPub URL resolution | `ap/show` |
| ordinary status search | `notes/search` |
| ordinary account search | existing user search endpoints |

Native calls continue through `ApiCallService.invoke`, preserving parameter validation, scope-derived Misskey permissions, rate limits, user suspension/move checks, federation policy, and telemetry.

### Derived read-only projections

When Misskey has relevant public data but not the exact Mastodon aggregate, the compatibility layer may build a bounded, read-only projection without persistence:

- Tag history remains an empty array unless daily counts matching Mastodon semantics are available. Misskey's short-window unique-user chart must not be relabelled as daily status usage.
- Trending links may be projected from unique HTTP(S) links contained in the same bounded `notes/featured` result used for trending statuses. Each link is emitted as a valid Mastodon `Trends::Link`/PreviewCard with conservative metadata and empty history. The route must not perform new external fetches, claim daily counts, or store ranking state.
- Suggestion results wrap `users/recommendation` accounts with both deprecated `source: "global"` and Mastodon 4.3 `sources: ["most_followed"]`.

These projections are deterministic for a request, bounded by the endpoint limit, and contain no new server-side state.

## Entity conformance

### Account and CredentialAccount

All URL-valued fields required by Mastodon are non-empty absolute URLs. In particular, accounts without an uploaded banner receive an existing local static fallback URL for both `header` and `header_static`; the compatibility layer never emits an empty string for these fields.

Legacy and current fields required by common 4.3 decoders remain present together where Mastodon retains backward compatibility. CredentialAccount continues to add plain-text `source` data without changing native packed user objects.

### Tag

Tag conversion is centralized and returns:

- normalized `name`;
- an absolute local `/tags/<encoded-name>` URL;
- `history` as an array;
- `following` only when the server has a real followed-tag state, which this phase does not add.

The same converter is used by trends, search, and tag-detail routes.

### PreviewCard and Trends::Link

Link projections include the complete stable PreviewCard shape expected by Mastodon 4.3: valid `url`, non-null string fields, `type: "link"`, `authors`, legacy author/provider fields, dimensions, nullable image/blurhash, embed/html fields, and `history`. Unknown information is represented conservatively instead of omitted with an invalid type.

### Status

Existing status conversion remains the canonical representation for timelines, trends, URL-resolved search, and interactions. URL resolution must pass imported notes through the same state-aware converter so `uri`, `url`, `reblogged`, `bookmarked`, and `pinned` retain consistent semantics.

## Search behavior

`GET /api/v2/search` is implemented as a parameter-aware dispatcher:

- require non-empty `q` and clamp `limit` to Mastodon limits;
- accept `type` only from `accounts`, `hashtags`, or `statuses` and skip unrelated native searches when it is present;
- allow anonymous search only when `resolve` is false/absent and `offset` is absent, matching the public Mastodon contract;
- require a user token with `read:search` for `resolve=true`, `offset`, or authenticated-only filters;
- for an HTTP(S) URL with `resolve=true`, call `ap/show`; include a returned note in `statuses` or a returned user in `accounts` according to `type`;
- use `hashtags/search` for tag search and convert names through the central Tag converter;
- pass supported account/status filters and pagination inputs to the native endpoint; reject unsafe or unsupported combinations rather than silently changing meaning;
- always return the three-array envelope `{ accounts, statuses, hashtags }`.

ActivityPub resolver failures are translated to a Mastodon-style empty search result for an ordinary not-found remote object, while invalid input, forbidden federation, rate limiting, and internal failure retain their appropriate error status.

## Trends, suggestions, and tags

### Trends

- `GET /api/v1/trends` remains the deprecated alias for tags.
- `GET /api/v1/trends/tags` maps `hashtags/trend` to Tag entities.
- `GET /api/v1/trends/statuses` maps `notes/featured` to Status entities.
- `GET /api/v1/trends/links` returns bounded link projections from featured public notes.

All routes are public, validate an explicitly supplied bearer token, clamp documented `limit`/`offset`, and generate offset-based `Link` headers when another page is available.

### Suggestions

`GET /api/v2/suggestions` requires a user token and a scope allowed by Mastodon's `read` umbrella. It maps `limit` and `offset` to `users/recommendation`, returns Suggestion wrappers, and never returns bare Account objects.

### Tags

`GET /api/v1/tags/:name` is public and maps `hashtags/show` to the central Tag entity. The existing tag timeline continues to use `notes/search-by-tag`; supported local/media/cursor inputs are mapped, and unsupported compound tag filters are rejected explicitly rather than ignored.

Followed-tag and featured-tag mutations remain outside this phase because Misskey has no equivalent collection semantics. Their current read-only placeholders must be documented by tests and must not be used to advertise follow support.

## Authentication, errors, and pagination

- Public routes accept no token, a valid app token, or a valid user token; an explicitly malformed or unknown bearer token returns 401.
- User-only routes reject application tokens and enforce the narrow Mastodon scope before native invocation.
- Missing or malformed required parameters return 400; unsupported but syntactically valid behavior returns 422; inaccessible records return 404; missing/invalid credentials return 401; insufficient scope returns 403.
- Error bodies remain Mastodon-shaped and never expose native Misskey error objects or stack traces.
- Cursor-based collections keep existing opaque-ID pagination. New offset-based trend routes retain `limit` and `offset` in RFC 8288 `Link` URLs and do not coerce IDs to numbers.

## Test strategy

Implementation follows red-green-refactor and uses only backend unit/Fastify injection tests.

The conformance suite is organized by protocol behavior rather than client:

1. Account URL fields are absolute and non-empty for users with and without custom media.
2. Public, app-token, user-token, invalid-token, and insufficient-scope matrices for every new or changed route.
3. Search authentication rules, `type` dispatch, hashtag conversion, ordinary full-text search, ActivityPub URL resolution, and resolver error translation.
4. Trending status/tag/link shapes, limits, offsets, and `Link` headers.
5. Suggestion wrapper shape and native recommendation mapping.
6. Tag metadata and tag-timeline parameter validation.
7. Regression coverage for JSON and form bodies, repeated query/form keys, opaque IDs, and URL encoding.
8. Existing Mastodon OAuth, REST, notification, media, and streaming unit suites remain green.

No `test:e2e`, `test:fed`, browser automation, or external client run is part of this work. Repository lint and migration checking are attempted at final verification; known unrelated lint failures and unavailable local database services are reported rather than hidden.

## Migration and rollback

This phase adds no entity, column, table, index, or migration. It changes only compatibility routes, converters, tests, and the server changelog if needed.

Rollback is a normal code revert. Native Misskey data and OAuth token rows created by the already-shipped compatibility layer are unchanged.

## Acceptance criteria

- No production path contains a client-name, User-Agent, or redirect-scheme special case.
- Existing OAuth registration, authorization-code, client-credentials, revocation, and access-token management tests remain green.
- Strict JSON decoders can parse Account/CredentialAccount responses for bannerless users.
- Public trend routes return native/derived results in Mastodon entity shapes instead of unconditional placeholders when data exists.
- Authenticated suggestions return complete Suggestion wrappers.
- Search honors `type`, authentication conditions, hashtags, and `resolve=true` ActivityPub URLs.
- Tag metadata is available and the tag timeline rejects unsupported filters explicitly.
- No migration or native Misskey API schema change is present.
- Focused non-E2E tests pass, followed by the repository-required API review and shipping checks.
