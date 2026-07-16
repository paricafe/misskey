# Mastodon 4.6.3 User API Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Misskey usable through generic Mastodon clients and Mastodon-OAuth platforms by covering the documented Mastodon 4.6.3 non-admin user API with real Misskey mappings where possible and truthful compatibility responses everywhere else.

**Architecture:** Keep `MastodonApiServerService` as the Fastify entry point, add a declarative route contract for coverage and fallback registration, keep all response projection in `MastodonEntityService`, and add only two narrow bridge services where native endpoints discard response data. OAuth discovery and userinfo remain in the existing OAuth provider. No database schema or migration changes are allowed.

**Tech Stack:** TypeScript, NestJS dependency injection, Fastify, Vitest, TypeORM repositories already present in Misskey, existing Misskey endpoint executors and packed entities.

## Global Constraints

- Follow `working-on-backend` for every change under `packages/backend/` and `shipping-misskey-change` before handoff.
- Follow red-green-refactor. Run the named focused test after each red and green step.
- Do not add or edit an entity, table, column, index, or migration.
- Do not edit any locale file.
- Do not add admin routes, admin scopes, `/api/v1_alpha/**`, or client/User-Agent-specific behavior.
- Do not return success for unsupported state-changing operations. Return Mastodon-shaped `422` after authentication and scope validation.
- Do not raise the advertised Mastodon version or `api_versions.mastodon` value.
- Do not run or add backend E2E, federation, browser, or external-client tests.
- Add the AGPL SPDX header to every new TypeScript file.
- Keep opaque IDs as strings.
- Use official Mastodon v4.6.3 routes, documentation, serializers, and controllers as the contract. Megalodon is only a compatibility smoke-reference.
- The repository-wide `pnpm lint` baseline currently fails in unrelated backend/frontend files. Record those pre-existing failures and require all focused tests, changed-file lint/type checks where available, and `git diff --check` to pass.

---

## Task 1: Add the official route contract and truthful fallback dispatcher

**Files:**

- Create: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.test.ts`

- [ ] **Step 1: Write the failing contract tests**

Add tests that:

1. iterate every Fastify entry in `MASTODON_4_6_USER_ROUTES` and assert `fastify.hasRoute({ method, url: path })`;
2. reject duplicate method/path pairs;
3. reject paths beginning `/api/v1/admin/`, `/api/v2/admin/`, or `/api/v1_alpha/`;
4. require every `introducedIn` value to be a Mastodon semantic version no newer than `4.6.3`;
5. prove a safe collection read returns `[]` only after its documented auth/scope check;
6. prove a safe object read returns `{}`;
7. prove an unavailable singleton returns Mastodon `404`;
8. prove an unsupported write returns `401` without a token, `403` with insufficient scope, and `422` with an authorized token;
9. prove an application token is rejected with `401` on a user-only route, not `422`;
10. prove a missing required fallback parameter returns `400` before token validation.

In `MastodonStreamingApiServerService.test.ts`, iterate WebSocket entries and assert `isMastodonStreamingPath(samplePath)` plus the existing token/scope/stream-category behavior.

Use representative routes in these behavior tests:

- `GET /api/v2/filters` for a safe collection;
- `GET /api/v1/markers` for a safe object;
- `GET /api/v1/push/subscription` for an unavailable singleton;
- `POST /api/v1/filters` for an unsupported write.

Run:

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts src/server/api/mastodon/MastodonStreamingApiServerService.test.ts
```

Expected: FAIL because the contract and missing routes do not exist.

- [ ] **Step 2: Define the contract types and complete route table**

Create these exported types in `MastodonApiContract.ts`:

```ts
export type MastodonContractAuth = 'public' | 'token' | 'user';
export type MastodonContractBehavior =
	| 'implemented'
	| 'safe-array'
	| 'safe-object'
	| 'singleton-not-found'
	| 'unsupported-write';

export interface MastodonContractRoute {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	path: string;
	samplePath: string;
	auth: MastodonContractAuth;
	scope?: string | readonly string[];
	entity: string;
	introducedIn: string;
	behavior: MastodonContractBehavior;
	transport?: 'fastify' | 'websocket';
	fallbackBody?: readonly unknown[] | Readonly<Record<string, unknown>>;
	requiredBody?: readonly string[];
	requiredQuery?: readonly string[];
}
```

Export `MASTODON_4_6_USER_ROUTES` as a `readonly MastodonContractRoute[]`. Populate it with every route in the appendix and the method documentation's first-available version. Mark routes already registered by the current service as `implemented`. Initially mark future real mappings from Tasks 3–9 with the appropriate fallback behavior; each later task changes its completed routes to `implemented` in the same commit.

Populate `requiredBody` and `requiredQuery` for every fallback route whose official method has mandatory parameters. Populate `fallbackBody` whenever `{}` or `[]` would omit a required envelope field, for example `{ count: 0 }` for notification unread counts. Before authentication, the dispatcher must reject a missing required value or a value of the wrong top-level JSON/form type with Mastodon `400`. Native implementations continue relying on their focused normalizers and native endpoint validation.

For every dynamic `path`, provide a concrete `samplePath`, for example `/api/v1/statuses/:id` -> `/api/v1/statuses/status-id`. Mark streaming entries `transport: 'websocket'`; all other entries default to `fastify`. Represent the two streaming contracts as `/api/v1/streaming` and `/api/v1/streaming/:stream`, with samples `/api/v1/streaming` and `/api/v1/streaming/user`.

- [ ] **Step 3: Implement fallback registration**

Replace `registerSafeEmptyRoutes` with `registerCompatibilityRoutes`. Loop only over Fastify entries whose behavior is not `implemented`, and register them with `fastify.route`.

Add a token helper with this contract:

```ts
private async withToken<T>(
	request: MastodonRequest,
	scope: string | readonly string[] | undefined,
	action: (auth: MastodonAuth) => Promise<T>,
): Promise<T>
```

`withToken` accepts valid application or user tokens and asserts `scope` when provided; for an alternatives array, check `MastodonScopeService.allows` and throw the same `403 insufficient_scope` error when none match. Allow `withOptionalToken` to accept the same optional scope form, asserted only when a token was supplied. Allow `withAuth`'s scope argument to be omitted or to be an alternatives array for official routes that require a user token but no named scope or accept multiple scopes. `withAuth` remains user-only, and application tokens must now produce `MastodonApiError(401, 'unauthorized', ...)`. Task 2 replaces the inline alternatives check with `assertAny`.

Dispatch behavior exactly as follows:

| Behavior | Result after authentication/scope checks |
| --- | --- |
| `safe-array` | the declared array `fallbackBody`, defaulting to `[]` |
| `safe-object` | the declared object `fallbackBody`, defaulting to `{}` |
| `singleton-not-found` | `MastodonApiError(404, 'not_found', 'Record not found')` |
| `unsupported-write` | `MastodonApiError(422, 'unprocessable_entity', 'This operation is not supported by this server')` |

For public routes, use `withOptionalToken` so an explicitly supplied invalid bearer token still returns `401`. For token routes, use `withToken`. For user routes, use `withAuth`.

- [ ] **Step 4: Run the contract tests**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts src/server/api/mastodon/MastodonStreamingApiServerService.test.ts
```

Expected: PASS. Fastify startup itself is the duplicate-registration guard.

- [ ] **Step 5: Commit the route surface**

```powershell
git add packages/backend/src/server/api/mastodon/MastodonApiContract.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts packages/backend/src/server/api/mastodon/MastodonStreamingApiServerService.test.ts
git commit -m "feat(mastodon): cover official user API routes"
```

---

## Task 2: Recognize official scopes and add OAuth userinfo

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonScopeService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonScopeService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/oauth/OAuth2ProviderService.ts`
- Modify: `packages/backend/src/server/oauth/OAuth2ProviderService.test.ts`

- [ ] **Step 1: Write failing scope tests**

Add assertions that:

- `profile`, `read:collections`, and `write:collections` normalize successfully;
- they appear in OAuth metadata;
- `profile` maps only to `read:account`;
- the two collection scopes map to no Misskey permission;
- `admin:read`, `admin:write`, and an unknown scope are rejected;
- `profile` allows only a route requiring `profile`, not `read:accounts`;
- `allowsAny(['read'], ['profile', 'read:accounts'])` succeeds through the generic `read` parent;
- `read` and `write` retain their existing granular-parent behavior.

Run the scope test and confirm it fails.

- [ ] **Step 2: Extend the scope policy**

Add the three official non-admin scopes. Keep collections recognized-but-unmapped. Add `profile` to the granular permission table with `['read:account']`, but do not make it a child of generic `read`; its OpenID-style meaning remains distinct. Add `allowsAny(tokenScopes, requiredScopes)` and `assertAny(tokenScopes, requiredScopes)` so routes such as Profile can accept any one of the official alternatives without broadening an individual scope. Refactor the alternatives-array branches in `withToken`, `withOptionalToken`, and `withAuth` to call `assertAny`.

- [ ] **Step 3: Write failing OAuth metadata and userinfo tests**

Expand the OAuth test fixture so it can create a Fastify server through `OAuth2ProviderService.createServer`. Add tests for:

- `userinfo_endpoint === 'https://misskey.example/oauth/userinfo'` in `generateRFC8414()`;
- both `GET /userinfo` and `POST /userinfo`;
- bearer token extraction, including case-insensitive `Bearer`;
- missing/invalid/application token -> `401`;
- user token without `profile` -> `403`;
- successful response and `Cache-Control: no-store`.

Expected userinfo body:

```ts
{
	iss: 'https://misskey.example/',
	sub: user.uri ?? 'https://misskey.example/users/<user-id>',
	name: user.name ?? user.username,
	preferred_username: user.username,
	profile: 'https://misskey.example/@<username>',
	picture: user.avatarUrl ?? 'https://misskey.example/avatar/@<username>',
}
```

- [ ] **Step 4: Implement userinfo before the OAuth wildcard route**

Inject `MastodonAuthenticateService` and `MastodonScopeService` into `OAuth2ProviderService` after `MastodonOAuthService`, update every constructor fixture, and register GET/POST `/userinfo` before `fastify.post('')` and any not-found behavior. Authenticate through the shared service, require a user token, assert `profile`, return the exact body above, and call `applyNoStore(reply)`.

Add `userinfo_endpoint` to `generateRFC8414()` without altering grant types, issuer, PKCE, or token endpoints.

- [ ] **Step 5: Run focused tests**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonScopeService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts src/server/oauth/OAuth2ProviderService.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit OAuth compatibility**

```powershell
git add packages/backend/src/server/api/mastodon/MastodonScopeService.ts packages/backend/src/server/api/mastodon/MastodonScopeService.test.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/oauth/OAuth2ProviderService.ts packages/backend/src/server/oauth/OAuth2ProviderService.test.ts
git commit -m "feat(mastodon): add profile scope and userinfo"
```

---

## Task 3: Implement Profile and credential-account updates

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`

- [ ] **Step 1: Write failing Profile entity tests**

Add `profile(user)` tests for all required Mastodon 4.6 fields:

```ts
{
	id, display_name, note, fields,
	formatted_note, formatted_fields,
	avatar, avatar_static, avatar_description,
	header, header_static, header_description,
	locked, bot, hide_collections, discoverable, indexable,
	show_media, show_media_replies, show_featured,
	attribution_domains, featured_tags,
}
```

Use `null` for absent Profile avatar/header URLs, empty descriptions, `hide_collections: false`, `indexable: false`, `show_media: true`, `show_media_replies: true`, `show_featured: true`, and empty arrays for attribution domains and featured tags. Preserve the existing Account entity's non-null default avatar/header behavior.

In the same red test, bring Account and CredentialAccount up to the serializer fields clients consume in 4.6: Account adds `avatar_description: ''`, `header_description: ''`, `show_media: true`, `show_media_replies: true`, `show_featured: true`, and `feature_approval: { automatic: [], manual: [], current_user: null }`; CredentialAccount `source` adds `hide_collections: false`, `discoverable: user.isExplorable ?? false`, `indexable: false`, `attribution_domains: []`, and `quote_policy: 'public'`. Assert Profile, Account, and CredentialAccount expose internally consistent defaults.

- [ ] **Step 2: Implement `MastodonEntityService.profile`**

Build raw and formatted note/field variants from the packed user. Use the service's existing MFM-to-HTML path for formatted values. Extend `account` and `credentialAccount` with the fields covered by Step 1. Do not return a native packed user.

- [ ] **Step 3: Write failing route tests**

Cover:

- `GET /api/v1/profile` with any one of `profile`, `read`, or `read:accounts`, and rejection with an unrelated scope;
- `PATCH /api/v1/profile` and `PATCH /api/v1/accounts/update_credentials` with `write:accounts`;
- JSON and URL-encoded field names;
- multipart avatar and header upload using Drive-backed `drive/files/create`;
- `DELETE /api/v1/profile/avatar` and `/header` passing `null` to `i/update`;
- `display_name -> name`, `note -> description`, `locked -> isLocked`, `discoverable -> isExplorable`, `bot -> isBot`, and ordered `fields_attributes -> fields`;
- `source[privacy]`, `source[sensitive]`, `source[language]`, `avatar_description`, `header_description`, `hide_collections`, `indexable`, `show_media`, `show_media_replies`, `show_featured`, and `attribution_domains` returning `422` only when requesting a value different from the converter's current non-persisted default;
- both update routes re-fetching `i` and returning Profile or CredentialAccount respectively.

Set multipart `files` limit to `2`. Iterate `request.parts()` for profile updates, persist only `avatar` and `header`, and clean every temporary file in `finally`.

- [ ] **Step 4: Implement focused profile registration methods**

Add:

```ts
private registerProfile(fastify: FastifyInstance): void
private async updateProfile(request: MastodonRequest, response: 'profile' | 'credential-account'): Promise<Dictionary>
```

Use `MastodonScopeService.assertAny` for Profile reads and the existing single-scope assertion for writes. Reuse the current media upload safety path (`createTemp`, `pipeline`, `drive/files/create`) instead of reading uploads into memory. Reject unexpected multipart file fields with `400`.

Update these contract entries to `implemented`:

- `GET/PATCH /api/v1/profile`;
- `DELETE /api/v1/profile/avatar`;
- `DELETE /api/v1/profile/header`;
- `PATCH /api/v1/accounts/update_credentials`.

- [ ] **Step 5: Run focused tests**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit profile support**

```powershell
git add packages/backend/src/server/api/mastodon/MastodonEntityService.ts packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts packages/backend/src/server/api/mastodon/MastodonApiContract.ts
git commit -m "feat(mastodon): implement profile updates"
```

---

## Task 4: Create real abuse reports and return the actual report identity

**Files:**

- Modify: `packages/backend/src/core/AbuseReportService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonReportService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonReportService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`

- [ ] **Step 1: Write failing report service tests**

The new service accepts a local reporter and:

```ts
interface MastodonReportInput {
	accountId: string;
	comment: string;
	category: 'spam' | 'violation' | 'other';
	statusIds: string[];
	ruleIds: string[];
	collectionIds: string[];
	forwardToDomains: string[];
	forward: boolean;
}
```

Test missing `account_id` -> `400`, missing target -> `404`, self-report -> `422`, administrator target -> `422`, and success -> the exact `MiAbuseUserReport` inserted by `AbuseReportService`, its ID-derived creation time, and the resolved target packed user. An omitted API comment is normalized to `''`, not rejected. Verify status IDs, rule IDs, collection IDs, category, forwarding intent, and forward-to domains are appended to the persisted report comment as a bounded, human-readable context block because the existing report model has no separate fields.

- [ ] **Step 2: Return reports from `AbuseReportService.report`**

Change only its return value:

```ts
await Promise.all([
	this.abuseReportNotificationService.notifyAdminStream(reports),
	this.abuseReportNotificationService.notifySystemWebhook(reports, 'abuseReport'),
	this.abuseReportNotificationService.notifyMail(reports),
]);
return reports;
```

Existing callers may continue ignoring the result. Do not change an endpoint schema or persistence shape.

- [ ] **Step 3: Implement and register `MastodonReportService`**

Inject `GetterService`, `RoleService`, `AbuseReportService`, `UserEntityService`, and `IdService`. Reproduce the native `users/report-abuse` protections exactly: resolve the target, reject self-report, reject administrator target, then call `report`. Pack the target for the reporter and derive `createdAt` from the inserted report ID. Always persist a context header even when the API comment is empty. Cap the final persisted comment at 2048 characters without splitting a UTF-16 surrogate pair.

Register it in `ServerModule` and inject it into `MastodonApiServerService` immediately before the Redis dependency. Update the server test constructor in the same order.

- [ ] **Step 4: Add the Report converter and route**

`MastodonEntityService.report` must return:

```ts
{
	id: report.id,
	action_taken: report.resolved,
	action_taken_at: null,
	category: input.category,
	comment: input.comment,
	forwarded: report.forwarded,
	created_at: createdAt,
	status_ids: input.statusIds,
	rule_ids: input.ruleIds,
	collection_ids: input.collectionIds,
	target_account: account(targetUser),
}
```

Register `POST /api/v1/reports` with `write:reports`, normalize bracketed arrays, and resolve every supplied status ID through authenticated `notes/show`. Reject a status not authored by the reported account with `422`; this preserves native visibility checks and prevents arbitrary IDs from being attached as context. Then call the service and return the converter result. Change its contract behavior to `implemented`.

- [ ] **Step 5: Run focused tests**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonReportService.test.ts src/server/api/mastodon/MastodonEntityService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts
```

- [ ] **Step 6: Commit report support**

```powershell
git add packages/backend/src/core/AbuseReportService.ts packages/backend/src/server/api/mastodon/MastodonReportService.ts packages/backend/src/server/api/mastodon/MastodonReportService.test.ts packages/backend/src/server/api/mastodon/MastodonEntityService.ts packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts packages/backend/src/server/api/mastodon/MastodonApiContract.ts packages/backend/src/server/ServerModule.ts
git commit -m "feat(mastodon): create persisted abuse reports"
```

---

## Task 5: Implement announcements from existing state

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`

- [ ] **Step 1: Write failing Announcement converter tests**

Convert a packed Misskey Announcement into:

```ts
{
	id,
	content,
	starts_at: null,
	ends_at: null,
	all_day: false,
	published_at: createdAt,
	updated_at: updatedAt ?? createdAt,
	read: isRead ?? false,
	mentions: [],
	statuses: [],
	tags: [],
	emojis: [],
	reactions: [],
}
```

Build `content` by converting the announcement title and text, joined by a blank line, through the existing MFM-to-HTML converter. Escape content through that converter; do not concatenate unescaped HTML.

- [ ] **Step 2: Write failing route tests**

Test `GET /api/v1/announcements` requires a user token but no named scope, including `limit`, `max_id`, and response conversion. Test an application token is rejected. Test `POST /api/v1/announcements/:id/dismiss` requires `write:accounts`, calls `i/read-announcement`, and returns `{}`. Keep reaction PUT/DELETE routes authenticated and scoped according to the official controllers but returning `422`.

- [ ] **Step 3: Implement announcement routes**

Map list to `announcements` with bounded pagination and required user auth. Map dismiss to `i/read-announcement`. Mark only list and dismiss as `implemented` in the contract.

- [ ] **Step 4: Run tests and commit**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts
git add packages/backend/src/server/api/mastodon
git commit -m "feat(mastodon): expose announcements"
```

---

## Task 6: Implement scheduled statuses on Note drafts

**Files:**

- Create: `packages/backend/src/server/api/mastodon/MastodonScheduledStatusService.ts`
- Create: `packages/backend/src/server/api/mastodon/MastodonScheduledStatusService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/server/ServerModule.ts`

- [ ] **Step 1: Write failing scheduled-status bridge tests**

The bridge injects `NoteDraftService` and `NoteDraftEntityService` and exposes:

```ts
get(me: MiLocalUser, id: string): Promise<Packed<'NoteDraft'>>
```

It must return `404` unless the draft exists, belongs to `me`, and `isActuallyScheduled === true`. Pack through `NoteDraftEntityService`; never return a raw TypeORM entity.

- [ ] **Step 2: Write failing ScheduledStatus entity tests**

Add a converter that returns:

```ts
{
	id: draft.id,
	scheduled_at: new Date(draft.scheduledAt).toISOString(),
	params: {
		text: draft.text,
		media_ids: draft.fileIds,
		sensitive: (draft.files ?? []).some(file => file.isSensitive),
		spoiler_text: draft.cw ?? null,
		visibility: this.visibility(draft.visibility),
		in_reply_to_id: draft.replyId,
		language: null,
		application_id: null,
		poll: draft.poll == null ? null : {
			options: draft.poll.choices,
			multiple: draft.poll.multiple,
			expires_in: draft.poll.expiredAfter == null ? null : Math.ceil(draft.poll.expiredAfter / 1000),
		},
		idempotency: null,
		with_rate_limit: false,
		quoted_status_id: draft.renoteId,
		quote_approval_policy: 'nobody',
	},
	media_attachments: (draft.files ?? []).map(attachment),
}
```

Reject conversion of non-scheduled drafts or drafts without `scheduledAt` as an internal programming error.

- [ ] **Step 3: Write failing route tests**

Cover:

- `GET /api/v1/scheduled_statuses` with `read:statuses` -> `notes/drafts/list` with `scheduled: true`;
- `GET /api/v1/scheduled_statuses/:id` with `read:statuses` -> bridge service;
- `PUT /api/v1/scheduled_statuses/:id` with `write:statuses` -> `notes/drafts/update`, accepting only `scheduled_at` and preserving every other draft field;
- `DELETE /api/v1/scheduled_statuses/:id` -> `notes/drafts/delete` and `{}`;
- `POST /api/v1/statuses` with future `scheduled_at` -> `notes/drafts/create` and ScheduledStatus;
- `POST /api/v1/statuses` with `quoted_status_id` and no schedule -> `notes/create.renoteId`, while `quote_approval_policy` accepts omitted/`public` and returns `422` for other values that Misskey cannot persist;
- `POST /api/v1/statuses` returns `422` for non-empty `language` or `allowed_mentions` constraints that Misskey cannot persist or enforce;
- a past or malformed `scheduled_at` -> `422`/`400` without creating a draft;
- ownership and `isActuallyScheduled` isolation;
- text, CW, visibility, reply, quote, media, and poll mapping.

The shared mapping must set `isActuallyScheduled: true` and pass `scheduledAt` as a `Date`. Do not publish a Note when `scheduled_at` is present.

- [ ] **Step 4: Implement bridge, converter, and routes**

Register the bridge in `ServerModule`, inject it into the server before `MastodonReportService`, and update constructor fixtures. Use native `notes/drafts/create`, `list`, `update`, and `delete` for mutations/listing so native policy and validation remain active; use the bridge only for single-record retrieval.

Mark scheduled-status CRUD as implemented. `POST /api/v1/statuses` remains one implemented contract route whose response is Status or ScheduledStatus according to input.

- [ ] **Step 5: Run focused tests**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonScheduledStatusService.test.ts src/server/api/mastodon/MastodonEntityService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts
```

- [ ] **Step 6: Commit scheduled statuses**

```powershell
git add packages/backend/src/server/api/mastodon packages/backend/src/server/ServerModule.ts
git commit -m "feat(mastodon): implement scheduled statuses"
```

---

## Task 7: Add status history, translation, and quote reads

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`

- [ ] **Step 1: Write failing StatusEdit and Translation entity tests**

`statusEdits(note)` must return stored revisions oldest-to-newest followed by the current revision, with each entity containing `account`, HTML `content`, `spoiler_text`, `sensitive`, `created_at`, `media_attachments`, `emojis`, optional `poll`, and optional `quote`. Use the current Note media/poll for the current revision; use empty media/emojis and omit poll/quote for historical rows because Misskey history stores only text and CW.

`translation(result, targetLanguage)` must return `detected_source_language: result.sourceLang`, `language: targetLanguage`, `provider: null`, `spoiler_text: ''`, converted `content: render(result.text)`, `poll: null`, and `media_attachments: []`.

Extend the base Status entity regression at the same time with the Mastodon 4.6 fields `quotes_count: 0`, `tagged_collections: []`, and `quote_approval: { automatic: ['public'], manual: [], current_user: null }`. Keep `filtered: []`. The zero quote count is conservative because Misskey's `renoteCount` combines boosts and quotes and must not be misreported as a quote count. Replace the current raw Status in `quote` with the v4.6 Quote envelope `{ state: 'accepted', quoted_status: <shallow status> }`; add a private shallow conversion option that prevents recursive quote/reblog expansion while retaining the ordinary Status scalar fields.

- [ ] **Step 2: Write failing route tests**

Cover:

- public `GET /api/v1/statuses/:id/history`, with an explicitly supplied token required to carry `read` or `read:statuses`;
- user-only `POST /api/v1/statuses/:id/translate` with `read:statuses`, taking target language from body/query `lang` and then the first `Accept-Language` tag, mapped to `notes/translate.targetLang`;
- unavailable translation -> `422`, not a fabricated translation;
- token-authenticated `GET /api/v1/statuses/:id/quotes` with `read:statuses`, accepting application or user tokens, filtering `notes/renotes` to quote Notes only, and returning paginated Status entities;
- `POST /api/v1/statuses/:status_id/quotes/:id/revoke` -> authorized `422` because Misskey has no matching persisted approval state;
- `PUT /api/v1/statuses/:id/interaction_policy` -> authorized `422`.
- `PUT /api/v1/statuses/:id` preserves the existing CW when `spoiler_text` is omitted, and returns `422` for poll changes, non-empty `language`, or a non-`public` `quote_approval_policy` instead of silently dropping those semantics.
- token-authenticated `GET /api/v1/statuses?id[]=...` resolves at most 40 IDs through `notes/show`, preserves request order, omits inaccessible IDs, and returns Status entities.

- [ ] **Step 3: Implement routes and update the contract**

Use `notes/show`, its packed `history`, `notes/translate`, and `notes/renotes`. Preserve Link pagination for quote reads. Tighten the existing update handler and add the batch read as covered by Step 2. Mark history, translate, quote index, and batch status index as newly implemented.

- [ ] **Step 4: Run tests and commit**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts
git add packages/backend/src/server/api/mastodon
git commit -m "feat(mastodon): add status history and translation"
```

---

## Task 8: Implement account batch/legacy reads, notes, and follower removal

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`

- [ ] **Step 1: Write failing account-action tests**

Test:

- token-authenticated `GET /api/v1/accounts?id[]=...` with `read:accounts` resolves at most 40 users through `users/show`, preserves request order, omits inaccessible IDs, and returns Account entities;
- `GET /api/v1/suggestions` is the documented legacy projection of `users/recommendation` and returns Account entities, while the existing v2 route continues returning Suggestion envelopes;
- `POST /api/v1/accounts/:id/note` requires `write:accounts`, requires a string `comment`, calls `users/update-memo`, then returns a freshly derived Relationship;
- `POST /api/v1/accounts/:id/remove_from_followers` requires `write:follows`, calls `following/invalidate`, then returns a freshly derived Relationship;
- native not-found and permission errors are converted to Mastodon `404`/`403`;
- neither route returns success when its native write fails.

- [ ] **Step 2: Implement actions**

Add the two batch/legacy reads and both actions without changing follow/mute/block behavior. Mark them implemented in the contract. Keep suggestion dismissal, endorsements/pin/unpin/unendorse, and email-subscription writes on truthful `422` fallbacks.

- [ ] **Step 3: Run tests and commit**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonApiServerService.test.ts
git add packages/backend/src/server/api/mastodon
git commit -m "feat(mastodon): expand account compatibility routes"
```

---

## Task 9: Implement directory, peers, and weekly activity

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`

- [ ] **Step 1: Write failing discovery route tests**

Cover:

- `GET /api/v1/directory` -> `users`, with `order=active|new`, `local`, bounded `limit <= 80`, offset pagination, Account conversion, and Link headers;
- `GET /api/v1/instance/peers` -> `federation/instances`, unique lowercase host strings only;
- the already implemented `GET /api/v1/instance/rules` continues returning the same rule source used by current instance entities;
- `GET /api/v1/instance/activity` -> `charts/notes` and `charts/users`, both `span: 'day', limit: 84`, grouped into twelve seven-day buckets ordered newest-to-oldest like Mastodon;
- empty chart data -> `[]`, not invented activity.

- [ ] **Step 2: Add the activity converter**

Return exact string fields:

```ts
interface MastodonInstanceActivity {
	week: string;
	statuses: string;
	logins: string;
	registrations: string;
}
```

For each complete seven-day bucket, use the Unix start-of-week timestamp, sum `notes.local.inc` for statuses, sum `users.local.inc` for registrations, and use `'0'` for logins because Misskey has no login chart. Do not emit incomplete or misaligned buckets. Document the zero-login limitation in the converter test name.

- [ ] **Step 3: Implement discovery routes**

Use public invocation with optional-token validation. Map directory `order=new` to `sort: '-createdAt'`, `order=active` to `sort: '-updatedAt'`, always request `state: 'alive'`, and set `origin: 'local'` only when `local=true`. Preserve conservative instance metadata and the existing rules route. Mark directory, instance peers, and activity implemented. Keep domain-blocks, languages, translation-languages, terms, privacy policy, and extended-description on their declared safe-array/object/404 behaviors.

- [ ] **Step 4: Run tests and commit**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon/MastodonEntityService.test.ts src/server/api/mastodon/MastodonApiServerService.test.ts
git add packages/backend/src/server/api/mastodon
git commit -m "feat(mastodon): add directory and instance discovery"
```

---

## Task 10: Close route-family gaps and verify fallback semantics

**Files:**

- Modify: `packages/backend/src/server/api/mastodon/MastodonApiContract.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts` only if contract tests expose a registration/auth defect

- [ ] **Step 1: Add table-driven fallback behavior tests**

For every non-implemented entry, derive the expected result from its contract behavior and test it through Fastify injection. Use valid fixtures for required IDs and query parameters. Assert:

- collection reads return arrays;
- object reads return objects and include every required field declared by their `fallbackBody`;
- singleton reads return `404`;
- unsupported writes return `422` only after correct token/scope validation;
- public routes reject an explicitly invalid token;
- no fallback response contains a native error object or stack trace.

Do not special-case clients or User-Agent values.

- [ ] **Step 2: Reconcile the appendix against the contract**

Compare method/path pairs to Mastodon v4.6.3 `config/routes/api.rb` and official method documentation. Exclude admin, v1-alpha, and undocumented Rails/web routes. Verify that every appendix family is either implemented or has an explicit truthful fallback.

- [ ] **Step 3: Run the complete Mastodon/OAuth unit set**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon src/server/oauth/OAuth2ProviderService.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit the reconciled compatibility matrix**

```powershell
git add packages/backend/src/server/api/mastodon/MastodonApiContract.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts packages/backend/src/server/api/mastodon/MastodonApiServerService.ts
git commit -m "test(mastodon): enforce user API compatibility matrix"
```

---

## Task 11: Changelog, static validation, and handoff

**Files:**

- Modify: `CHANGELOG.md`
- Review: all files changed since this plan began

- [ ] **Step 1: Add the user-facing changelog entry**

Under `## Unreleased` -> `### Server`, add one line:

```md
- Enhance: Mastodon APIのOAuth・プロフィール・予約投稿などの互換性を向上
```

- [ ] **Step 2: Run final unit verification**

```powershell
pnpm --filter backend test -- --run src/server/api/mastodon src/server/oauth/OAuth2ProviderService.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run backend and repository lint and classify failures**

```powershell
pnpm --filter backend lint
pnpm lint
```

If they fail, compare output with the recorded baseline. Fix every failure in changed Mastodon/OAuth/core files. Do not edit unrelated failing files solely to make the branch green; report pre-existing failures with file names and diagnostics.

- [ ] **Step 4: Run repository safety checks**

```powershell
git diff --check
git diff --name-only 1b262eca6a..HEAD -- packages/backend/migration
git diff --name-only 1b262eca6a..HEAD -- locales
git diff --name-only 1b262eca6a..HEAD -- packages/misskey-js/src/autogen
git status --short
```

Expected:

- `git diff --check` is clean;
- no migration diff;
- no locale diff;
- no generated misskey-js diff, because this compatibility layer does not change native endpoint schemas;
- all new backend TypeScript files contain the AGPL SPDX header.

- [ ] **Step 5: Review for forbidden placeholders and compatibility lies**

```powershell
rg -n "TODO|FIXME|not implemented|return \[\]|return \{\}" packages/backend/src/server/api/mastodon packages/backend/src/server/oauth/OAuth2ProviderService.ts
```

Inspect every match. Empty responses must be driven by `MastodonApiContract` classification. Unsupported writes must throw `422`. No new direct placeholder may bypass auth or scope checks.

- [ ] **Step 6: Commit changelog and any validation-only fixes**

```powershell
git add CHANGELOG.md
git commit -m "docs: note Mastodon API compatibility improvements"
```

Before handoff, re-read `shipping-misskey-change` and report focused test results, lint baseline failures, absence of migrations/locales/generated API changes, and the exact commit range.

---

## Appendix A: Official non-admin route checklist

The contract table in Task 1 must contain these method/path pairs. Rails `PUT` reaction routes and documented `PATCH`/`PUT` aliases must use the method accepted by the official controller. Where the official documentation exposes both aliases, include both.

### Root and streaming

- `GET /api/oembed`
- `GET /api/v1/streaming`
- `GET /api/v1/streaming/:stream`

### Statuses, timelines, media, and polls

- `GET/POST /api/v1/statuses`; `GET/PUT/DELETE /api/v1/statuses/:id`
- `GET /api/v1/statuses/:id/context`, `/reblogged_by`, `/favourited_by`, `/history`, `/source`, `/quotes`
- `POST /api/v1/statuses/:id/reblog`, `/unreblog`, `/favourite`, `/unfavourite`, `/bookmark`, `/unbookmark`, `/mute`, `/unmute`, `/pin`, `/unpin`, `/translate`
- `POST /api/v1/statuses/:status_id/quotes/:id/revoke`
- `PUT /api/v1/statuses/:id/interaction_policy`
- `GET /api/v1/timelines/home`, `/public`, `/link`, `/tag/:hashtag`, `/list/:list_id`
- `POST /api/v1/media`; `GET/PUT/DELETE /api/v1/media/:id`; `POST /api/v2/media`
- `GET /api/v1/polls/:id`; `POST /api/v1/polls/:id/votes`
- `GET /api/v1/scheduled_statuses`; `GET/PUT/DELETE /api/v1/scheduled_statuses/:id`

### Accounts, profile, relationships, and lists

- `GET/POST /api/v1/accounts`; `GET /api/v1/accounts/:id`
- `GET /api/v1/accounts/verify_credentials`; `PATCH /api/v1/accounts/update_credentials`
- `GET /api/v1/accounts/search`, `/lookup`, `/relationships`, `/familiar_followers`
- `GET /api/v1/accounts/:id/statuses`, `/followers`, `/following`, `/lists`, `/identity_proofs`, `/featured_tags`, `/endorsements`, `/collections`, `/in_collections`
- `POST /api/v1/accounts/:id/follow`, `/unfollow`, `/remove_from_followers`, `/block`, `/unblock`, `/mute`, `/unmute`, `/pin`, `/endorse`, `/unpin`, `/unendorse`, `/note`, `/email_subscriptions`
- `GET/PATCH /api/v1/profile`; `DELETE /api/v1/profile/avatar`, `/header`
- `GET /api/v1/follow_requests`; `POST /api/v1/follow_requests/:id/authorize`, `/reject`
- `GET/POST /api/v1/lists`; `GET/PUT/DELETE /api/v1/lists/:id`
- `GET/POST/DELETE /api/v1/lists/:id/accounts`
- `GET /api/v1/endorsements`

### Notifications and conversations

- `GET /api/v1/notifications`; `GET /api/v1/notifications/:id`
- `POST /api/v1/notifications/clear`; `GET /api/v1/notifications/unread_count`; `POST /api/v1/notifications/:id/dismiss`
- `GET /api/v1/notifications/requests`; `GET /api/v1/notifications/requests/:id`, `/merged`; `POST /api/v1/notifications/requests/accept`, `/dismiss`, `/:id/accept`, `/:id/dismiss`
- `GET/PUT /api/v1/notifications/policy`
- `GET /api/v2/notifications`; `GET /api/v2/notifications/:group_key`; `POST /api/v2/notifications/clear`; `GET /api/v2/notifications/unread_count`; `POST /api/v2/notifications/:group_key/dismiss`; `GET /api/v2/notifications/:group_key/accounts`; `GET/PUT /api/v2/notifications/policy`
- `GET /api/v1/conversations`; `DELETE /api/v1/conversations/:id`; `POST /api/v1/conversations/:id/read`, `/unread`

### Discovery, trends, suggestions, and instance information

- `GET /api/v1/custom_emojis`
- `GET /api/v1/suggestions`; `DELETE /api/v1/suggestions/:id`; `GET /api/v2/suggestions`
- `GET /api/v1/trends`, `/trends/tags`, `/trends/links`, `/trends/statuses`
- `GET /api/v1/directory`
- `GET /api/v1/instance`, `/instance/peers`, `/instance/rules`, `/instance/domain_blocks`, `/instance/terms_of_service`, `/instance/terms_of_service/:date`, `/instance/privacy_policy`, `/instance/extended_description`, `/instance/translation_languages`, `/instance/languages`, `/instance/activity`
- `GET /api/v1/peers/search`
- `GET /api/v2/instance`
- `GET /api/v2/search`

### Tags, announcements, reports, and preferences

- `GET /api/v1/tags/:id`; `POST /api/v1/tags/:id/follow`, `/unfollow`, `/feature`, `/unfeature`
- `GET /api/v1/followed_tags`
- `GET/POST /api/v1/featured_tags`; `DELETE /api/v1/featured_tags/:id`; `GET /api/v1/featured_tags/suggestions`
- `GET /api/v1/announcements`; `POST /api/v1/announcements/:id/dismiss`; `PUT/DELETE /api/v1/announcements/:announcement_id/reactions/:id`
- `POST /api/v1/reports`
- `GET /api/v1/preferences`
- `GET /api/v1/donation_campaigns`
- `GET /api/v1/annual_reports`; `GET /api/v1/annual_reports/:id`; `POST /api/v1/annual_reports/:id/read`, `/generate`; `GET /api/v1/annual_reports/:id/state`

### Filters, markers, collections, and push

- `GET/POST /api/v1/filters`; `GET/PUT/DELETE /api/v1/filters/:id`
- `GET/POST /api/v2/filters`; `GET/PUT/DELETE /api/v2/filters/:id`
- `GET/POST /api/v2/filters/:filter_id/keywords`; `GET/PUT/DELETE /api/v2/filters/keywords/:id`
- `GET/POST /api/v2/filters/:filter_id/statuses`; `GET/DELETE /api/v2/filters/statuses/:id`
- `GET/POST /api/v1/markers`
- `POST/GET/PUT/DELETE /api/v1/push/subscription`
- `POST /api/v1/collections`; `GET/PUT/DELETE /api/v1/collections/:id`
- `POST/DELETE /api/v1/collections/:collection_id/items/:id`; `POST /api/v1/collections/:collection_id/items/:id/revoke`

### Domains, apps, and miscellaneous compatibility

- `POST /api/v1/apps`; `GET /api/v1/apps/verify_credentials`
- `GET /api/v1/domain_blocks/preview`; `GET/POST/DELETE /api/v1/domain_blocks`
- `GET /api/v1/blocks`, `/mutes`, `/favourites`, `/bookmarks`

## Appendix B: Required fallback classifications after all real mappings

- `safe-array`: v1/v2 filter indexes and filter subresources; conversations; endorsements; account familiar-followers, identity-proofs, featured-tags, endorsements, collections, and in-collections; followed/featured tags and featured-tag suggestions; donation campaigns; annual-report index; notification requests and grouped notifications; instance domain blocks, terms index, and languages; peer search; domain-block reads/previews.
- `safe-object`: marker reads and translation-language maps use `{}`; notification unread-count routes use `{ count: 0 }`; notification policy reads use `{ for_not_following: 'accept', for_not_followers: 'accept', for_new_accounts: 'accept', for_private_mentions: 'filter', for_limited_accounts: 'filter', for_bots: 'accept', summary: { pending_requests_count: 0, pending_notifications_count: 0 } }`.
- `singleton-not-found`: v1/v2 filter by ID, push subscription show, annual report show/state, notification request/merged/group show, collection show, oEmbed for an unavailable target, dated terms, privacy policy, and extended description.
- `unsupported-write`: account creation, suggestion dismissal, filters and filter subresources, conversation read/unread/delete, marker saves, push subscriptions, tag follow/feature actions, featured tags, endorsements, collections/items/revoke, annual-report actions, announcement reactions, notification-request/group/policy mutations, domain blocks, and email subscriptions.

When a route is implemented in Tasks 3–9, change only that route's classification to `implemented`; do not delete it from the contract.
