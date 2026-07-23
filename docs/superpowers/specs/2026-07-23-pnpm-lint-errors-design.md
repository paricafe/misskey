# pnpm lint errors repair design

## Goal

Restore a clean `pnpm lint` run without changing runtime behavior, then resume merging `develop` into `pari-dev` and pushing the branch.

## Root causes

### Backend request typing

`MastodonApiServerService` defines one fixed `MastodonRequest` route generic containing `Body`, `Querystring`, and `Params` dictionaries. Individual Fastify routes use narrower and different route generics. TypeScript rejects casts between those request shapes because the generic is also propagated through Fastify request metadata and type-provider resolution.

The failure is a type-modeling problem. The shared authentication and API invocation helpers only need the common request context and should not require a single payload shape.

### Frontend builder AST typing

`frontend-builder` parses ASTs with `rolldown@1.1.5`, whose nodes use `@oxc-project/types@0.139.0`, and walks them with `oxc-walker@1.0.0`. Because the package does not directly select an `oxc-parser` peer, pnpm resolves the walker against `oxc-parser@0.127.0`. The same AST then has two incompatible nominal type sources.

## Design

### Backend

Make the common Mastodon request type preserve the actual Fastify route generic instead of forcing every request into one fixed body/query/params shape. Generic authentication and invocation helpers will accept that common request context. Functions that actually consume request payload fields will keep precise route-specific types.

Remove whole-request assertions that only existed to satisfy the fixed alias. Do not introduce `as unknown as`, `any`, or runtime conversions. Request handling behavior remains unchanged.

Keep official backend files unchanged. Where the custom Mastodon call adapter must satisfy the narrower existing `ApiCallService.invoke()` request type, keep any necessary type bridge local to `MastodonApiCallService` and document why it is safe: the invoked path consumes only the common Fastify request context.

### Frontend builder

Add an exact direct dependency on `oxc-parser@0.139.0` in `packages/frontend-builder/package.json` and regenerate `pnpm-lock.yaml`. This makes the `oxc-walker` peer context and Rolldown use the same OXC AST types.

Do not use a repository-wide override, hand-edit only the lockfile, or revert to a less strict type checker.

Preserve the official Rolldown, Vite, Fastify, and TypeScript checker updates; the compatibility repair must not revert or replace them.

## Validation

Use the existing failing type checks as the regression tests:

1. Confirm the current failures with the backend and frontend-builder type checks.
2. Apply each minimal fix independently and confirm its package type check and lint pass.
3. Run the backend Mastodon API test coverage relevant to the changed request helpers.
4. Run `pnpm install --frozen-lockfile` to verify dependency reproducibility.
5. Run full `pnpm lint`.
6. After merging `origin/develop`, repeat the required validation before pushing `pari-dev`.

The root version conflict is resolved according to the established Pari release sequence: retain the fork release line and set `package.json` to `2026.6.0-pari.12` while preserving all other official `develop` changes.

No locale, entity, migration, API schema, or user-visible behavior changes are expected, so no locale regeneration, migration check, misskey-js generation, or changelog entry is required.
