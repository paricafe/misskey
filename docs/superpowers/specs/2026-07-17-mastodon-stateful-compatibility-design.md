# Mastodon Stateful Compatibility Design

## Goal

Maximize compatibility of Misskey's non-admin Mastodon REST and streaming API while preserving the native Misskey API behavior, avoiding an HTTP loopback compatibility stack, and limiting persistence changes to one migration and one compatibility-owned table.

## Compatibility baseline

- The protocol contract is Mastodon 4.4 / Mastodon API version 5 for advertised capabilities.
- Newer non-admin routes may be implemented when they have a faithful Misskey mapping, but the instance does not advertise a higher version merely because a route exists.
- Sharkey's Megalodon adapter is a mapping reference, not a runtime dependency. Requests continue to enter through Fastify and call Misskey's internal `ApiCallService` bridge.
- Admin APIs, annual reports, donation campaigns, and features with no trustworthy local source remain unavailable and return an explicit `404` or `422` instead of fabricated success data.

## Persistence boundary

Add one `mastodon_user_state` table. Each row represents one independently mutable compatibility resource.

| Column | Meaning |
| --- | --- |
| `id` | Misskey ID for the state row |
| `userId` | Owning local user, cascading on user deletion |
| `tokenId` | Optional Mastodon OAuth token owner, cascading on token deletion |
| `kind` | Runtime-validated resource discriminator; no PostgreSQL enum |
| `key` | Resource key within the kind |
| `value` | Versioned JSONB payload |
| `version` | Optimistic concurrency counter |
| `createdAt`, `updatedAt` | Audit timestamps |
| `expiresAt` | Optional expiry used by filters and transient state |

The unique key is `(userId, kind, key)`. Secondary indexes cover `(userId, kind, updatedAt)`, `tokenId`, and `expiresAt`. PostgreSQL is authoritative. Redis may carry cache invalidations and stream events, but a Redis flush must not lose user REST state.

`MastodonApiStateService` is the persistence gateway. Feature services validate their JSON schema and enforce resource limits before calling it. Updates that expose a version use a conditional write and return HTTP 409 on stale versions.

## REST mappings

### Filters

- Mastodon v2 filters are canonical and store title, contexts, action, expiry, keywords, and explicit status matches.
- Mastodon v1 filters are a projection over v2 keywords. A v1 resource ID is the keyword ID, matching upstream's compatibility behavior.
- Per-user counts, title/keyword lengths, and total serialized size are bounded.
- Matching is literal, case-insensitive Unicode matching. `whole_word` uses Unicode letter/number boundaries; users cannot submit regular expressions.
- `hide` removes a status from collection responses and stream delivery. `warn` and `blur` retain the status and populate `filtered`.
- A request loads one filter snapshot, then performs pure in-memory matching without per-status database reads.

### Markers

- `home` and `notifications` are stored independently.
- Writes use optimistic versions and update timestamps atomically. Stale writes return 409.
- Unknown timelines are rejected with 422.

### Conversations

- Conversations derive from visible `specified` notes. The query is bounded and uses existing `visibleUserIds`, `mentions`, `threadId`, and note ID indexes.
- `threadId ?? note.id` is the opaque conversation ID.
- State stores read/unread and delete watermarks. A deleted conversation can reappear when a newer direct note arrives.
- Conversion packs notes in one batch and collects participants without N+1 endpoint calls.

### Tags, endorsements, collections, and domain blocks

- Followed tags, featured tags, endorsements, and collections live in compatibility state.
- The Mastodon home timeline merges a bounded `notes/search-by-tag` result for followed tags and de-duplicates by note ID.
- Featured tag responses derive usage statistics from native hashtag/note data.
- Domain blocks use native `UserProfile.mutedInstances` through `i` and `i/update`; no duplicate compatibility state is created.
- Status mute/unmute uses native `notes/thread-muting/create` and `notes/thread-muting/delete`.

### Notifications

- v1 continues to expose native individual notifications.
- v2 groups the same bounded native notification page deterministically by Mastodon type and target. Group dismissal is stateful.
- Notification policy and requests are compatibility state layered over native notifications. Policy `drop` suppresses matching notifications; `filter` exposes requests; accept/dismiss changes only compatibility visibility and never reverses the underlying federated activity.

## Web Push

- One subscription is allowed per Mastodon OAuth token, keyed by `tokenId`.
- The stored payload contains endpoint, `p256dh`, `auth`, `standard`, alert switches, policy, and the OAuth bearer encrypted with AES-256-GCM.
- The encryption key is derived with HKDF-SHA256 from the instance VAPID private key and a fixed context string. The bearer is never stored in plaintext or logged. VAPID rotation invalidates old subscriptions, which is consistent with the changed server public key.
- Delivery reuses `web-push` and the existing VAPID keys. Native and Mastodon subscriptions are delivered independently; a compatibility failure cannot abort native Misskey delivery.
- Permanent Web Push failures remove only the corresponding Mastodon subscription. Retryable failures remain for the next notification.
- VAPID capability is advertised only when the service worker and both VAPID keys are configured.

## Streaming and availability

- A transport-neutral stream session feeds both WebSocket and SSE adapters.
- WebSocket supports initial query/path streams plus multiplex `subscribe` and `unsubscribe` messages.
- SSE supports the standard streaming paths, event framing, heartbeat comments, cancellation, and the same scopes as WebSocket.
- `GET /api/v1/streaming/health` returns `OK`.
- Followed tags attach bounded native hashtag channels. State invalidations add or remove channels without process restarts.
- Filters are applied before emission. Filter changes emit `filters_changed`.
- Direct updates emit `conversation`; completed notification request merges emit `notifications_merged`.
- Every session has a one-megabyte output limit, heartbeat timeout, note-ID de-duplication, and cleanup on token revocation, user suspension/deletion, client close, or server shutdown.

## Original-system impact

Changes outside `server/api/mastodon` are limited to:

- one entity and repository registration;
- one migration;
- provider registration;
- one isolated hook inside native push delivery;
- the server module wiring needed for REST and streaming.

No existing Misskey REST endpoint contract, ActivityPub behavior, or admin API is changed.

## Verification

- Unit tests cover state validation and concurrency, v1/v2 filter projections and matching, markers, grouped notifications, conversation watermarks, encrypted push payloads, and stream protocol behavior.
- Route contract tests prove stateful routes are no longer fallback handlers and unavailable routes remain explicit.
- Backend typecheck/lint, focused Mastodon tests, migration consistency, misskey-js generation check, SPDX check, and CHANGELOG review run before commit.
