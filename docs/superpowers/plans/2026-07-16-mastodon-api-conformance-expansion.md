# Mastodon 4.3 Core API Conformance Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the generic Mastodon client experience by aligning entity serialization, search, trends, suggestions, and tag endpoints with the Mastodon 4.3 core API contract.

**Architecture:** Keep Misskey as the source of truth and add a translation layer only under the Mastodon API server. Map compatible behavior to existing native Misskey endpoints, derive only bounded read-only projections where no native equivalent exists, and reject unsupported semantics explicitly instead of silently ignoring them.

**Tech Stack:** TypeScript, Fastify, NestJS dependency injection, Misskey native API invocation, Vitest, `mfm-js`.

## Global Constraints

- Do not inspect client names, User-Agent values, redirect URI schemes, or request fingerprints.
- Target the public Mastodon 4.3 core client API contract, not individual applications.
- Do not add or modify a database migration.
- Do not modify native Misskey entity fields or persistence semantics.
- Do not change native Misskey API endpoint metadata, `paramDef`, or response schemas. Therefore `misskey-js` regeneration is not expected.
- Do not run backend E2E, federation, browser, or external-client tests. Use unit tests and Fastify injection only.
- Preserve existing OAuth scope and explicit-token validation behavior.
- Use only bounded native reads; do not fetch external URLs or persist derived trend data.
- Add SPDX headers to any new source file. This plan expects no new source files.
- Before every commit and before handoff, follow `shipping-misskey-change`.

---

## Task 1: Make Mastodon entity serialization contract-complete

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`

- [ ] **Step 1: Add a failing test for an account without a banner**

Create a fixture whose `bannerUrl` is `null`, serialize it with `account()`, and assert that both header fields contain the same absolute local URL:

```ts
const account = service.account(userWithoutBanner);

expect(account.header).not.toBe('');
expect(account.header_static).toBe(account.header);
expect(new URL(account.header).origin).toBe('https://misskey.example');
```

- [ ] **Step 2: Add failing tests for central tag and trend-link serializers**

Assert the Mastodon-compatible shapes without inventing activity history:

```ts
expect(service.tag('Fediverse')).toEqual({
	name: 'Fediverse',
	url: 'https://misskey.example/tags/Fediverse',
	history: [],
});

expect(service.trendLink('https://example.com/article')).toMatchObject({
	url: 'https://example.com/article',
	title: 'https://example.com/article',
	description: '',
	type: 'link',
	history: [],
});
```

Also assert that all required preview-card fields are present with stable empty/default values.

- [ ] **Step 3: Run the entity service test and confirm it fails for the new requirements**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts
```

Expected: failures for the empty account header and missing `tag()` / `trendLink()` methods.

- [ ] **Step 4: Implement the serializers**

In `account()`, compute one header value and use it for both Mastodon fields:

```ts
const header = user.bannerUrl ?? new URL('/static-assets/user-unknown.png', this.config.url).toString();
```

Add `tag(name)` that builds the local tag URL and returns an empty history array. Add `trendLink(url)` that returns the complete Mastodon Trends::Link / PreviewCard-compatible shape, using the URL as the deterministic title and leaving unavailable metadata empty. Do not perform an external fetch.

- [ ] **Step 5: Run the focused test and confirm it passes**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts
```

Expected: pass.

- [ ] **Step 6: Review and commit Task 1**

Run `git diff --check`, follow `shipping-misskey-change`, then commit only these entity changes:

```powershell
git add packages/backend/src/server/api/mastodon/MastodonEntityService.ts packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts
git commit -m "fix(backend): complete Mastodon entity fallbacks"
```

---

## Task 2: Add reusable offset pagination links

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonPaginationService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonPaginationService.ts`

- [ ] **Step 1: Add failing offset-pagination tests**

Cover these cases for `offsetLinkHeader(requestUrl, offset, limit, hasMore)`:

- first page with more results: `rel="next"` only;
- middle page with more results: both `rel="next"` and `rel="prev"`;
- final non-first page: `rel="prev"` only;
- first/final page: `null`;
- unrelated query parameters remain unchanged.

Use an expected URL such as:

```ts
expect(header).toContain('<https://misskey.example/api/v1/trends/tags?limit=10&offset=20>; rel="next"');
```

- [ ] **Step 2: Run the pagination test and confirm the new test fails**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonPaginationService.test.ts
```

Expected: failure because `offsetLinkHeader()` does not exist.

- [ ] **Step 3: Implement `offsetLinkHeader()`**

Parse the request URL, preserve its query string, and set/remove only `offset`. Use `offset + limit` for next, and `Math.max(0, offset - limit)` for previous. Return a comma-separated RFC-style Link header or `null` when neither relation exists.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonPaginationService.test.ts
```

Expected: pass.

- [ ] **Step 5: Review and commit Task 2**

Run `git diff --check`, follow `shipping-misskey-change`, then commit:

```powershell
git add packages/backend/src/server/api/mastodon/MastodonPaginationService.ts packages/backend/src/server/api/mastodon/MastodonPaginationService.test.ts
git commit -m "feat(backend): add Mastodon offset pagination links"
```

---

## Task 3: Implement trends, suggestions, and tag metadata routes

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`

- [ ] **Step 1: Replace the tests that lock trend routes to empty arrays**

Add route-level Fastify injection tests for:

- `GET /api/v1/trends/statuses` mapping `notes/featured` to Mastodon statuses;
- `GET /api/v1/trends/tags` mapping `hashtags/trend` to `{ name, url, history: [] }`;
- `GET /api/v1/trends/links` extracting unique HTTP(S) links from bounded featured notes;
- legacy `GET /api/v1/trends` behaving like `/api/v1/trends/tags`;
- public access with no token;
- rejection of an explicitly supplied invalid token;
- `limit` and `offset` slicing plus Link response headers.

Update the entity-service mock with `tag()` and `trendLink()`, and the pagination mock with `offsetLinkHeader()`.

- [ ] **Step 2: Add failing tests for suggestions and tag metadata**

For `GET /api/v2/suggestions`, assert:

- a user token with `read:accounts` is required;
- `users/recommendation` receives bounded `limit` and `offset` values;
- every result has both compatibility fields:

```ts
{
	source: 'global',
	sources: ['most_followed'],
	account: mastodonAccount,
}
```

For `GET /api/v1/tags/:name`, assert that the route calls `hashtags/show`, returns the central tag shape, remains public, and validates any explicit token.

- [ ] **Step 3: Add failing tests for bounded trend-link derivation**

Supply featured notes with MFM link and URL nodes, duplicates, non-HTTP schemes, and invalid URLs. Assert that the result:

- includes only unique `http:` and `https:` URLs;
- preserves first-seen order;
- obeys the requested page;
- never invokes an external fetch;
- returns an empty history array and complete required card fields.

- [ ] **Step 4: Run the route tests and confirm the new cases fail**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts
```

Expected: failures because trends are placeholders and suggestions/tag metadata routes do not exist.

- [ ] **Step 5: Implement status and tag trends**

Replace placeholder routes with native-first mappings:

```ts
await this.invokePublic(auth, 'notes/featured', { limit: boundedReadLimit });
await this.invokePublic(auth, 'hashtags/trend', {});
```

For offset pagination, fetch at most 100 records and request one record beyond the visible page when possible so `hasMore` can be determined. Slice only in the Mastodon translation layer. Convert results through existing status serialization and the new `tag()` method.

Use `withOptionalUser(..., ['read:statuses'])` for status trends so authenticated user state is preserved. Use `withOptionalToken()` for public tag trends and tag metadata, preserving explicit-token validation.

- [ ] **Step 6: Implement bounded trend-link projection**

Import `extract` from `mfm-js`. Read at most 100 featured notes, parse note text, select MFM `url` and `link` node URLs, validate through `new URL()`, accept only `http:` and `https:`, and deduplicate with a `Set`.

Do not fetch OpenGraph data, resolve redirects, write a cache, or persist history. Serialize through `trendLink()` and paginate the derived list.

- [ ] **Step 7: Implement suggestions and tag metadata**

Register:

```text
GET /api/v2/suggestions
GET /api/v1/tags/:name
```

Suggestions must use `withAuth(..., ['read:accounts'])` and `users/recommendation`. Tag metadata must verify existence through `hashtags/show` and then use `tag()`; it must not expose Misskey's incompatible 10-minute chart as Mastodon daily history.

- [ ] **Step 8: Run the focused route tests and confirm they pass**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts
```

Expected: pass.

- [ ] **Step 9: Review and commit Task 3**

Run `git diff --check`, follow `shipping-misskey-change`, then commit:

```powershell
git add packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts
git commit -m "feat(backend): implement Mastodon discovery routes"
```

---

## Task 4: Make search parameter-aware and support safe URL resolution

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`

- [ ] **Step 1: Add failing tests for search type dispatch**

For anonymous `GET /api/v2/search?q=...`, assert a response always contains all three arrays:

```ts
{
	accounts: [],
	statuses: [],
	hashtags: [],
}
```

Then cover:

- `type=accounts` invokes only `users/search`;
- `type=statuses` invokes only `notes/search`;
- `type=hashtags` invokes only `hashtags/search`;
- no `type` invokes all three compatible searches;
- an invalid `type` returns HTTP 400;
- `account_id`, `max_id`, `min_id`, `limit`, and `offset` are translated to native filters where supported.

- [ ] **Step 2: Add failing tests for Mastodon search authentication rules**

Assert:

- public search works when `resolve` is absent/false and `offset` is absent;
- `resolve=true` without a user token returns 401;
- the presence of `offset` without a user token returns 401, including `offset=0`;
- a user token needs the mapped `read:search` scope;
- an app token cannot satisfy a user-authenticated resolve request;
- an explicitly invalid bearer token is rejected even for otherwise-public search.

- [ ] **Step 3: Add failing tests for URL resolution**

With `resolve=true` and a user token, cover both `ap/show` result variants:

- `{ type: 'Note', object: note }` populates `statuses` when the requested type allows statuses;
- `{ type: 'User', object: user }` populates `accounts` when the requested type allows accounts;
- type filtering prevents the other result kind from leaking into the response;
- safe not-found resolver errors produce empty arrays rather than a server error;
- non-HTTP(S) query strings never invoke `ap/show`.

- [ ] **Step 4: Run the route tests and confirm the search cases fail**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts
```

Expected: failures because the current route always authenticates, ignores `type`/`resolve`, and returns no hashtags.

- [ ] **Step 5: Implement search request validation and auth selection**

Validate `type` against `accounts | hashtags | statuses`. Determine user-auth requirement from semantics, not client identity:

```ts
const requiresUser = resolve === true || Object.hasOwn(request.query, 'offset');
```

Use the existing user-auth wrapper for required requests. For public requests, use optional-user auth so a valid user token can still affect serialization, an app token remains anonymous, and an explicitly invalid token is rejected.

- [ ] **Step 6: Implement native search dispatch**

Map normal searches to:

- accounts: `users/search`;
- hashtags: `hashtags/search` followed by `tag()` serialization;
- statuses: `notes/search` followed by status serialization.

Invoke only the selected type, or all compatible searches concurrently when type is absent. Keep the stable three-array response envelope in every success case.

- [ ] **Step 7: Implement safe URL resolution**

Only when `resolve=true`, the query parses as HTTP(S), and a user is authenticated, invoke native `ap/show`. This reuses Misskey's existing federation allowlist and SSRF protections. Convert returned Notes/Users using existing entity serializers and respect the requested `type`.

Catch only known resolver not-found/request-failed `ApiError` codes as an empty result. Propagate unexpected errors so infrastructure or programming failures are not hidden.

- [ ] **Step 8: Run the focused route tests and confirm they pass**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts
```

Expected: pass.

- [ ] **Step 9: Review and commit Task 4**

Run `git diff --check`, follow `shipping-misskey-change`, then commit:

```powershell
git add packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts
git commit -m "feat(backend): align Mastodon search semantics"
```

---

## Task 5: Reject unsupported compound tag-timeline filters

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`

- [ ] **Step 1: Add failing contract tests**

For `GET /api/v1/timelines/tag/:tag`, assert each non-empty unsupported filter returns HTTP 422 and does not invoke `notes/search-by-tag`:

```text
any[]
all[]
none[]
```

Also assert the ordinary single-tag route still maps to `notes/search-by-tag`, and existing `only_media` / `local` behavior is unchanged.

- [ ] **Step 2: Run the route test and confirm the unsupported-filter cases fail**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts
```

Expected: failures because these parameters are currently ignored.

- [ ] **Step 3: Implement explicit rejection**

Before native invocation, normalize each compound-filter value with the existing query helper and reject the request when any list is non-empty. Return the established Mastodon error envelope with status 422. Do not pretend these filters were applied.

- [ ] **Step 4: Run the focused route test and confirm it passes**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts
```

Expected: pass.

- [ ] **Step 5: Review and commit Task 5**

Run `git diff --check`, follow `shipping-misskey-change`, then commit:

```powershell
git add packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts
git commit -m "fix(backend): reject unsupported Mastodon tag filters"
```

---

## Task 6: Changelog, complete focused validation, and API review

**Files:**

- Modify: `CHANGELOG.md`
- Verify: all files changed since `31f976c619`

- [ ] **Step 1: Add one server changelog entry**

Under `## Unreleased` → `### Server`, add a single non-client-specific line:

```markdown
- Enhance: Improve Mastodon API compatibility for search, trends, suggestions, tags, and entity responses
```

Avoid duplicating existing Mastodon compatibility entries.

- [ ] **Step 2: Run the focused entity, pagination, and route tests together**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts src/server/api/mastodon/MastodonPaginationService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts
```

Expected: pass.

- [ ] **Step 3: Run the complete Mastodon unit-test directory**

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon
```

Expected: pass.

- [ ] **Step 4: Run the established broader OAuth/Mastodon regression set**

Run:

```powershell
pnpm --filter backend test -- --run test/unit/mastodon-oauth-token-migration.ts src/server/api/mastodon src/server/api/endpoints/i/apps.test.ts src/server/api/endpoints/i/revoke-token.test.ts src/server/oauth/OAuth2ProviderService.test.ts
```

Expected: pass. Do not run `test:e2e`, `test:fed`, browser tests, or external client tests.

- [ ] **Step 5: Run static and migration checks**

Run:

```powershell
pnpm --filter backend lint
pnpm lint
pnpm --filter backend check-migrations
git diff --check
```

Record pre-existing repository failures separately from failures introduced by this work. If the migration check cannot connect to the configured local test database, report that environmental block verbatim; do not create a migration to silence it.

- [ ] **Step 6: Prove the change stayed within its compatibility layer**

Run:

```powershell
git diff --name-only 31f976c619 -- packages/backend/migration packages/backend/src/models packages/misskey-js/src/autogen locales
```

Expected: no output. This proves there is no new migration, native model change, generated native API schema change, or locale edit.

Also inspect the full diff for client names or request fingerprinting:

```powershell
git diff 31f976c619 -- packages/backend/src/server/api/mastodon | Select-String -Pattern 'Ice Cubes|Elk|NeoDB|User-Agent|redirect_uri'
```

Expected: no client-specific compatibility branch.

- [ ] **Step 7: Request the required Mastodon API review**

Use the repository's API reviewer on the complete diff. Ask it to verify:

- Mastodon 4.3 response shapes and auth semantics;
- OAuth scope enforcement and explicit-token validation;
- pagination and input bounds;
- safe use of `ap/show` rather than custom remote fetching;
- absence of native entity/schema/migration changes;
- generic behavior with no client fingerprinting.

Address every actionable finding with another red/green test cycle, then rerun the focused suite.

- [ ] **Step 8: Review and commit Task 6**

Follow `shipping-misskey-change`, stage the changelog and any review fixes, then commit:

```powershell
git add CHANGELOG.md packages/backend/src/server/api/mastodon
git commit -m "docs: record Mastodon API conformance improvements"
```

- [ ] **Step 9: Perform final handoff verification**

Run:

```powershell
git status --short
git log --oneline -7
```

The worktree should be clean. Report exact passed test counts, any unrelated lint failures, and any database-dependent migration-check limitation. Do not claim E2E coverage.
