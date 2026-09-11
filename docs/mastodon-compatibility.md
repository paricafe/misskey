# Mastodon compatibility gateway

`packages/mastodon-compat` owns the Mastodon protocol. It is an independent workspace package and can run as a separate HTTP/WebSocket service. It accesses Misskey through its public HTTP API and streaming protocol; it does not import NestJS, TypeORM entities, repositories, native business services, or the internal event bus. There are no client-name or User-Agent branches.

```mermaid
flowchart LR
  Client[Mastodon client] --> Gateway[Mastodon gateway]
  Gateway --> SQLite[Private compatibility SQLite]
  Gateway --> HTTP[Public Misskey HTTP API]
  Gateway --> WS[Public Misskey WebSocket API]
  HTTP --> Native[Native permissions and business services]
  WS --> Native
```

## Installation and authorization

The normal Misskey build includes the workspace package. `enableMastodonApi` defaults to `true`; setting it to `false` disables the embedded gateway. Native OAuth and the native UI remain in use. The integration shares the original `/oauth/authorize` and `/oauth/token` paths by dispatching only gateway client IDs to the gateway. Native clients retain their original handlers.

Mastodon registration creates a gateway application. Authorization redirects to the normal MiAuth consent page with the required native permissions. A one-time callback exchanges the approved MiAuth session for a one-time OAuth code, then a compatibility bearer token. Native account master tokens are neither copied nor accepted as compatibility bearer tokens. Tokens granted to applications stay subject to native revocation, account restrictions, permissions, rate limits, and visibility rules.

**Existing compatibility clients must register and authorize again after this rewrite.** Their old credentials are not silently converted into a native application grant. Remove and re-add the account in clients that cache the old registration. The ordinary Misskey login and native application grants are unaffected.

PKCE S256 and registered custom-scheme redirects are supported. OOB redirects display an authorization code. `lang` is an optional hint; the MiAuth page uses native language settings. `force_login=true` is explicitly rejected because the unchanged native consent page cannot guarantee forced account selection.

## Private state and rollback

The gateway keeps its own SQLite database, defaulting to `.mastodon-compat/compat.sqlite` in the installation directory. Configure an absolute private location when deploying:

```yaml
enableMastodonApi: true
mastodonApiStoragePath: /var/lib/misskey-mastodon/compat.sqlite
```

Mount that directory as a persistent writable volume in containers. Do not place it under the public Drive/file directory. Back up the SQLite database and adjacent `compat.sqlite.key` together, with writes stopped or a consistent SQLite backup. Restoring the database without its encryption key cannot recover native grants. Files are restricted to their owner; bearer/client credentials are hashed, and native grants and pending authorization payloads are encrypted with AES-256-GCM.

The gateway uses SQLite WAL and synchronous transactions for authorization/state changes. Processes on one host can share the same local SQLite database. A deployment across multiple hosts should route the compatibility service to one persistent gateway instance; a network filesystem is not a substitute for a shared database service.

This rewrite adds **no PostgreSQL migration**. The three previously deployed compatibility migrations, tables, and entity schema declarations remain as legacy data. They are not used by the new runtime. Retaining them avoids modifying deployed migration history, avoids implicit schema drops, and allows rollback to the previous release. A rollback must restore the previous application build as well as its matching configuration; it does not migrate new SQLite state back into the old tables.

## Standalone mode

```sh
pnpm --filter @pari/mastodon-compat build
MASTODON_PUBLIC_URL=https://social.example \
MISSKEY_NATIVE_URL=http://127.0.0.1:3000 \
MASTODON_DATABASE=/var/lib/misskey-mastodon/compat.sqlite \
pnpm --filter @pari/mastodon-compat start
```

The gateway listens on `127.0.0.1:3100` by default (`MASTODON_HOST` and `MASTODON_PORT` override it). A same-origin reverse proxy must route Mastodon API/streaming URLs and the compatibility OAuth requests to this service, and native API, `/miauth/`, UI resources, and ActivityPub URLs to Misskey. Avoid routing every `/api/` request to the gateway: native Misskey also uses that prefix. When native OAuth is needed on the same origin, use the embedded dispatcher or an equivalent explicit routing setup for the overlapping OAuth paths.

The standalone service uses real HTTP and WebSocket connections to the fixed native upstream. Embedded mode uses a small HTTP injection transport to preserve the actual caller IP for native rate limiting and still crosses the complete native API validation/authentication path. It does not call endpoint classes directly.

## Protocol coverage

| Area | Behavior |
| --- | --- |
| Encoding and errors | JSON, URL-encoded bracket parameters, and multipart forms; CORS; Mastodon-shaped errors; native rate-limit response headers. |
| OAuth | Registration, authorization code, PKCE, client-credentials token, own-client revoke, application verification, native grant revocation. |
| Accounts | Credential verification and updates, avatars/headers, lookup/search, relationships, following/followers, requests, blocks/mutes, lists. |
| Statuses | Creation, replies/direct recipients, deletion, editing and native revision history, context, favourites, bookmarks, boosts, pins, thread mute, public/home/tag/list timelines. |
| Media and polls | Native Drive uploads and ownership checks, descriptions and focus metadata, attached files, polls and atomic multi-choice voting. |
| Notifications | v1 notifications and v2 stable singleton groups, cross-page lookups, shared dismiss/clear state, and marker-based unread counts. |
| Discovery | Instance metadata/rules/peers, custom emoji, directory, suggestions, tags/trending notes, search via public native APIs. |
| User state | v1/v2 filters with keyword/status rules, reading markers, direct conversation read/hide state, preferences, announcements. |
| Streaming | User/status/notification, public/local/remote/media, hashtag and list subscriptions, full subscription identity, visible edits/deletes, direct conversations. |

Favourites map to heart reactions (`❤`/`❤️`). Creating a favourite returns a conflict if another reaction exists, and removing a favourite preserves a different native emoji. The native reaction endpoints expose optional conditional-write parameters; existing callers retain their previous defaults. The native poll endpoint accepts an optional `choices` array so one submitted ballot is one native transaction; existing `choice` requests still work.

Status language/sensitivity, attachment focus, OAuth state, filters, and markers live in the gateway store. Compatibility metadata does not add fields to native notes or change the federated ActivityPub representation. Native media descriptions still use the native Drive update semantics. A sensitive compatibility status does not rewrite a shared file's sensitivity.

## Explicit limits

This is a practical compatibility implementation, not a claim of complete Mastodon 4.6 conformance. Unsupported writes return errors rather than reporting that work was performed.

- Push delivery and scheduled publishing are not implemented by this gateway. Existing native Misskey push/scheduled-note features keep their own behavior.
- Poll editing, custom replacement thumbnails, quote approval policies, and Mastodon Collections are not implemented.
- Conversation discovery scans at most the latest 1,000 native entries per incoming/outgoing source. It does not provide a full historical conversation index.
- Reply context traversal returns at most 100 visible descendants and performs at most 200 native child-page reads.
- Remote search, translation, public timelines and uploads remain subject to native server configuration, connectivity, and permissions.
- Node.js must satisfy the repository's engine range, including the built-in `node:sqlite` module.

## Verification

The independent package contains real HTTP and WebSocket transport tests, OAuth/state persistence tests, serializer/security regression cases, and route contract tests. `packages/backend/test/e2e/mastodon-api.ts` exercises the gateway against an actual Misskey service, PostgreSQL, and Redis, including MiAuth authorization, JSON/form/multipart publishing, concurrent idempotency, both pagination directions, media uploads, visibility, reactions, polls, lists, notifications, revocation, and streaming. It also checks authorization persistence across a standalone gateway restart and embedded shutdown with an active stream. The native test host recreates its PostgreSQL schema on restart, so its reset endpoint cannot establish native credential persistence.

```sh
pnpm --filter @pari/mastodon-compat test
pnpm --filter backend test:e2e --run test/e2e/mastodon-api.ts
pnpm build-misskey-js-with-types
node scripts/check-shipping.mjs --base HEAD
```

The e2e suite needs the standard ignored `.config/test.yml` and test PostgreSQL/Redis instances. Passing protocol tests does not establish that every third-party application's UI has been exercised. Client UI and live federation acceptance remain separate checks.

Local rewrite validation on 2026-09-12:

| Check | Result |
| --- | --- |
| Gateway protocol, transport, persistence and lifecycle tests | PASS: 97 tests |
| Real Misskey HTTP/WebSocket with PostgreSQL and Redis | PASS: 12 e2e tests |
| Native reaction, poll, OAuth, token, report, push and scheduled-note regressions | PASS: 39 tests in 8 suites |
| Gateway/backend TypeScript and generated `misskey-js` API types | PASS |
| Changed-file lint, SPDX and locale safety | PASS |
| Native entities and deployed migrations | Unchanged; no PostgreSQL migration added |
| Docker image and individual third-party client UI | Not executed |

The native e2e harness retains its existing controller-server exit warning (`close timed out after 10000ms`); all 12 assertions pass and the runner exits with code 0. This warning is separate from the active-stream gateway shutdown tests.

References: [Mastodon API guidelines](https://docs.joinmastodon.org/api/guidelines/), [OAuth](https://docs.joinmastodon.org/methods/oauth/), [Mastodon entities](https://docs.joinmastodon.org/entities/), [MiAuth](https://misskey-hub.net/en/docs/for-developers/api/token/miauth/). The package follows the HTTP-adapter architecture used by Megalodon; it is implemented against the current public native APIs rather than importing an obsolete Misskey SDK or native backend internals.
