# pnpm lint errors repair implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `pnpm lint` pass without changing runtime behavior, then merge `origin/develop` into `pari-dev` and push the validated branch.

**Architecture:** Align the frontend builder's OXC peer dependency with Rolldown's AST type version. In the backend, stop treating every Fastify route request as one fixed body/query/params generic; pass the base request context through shared helpers and narrow only the individual payload properties that are consumed.

**Tech Stack:** pnpm workspaces, TypeScript, Fastify 5, Rolldown 1.1.5, oxc-walker 1.0.0, oxc-parser 0.139.0, Vitest.

## Global Constraints

- Do not change runtime request handling or Mastodon API responses.
- Do not use `any`, `as unknown as MastodonRequest`, repository-wide dependency overrides, or hand-written lockfile edits.
- Keep `oxc-parser` pinned exactly to `0.139.0` in `frontend-builder`.
- Do not edit locale files, entities, migrations, API schemas, or generated misskey-js files.
- Preserve the official Rolldown, Vite, Fastify, and TypeScript checker updates; do not modify `packages/backend/src/server/api/ApiCallService.ts`.
- Resolve the root version conflict to exactly `2026.6.0-pari.12`; preserve every other official `develop` change.
- Preserve all unrelated worktree changes.

---

### Task 1: Align frontend-builder OXC AST types

**Files:**
- Modify: `packages/frontend-builder/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `rolldown@1.1.5` AST nodes and `oxc-walker@1.0.0` peer resolution.
- Produces: one `@oxc-project/types@0.139.0` type identity for ASTs passed from Rolldown to oxc-walker.

- [ ] **Step 1: Verify the regression test is red**

Run:

```powershell
pnpm --filter frontend-builder typecheck
```

Expected: FAIL in `locale-inliner/collect-modifications.ts` and `rollup-plugin-remove-unref-i18n.ts`, showing `@oxc-project/types@0.139.0` is incompatible with `0.127.0`.

- [ ] **Step 2: Add the exact peer dependency and regenerate the lockfile**

Run:

```powershell
pnpm --filter frontend-builder add oxc-parser@0.139.0 --save-exact
```

Expected `packages/frontend-builder/package.json` dependency block:

```json
"dependencies": {
	"i18n": "workspace:*",
	"magic-string": "0.30.21",
	"oxc-parser": "0.139.0",
	"oxc-walker": "1.0.0",
	"rolldown": "1.1.5",
	"vite": "8.1.4"
}
```

Expected lockfile peer context includes `oxc-walker@1.0.0(oxc-parser@0.139.0)(rolldown@1.1.5)`.

- [ ] **Step 3: Verify dependency identity and package lint**

Run:

```powershell
pnpm --filter frontend-builder why oxc-parser
pnpm --filter frontend-builder why @oxc-project/types
pnpm --filter frontend-builder typecheck
pnpm --filter frontend-builder lint
```

Expected: the frontend-builder path resolves `oxc-parser@0.139.0`; typecheck and lint PASS.

---

### Task 2: Widen shared Fastify request context safely

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiCallService.ts`
- Test: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`

**Interfaces:**
- Consumes: route-specific `FastifyRequest<RouteGeneric>` objects.
- Produces: shared authentication and native endpoint invocation helpers that accept the common `FastifyRequest` context while payload-consuming code explicitly narrows `body` or `query` to `Dictionary`.

- [ ] **Step 1: Verify the backend type regression is red**

Run:

```powershell
pnpm --filter backend exec tsc --noEmit --pretty false
```

Expected: FAIL with TS2352 at typed Mastodon routes, beginning near `MastodonApiServerService.ts:226`, because the route request does not sufficiently overlap the fixed `MastodonRequest` generic.

- [ ] **Step 2: Make request transport types payload-agnostic**

In `MastodonApiServerService.ts`, replace the fixed alias with:

```typescript
type Dictionary = Record<string, unknown>;
type MastodonRequest = FastifyRequest;
```

Replace every whole-request expression of the form:

```typescript
request as MastodonRequest
```

with:

```typescript
request
```

Replace the local declaration:

```typescript
const mastodonRequest = request as MastodonRequest;
```

with direct use of `request` and remove the now-unused variable.

At payload-consuming helper boundaries, narrow only the property being read:

```typescript
let body = (request.body as Dictionary | undefined) ?? {};

const body = (request.body as Dictionary | undefined) ?? {};

const query = request.query as Dictionary;
```

Use those property-level values in `updateProfile`, `validateCompatibilityRequest`, `userPage`, `createStatus`, and `endorsementPage`; do not cast the entire request object.

In `MastodonApiCallService.ts`, keep the existing `NativeRequest` alias that mirrors the official `ApiCallService.invoke()` signature. Change the public `invoke()` and `invokePublic()` request parameters to base `FastifyRequest`, then bridge to `NativeRequest` only at the two calls into the unchanged official service:

```typescript
request as NativeRequest
```

If TypeScript requires an intermediate `unknown`, keep that assertion localized to these adapter calls and add this comment immediately above it:

```typescript
// ApiCallService.invoke only consumes the common Fastify request context on this path.
```

Do not modify `packages/backend/src/server/api/ApiCallService.ts`.

- [ ] **Step 3: Verify the focused backend checks are green**

Run:

```powershell
pnpm --filter backend exec tsc --noEmit --pretty false
pnpm --filter backend typecheck
pnpm --filter backend eslint
rg -n "as unknown as MastodonRequest|request as MastodonRequest" packages/backend/src/server/api/mastodon
```

Expected: typecheck and eslint PASS; `rg` returns no matches.

- [ ] **Step 4: Run Mastodon API regression tests**

Ensure `.config/test.yml` exists by copying `.github/misskey/test.yml` only if it is missing, then run:

```powershell
pnpm --filter backend test -- MastodonApiServerService.test.ts
```

Expected: the Mastodon API server service tests PASS with no request behavior changes.

---

### Task 3: Validate, integrate develop, and publish

**Files:**
- Include: `docs/superpowers/specs/2026-07-23-pnpm-lint-errors-design.md`
- Include: `docs/superpowers/plans/2026-07-23-pnpm-lint-errors.md`
- Include: files modified by Tasks 1 and 2.
- Merge conflict resolution: `package.json` version field only.

**Interfaces:**
- Consumes: independently passing frontend-builder and backend fixes.
- Produces: a reproducible, lint-clean `pari-dev` containing current `origin/develop`.

- [ ] **Step 1: Verify a frozen installation and full lint**

Run:

```powershell
pnpm install --frozen-lockfile
pnpm lint
git diff --check
```

Expected: all commands PASS.

- [ ] **Step 2: Review repository shipping gates**

Confirm:

```powershell
git diff --name-only
git diff --name-only -- 'locales/*.yml'
git diff --name-only -- 'packages/backend/migration/*' 'packages/backend/src/models/*'
git diff --name-only -- 'packages/misskey-js/src/autogen/*'
```

Expected: no locale, migration, entity, or generated API changes. No changelog entry is required because runtime behavior is unchanged.

- [ ] **Step 3: Commit the repair**

Stage only the reviewed files and commit without bypassing hooks:

```powershell
git add docs/superpowers/specs/2026-07-23-pnpm-lint-errors-design.md docs/superpowers/plans/2026-07-23-pnpm-lint-errors.md packages/frontend-builder/package.json pnpm-lock.yaml packages/backend/src/server/api/mastodon/MastodonApiServerService.ts packages/backend/src/server/api/mastodon/MastodonApiCallService.ts
git commit -m "fix: restore lint after dependency updates"
```

Expected: commit succeeds with hooks enabled.

- [ ] **Step 4: Merge current develop**

Run:

```powershell
git fetch origin --prune
git merge --no-edit origin/develop
```

Expected: the merge may stop at the known root `package.json` version conflict. Resolve only that conflict by setting:

```json
"version": "2026.6.0-pari.12"
```

Then stage `package.json` and complete the merge commit. Preserve both the lint repair and every other upstream change.

- [ ] **Step 5: Re-run post-merge verification**

Run:

```powershell
pnpm install --frozen-lockfile
pnpm lint
git diff --check HEAD^ HEAD
git status --short --branch
```

Expected: lint passes and the working tree is clean.

- [ ] **Step 6: Push pari-dev**

Run:

```powershell
git push origin pari-dev
```

Expected: `origin/pari-dev` advances to the validated local `pari-dev` tip without force-push.
