# Mastodon Stateful Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace high-impact fake Mastodon user API fallbacks with durable, bounded, protocol-compatible behavior while keeping native Misskey behavior unchanged.

**Architecture:** A single `mastodon_user_state` entity is the authoritative store for compatibility-only resources. Focused Mastodon services own validation and conversion, while `MastodonApiServerService` only authenticates, parses HTTP input, and delegates. Native resources continue through `MastodonApiCallService`; Web Push and streaming reuse native delivery infrastructure with isolated adapters.

**Tech Stack:** TypeScript, NestJS 11, Fastify 5, TypeORM/PostgreSQL, Redis, `web-push`, Vitest.

## Global Constraints

- Implement non-admin Mastodon APIs only.
- Use exactly one new migration and one new table.
- Do not add Megalodon as a runtime dependency or make loopback HTTP calls.
- Do not modify existing merged migrations.
- Add SPDX headers to every new backend TypeScript/JavaScript file.
- Preserve existing Misskey REST and ActivityPub behavior.
- Use TDD: every production behavior begins with a test that is observed failing for the intended reason.
- Keep unavailable features truthful with `404` or `422`; never add new fabricated empty success responses.

---

### Task 1: Compatibility state entity and persistence service

**Files:**
- Create: `packages/backend/src/models/MastodonUserState.ts`
- Create: `packages/backend/migration/1784221450402-mastodon-user-state.js`
- Create: `packages/backend/src/server/api/mastodon/MastodonApiStateService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonApiStateService.test.ts`
- Modify: `packages/backend/src/di-symbols.ts`
- Modify: `packages/backend/src/models/_.ts`
- Modify: `packages/backend/src/models/RepositoryModule.ts`
- Modify: `packages/backend/src/postgres.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`

**Interfaces:**
- Produces `MastodonApiStateService.list/get/put/compareAndSet/delete/deleteExpired`.
- `put` consumes `{ userId, tokenId?, kind, key, value, expiresAt? }` and returns the stored row.
- `compareAndSet` consumes an expected integer version and throws `MastodonApiError(409, 'conflict', ...)` when no row is updated.

- [ ] **Step 1: Write the failing persistence service tests**

```ts
test('stores one independently versioned value per user, kind, and key', async () => {
	const first = await service.put({ userId: 'u1', kind: 'marker', key: 'home', value: { lastReadId: '1' } });
	const second = await service.put({ userId: 'u1', kind: 'marker', key: 'home', value: { lastReadId: '2' } });
	expect(second.version).toBe(first.version + 1);
});

test('rejects a stale conditional write', async () => {
	await expect(service.compareAndSet({ userId: 'u1', kind: 'marker', key: 'home', expectedVersion: 1, value: { lastReadId: '3' } }))
		.rejects.toMatchObject({ statusCode: 409, code: 'conflict' });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonApiStateService.test.ts`

Expected: FAIL because `MastodonApiStateService` does not exist.

- [ ] **Step 3: Add the entity, repository wiring, reversible migration, and minimal service**

The entity uses `(userId, kind, key)` as a unique index, integer `version`, JSONB `value`, cascading user/token foreign keys, and the timestamps defined in the design. The migration's `down()` drops `mastodon_user_state` and no other object.

- [ ] **Step 4: Run the focused test and backend typecheck**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonApiStateService.test.ts`

Run: `pnpm --filter backend typecheck`

Expected: PASS.

### Task 2: Stateful v2/v1 filters and markers

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonFilterService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonFilterService.test.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonMarkerService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonMarkerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`

**Interfaces:**
- `MastodonFilterService` produces CRUD methods for v2 filters, keywords, statuses, v1 projections, and `apply(userId, context, statuses)`.
- `MastodonMarkerService.get(userId, timelines)` and `.update(userId, body)` produce Mastodon marker objects with `last_read_id`, `version`, and `updated_at`.

- [ ] **Step 1: Write failing filter and marker behavior tests**

```ts
test('projects a v2 keyword as a v1 filter', async () => {
	const filter = await service.createV2('u1', { title: 'spoilers', context: ['home'], filter_action: 'warn', keywords: [{ keyword: 'ending', whole_word: true }] });
	expect(await service.listV1('u1')).toMatchObject([{ id: filter.keywords[0].id, phrase: 'ending', context: ['home'] }]);
});

test('hide removes a matching status and warn annotates it', async () => {
	expect(await service.apply('u1', 'home', statuses)).toEqual([expect.objectContaining({ filtered: [expect.any(Object)] })]);
});

test('updates home and notifications markers independently', async () => {
	expect(await markers.update('u1', { home: { last_read_id: '10' }, notifications: { last_read_id: '20' } }))
		.toMatchObject({ home: { last_read_id: '10' }, notifications: { last_read_id: '20' } });
});
```

- [ ] **Step 2: Verify RED with both focused test files**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonFilterService.test.ts src/server/api/mastodon/MastodonMarkerService.test.ts`

Expected: FAIL because both services are absent.

- [ ] **Step 3: Implement bounded state services and replace all filter/marker fallback routes**

Limits are 100 filters/user, 20 keywords/filter, 100 statuses/filter, 100 characters/title, 200 characters/keyword, and 256 KiB total serialized filter state. Context values are `home`, `notifications`, `public`, `thread`, and `account`; actions are `warn`, `hide`, and `blur`.

- [ ] **Step 4: Apply filters to authenticated status collections**

Extend `statusesWithState` with a context argument. It loads one filter snapshot and returns statuses after `MastodonFilterService.apply`; public unauthenticated calls skip user filters.

- [ ] **Step 5: Run focused tests and the existing Mastodon server suite**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonFilterService.test.ts src/server/api/mastodon/MastodonMarkerService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts`

Expected: PASS.

### Task 3: Tags, endorsements, collections, domain blocks, and status mute

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonUserFeatureService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonUserFeatureService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`

**Interfaces:**
- The service produces followed/featured tag CRUD, endorsement CRUD, and collection CRUD with membership operations.
- Collection values use `{ schemaVersion: 1, title, description, items: string[] }` and enforce 100 collections/user and 200 items/collection.

- [ ] **Step 1: Write failing CRUD and ownership tests**

```ts
test('normalizes followed tags and makes follow idempotent', async () => {
	await service.followTag('u1', 'MissKey');
	await service.followTag('u1', '#misskey');
	expect(await service.listFollowedTags('u1')).toHaveLength(1);
});

test('cannot read another users collection', async () => {
	const collection = await service.createCollection('u1', { title: 'Friends' });
	await expect(service.getCollection('u2', collection.id)).rejects.toMatchObject({ statusCode: 404 });
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonUserFeatureService.test.ts`

Expected: FAIL because the service is absent.

- [ ] **Step 3: Implement the service and real routes**

Register followed/featured tag, endorsement/pin, collection, domain block, and status mute routes before `registerCompatibilityRoutes`. Domain blocks call `i`/`i/update`; status mute calls the two native thread-muting endpoints.

- [ ] **Step 4: Merge followed tags into the home timeline with bounded fan-in**

Read at most 20 followed tags, fetch at most `min(100, limit * 3)` tagged notes, merge with the native home page, sort descending by ID, de-duplicate, and then apply Mastodon pagination and filters.

- [ ] **Step 5: Run focused and server tests**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonUserFeatureService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts`

Expected: PASS.

### Task 4: Conversations and grouped notification state

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonConversationService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonConversationService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonNotificationService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonNotificationService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`

**Interfaces:**
- `MastodonConversationService.list/read/unread/delete` returns Mastodon `Conversation` objects from a bounded native note query.
- `MastodonNotificationService.group` produces stable group keys and `accounts_count`, `notifications_count`, `most_recent_notification_id`, and `page_min_id`.
- Notification policy and request state use `MastodonApiStateService`.

- [ ] **Step 1: Write failing conversation watermark and grouping tests**

```ts
test('a deleted conversation reappears after a newer direct note', async () => {
	await service.delete('u1', 'thread-1', '100');
	expect(service.isVisible({ deletedThroughId: '100' }, '101')).toBe(true);
});

test('groups reactions to the same status with a stable key', () => {
	const groups = service.group([reactionA, reactionB]);
	expect(groups).toMatchObject([{ group_key: `favourite-${statusId}`, notifications_count: '2' }]);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonConversationService.test.ts src/server/api/mastodon/MastodonNotificationService.test.ts`

Expected: FAIL for missing conversation/group behavior.

- [ ] **Step 3: Implement bounded direct-note derivation and stateful actions**

Query at most 200 latest `specified` notes where the user is author or in `visibleUserIds`, batch-pack through `NoteEntityService`, group by `threadId ?? id`, and return at most 40 conversations after watermark filtering.

- [ ] **Step 4: Implement v2 groups, unread counts, policies, and request actions**

Use the existing native notification page as the only activity source. Compatibility state may hide, group, accept, dismiss, or mark it; it must not synthesize an underlying activity.

- [ ] **Step 5: Run focused and server tests**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonConversationService.test.ts src/server/api/mastodon/MastodonNotificationService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts`

Expected: PASS.

### Task 5: Web Push subscriptions and isolated delivery

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonPushNotificationService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonPushNotificationService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/core/PushNotificationService.ts`
- Modify: `packages/backend/src/core/CoreModule.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`

**Interfaces:**
- `create/get/update/delete` are token-owned subscription methods.
- `deliver(userId, type, body)` catches per-subscription delivery failures and never throws into native delivery.
- Token encryption helpers use AES-256-GCM and HKDF-SHA256 with context `misskey-mastodon-push-token-v1`.

- [ ] **Step 1: Write failing crypto, validation, and lifecycle tests**

```ts
test('round trips a bearer without storing plaintext', () => {
	const encrypted = encryptBearer('raw-token', vapidPrivateKey);
	expect(JSON.stringify(encrypted)).not.toContain('raw-token');
	expect(decryptBearer(encrypted, vapidPrivateKey)).toBe('raw-token');
});

test('replaces the subscription for the same OAuth token', async () => {
	await service.create(auth, 'raw-token', firstInput);
	await service.create(auth, 'raw-token', secondInput);
	expect((await state.list(auth.user.id, 'push_subscription'))).toHaveLength(1);
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonPushNotificationService.test.ts`

Expected: FAIL because the service and crypto helpers are absent.

- [ ] **Step 3: Implement subscription REST behavior and delivery**

Validate HTTPS endpoints, base64url key sizes, alert types, policy, and maximum serialized size. Return 404 for GET/PUT when absent and idempotent `{}` for DELETE.

- [ ] **Step 4: Add the native delivery hook with failure isolation**

Invoke Mastodon delivery only after VAPID configuration is known. Native and Mastodon loops each handle their own errors; no Mastodon exception may reject `PushNotificationService.pushNotification`.

- [ ] **Step 5: Run push and native notification tests**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonPushNotificationService.test.ts src/core/PushNotificationService.test.ts`

Expected: PASS; if no native push unit file exists, run the entire focused Mastodon directory instead.

### Task 6: Streaming protocol completion

**Files:**
- Create: `packages/backend/src/server/api/mastodon/MastodonStreamSession.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonStreamSession.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`

**Interfaces:**
- `MastodonStreamSession.subscribe/unsubscribe/close` owns native channel IDs and event conversion.
- WebSocket output remains `{ event, payload: JSON.stringify(value), stream: [name] }`.
- SSE output is `event: <event>\ndata: <json>\n\n` with heartbeat comments.

- [ ] **Step 1: Write failing multiplex, filter, direct, and SSE frame tests**

```ts
test('subscribes and unsubscribes a multiplexed websocket stream', async () => {
	await session.handleClientMessage({ type: 'subscribe', stream: 'hashtag', tag: 'misskey' });
	expect(native.connectChannel).toHaveBeenCalledOnce();
	await session.handleClientMessage({ type: 'unsubscribe', stream: 'hashtag', tag: 'misskey' });
	expect(native.disconnectChannel).toHaveBeenCalledOnce();
});

test('formats an SSE event', () => {
	expect(mastodonSseEvent('update', { id: '1' })).toBe('event: update\ndata: {"id":"1"}\n\n');
});
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonStreamSession.test.ts src/server/api/mastodon/MastodonStreamingApiServerService.test.ts`

Expected: FAIL for missing session/SSE/multiplex behavior.

- [ ] **Step 3: Extract the session and implement dynamic WebSocket messages**

Keep the existing one-megabyte buffer limit, 30-second ping, 90-second timeout, token revocation handling, and 1000-note de-duplication bound.

- [ ] **Step 4: Add health and SSE routes**

`GET /api/v1/streaming/health` returns `OK`. Authenticated SSE paths use the same parser, scopes, native channels, filters, and cleanup as WebSocket.

- [ ] **Step 5: Run streaming and all Mastodon unit tests**

Run: `pnpm --filter backend test --run src/server/api/mastodon`

Expected: all Mastodon unit tests pass.

### Task 7: Contract truthfulness, instance metadata, documentation, and final verification

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `CHANGELOG.md`
- Verify generated files under `packages/misskey-js/src/autogen/` only if the native Misskey endpoint schema changes.

**Interfaces:**
- Implemented stateful routes are marked `implemented` and registered explicitly.
- Remaining unavailable routes preserve explicit errors and are not advertised as capabilities.
- Instance v2 advertises `4.4.0 (compatible; Misskey ...)` and `{ mastodon: 5 }` only after its corresponding behavior tests pass.

- [ ] **Step 1: Write failing contract assertions**

```ts
test('does not leave high-impact stateful resources on fallback handlers', () => {
	const paths = ['/api/v2/filters', '/api/v1/markers', '/api/v1/conversations', '/api/v1/push/subscription'];
	expect(MASTODON_4_6_USER_ROUTES.filter(route => paths.includes(route.path)).every(route => route.behavior === 'implemented')).toBe(true);
});
```

- [ ] **Step 2: Verify RED, then update the manifest and instance metadata**

Run: `pnpm --filter backend test --run src/server/api/mastodon/MastodonApiServerService.test.ts`

Expected before the manifest change: FAIL; expected after it: PASS.

- [ ] **Step 3: Add one CHANGELOG server entry**

Add `- Enhance: Improve Mastodon API filters, markers, conversations, notifications, Web Push, and streaming compatibility` under `## Unreleased` → `### Server`.

- [ ] **Step 4: Run repository-required verification**

Run:

```text
pnpm --filter backend test --run src/server/api/mastodon
pnpm --filter backend typecheck
pnpm --filter backend check-migrations
pnpm build-misskey-js-with-types
pnpm lint
```

Expected: every command exits 0. `build-misskey-js-with-types` must not leave unexplained generated diffs.

- [ ] **Step 5: Review and commit intentionally**

Inspect `git diff --check`, `git diff --stat`, all new SPDX headers, migration `up/down`, locale safety, and the final contract fallback count. Then create scoped commits on `pari-dev` without bypassing hooks.
