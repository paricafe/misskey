# PGroonga Note Search Planner Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SQL PGroonga note searches use the PGroonga index while preserving exact newest-first search results and every existing visibility and moderation filter.

**Architecture:** Extract the SQL text predicate construction into a small exported helper in `SearchService.ts`. For `sqlPgroonga`, the helper builds a materialized CTE that selects every matching note ID and joins it to the existing outer query; for `sqlLike`, it retains the current predicate on the outer query. The rest of `searchNoteByLike` remains unchanged.

**Tech Stack:** TypeScript, NestJS, TypeORM 1.1 query builders, PostgreSQL, PGroonga, Vitest

## Global Constraints

- Preserve exact search semantics: return the newest visible notes among all matching notes.
- Preserve all existing pagination, user, channel, host, date-range, visibility, blocked-host, suspended-user, mute, and block filters.
- Do not impose a fixed candidate limit or change the ordering to relevance.
- Do not change the Meilisearch path.
- Do not add or modify a database migration.
- Add the required AGPL SPDX header to the new TypeScript test file.
- Record the user-visible server fix under `CHANGELOG.md` `## Unreleased` / `### Server`.

---

### Task 1: Lock the PGroonga and SQL-like query shapes with a regression test

**Files:**
- Create: `packages/backend/test/unit/SearchService.ts`
- Modify: `packages/backend/src/core/SearchService.ts:7`

**Interfaces:**
- Consumes: TypeORM `SelectQueryBuilder` generated from a PostgreSQL `DataSource`.
- Produces: `applyNoteTextSearchQuery(query, provider, q): void`, where `provider` is `'sqlLike' | 'sqlPgroonga'`.

- [ ] **Step 1: Write the failing query-shape tests**

Create `packages/backend/test/unit/SearchService.ts`:

```ts
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { describe, expect, test } from 'vitest';
import { applyNoteTextSearchQuery } from '@/core/SearchService.js';

function createNoteQuery() {
	const db = new DataSource({ type: 'postgres' });
	return db.createQueryBuilder()
		.select('note.id', 'id')
		.from('note', 'note');
}

describe('applyNoteTextSearchQuery', () => {
	test('materializes PGroonga matches before the outer note query', () => {
		const query = createNoteQuery()
			.orderBy('note.id', 'DESC')
			.limit(10);

		applyNoteTextSearchQuery(query, 'sqlPgroonga', 'pari');

		const [sql, parameters] = query.getQueryAndParameters();

		expect(sql).toContain('WITH "matched_note" AS MATERIALIZED');
		expect(sql).toContain('FROM "note" "search_note" WHERE search_note.text &@~ $1');
		expect(sql).toContain('INNER JOIN "matched_note" "matched_note" ON matched_note.id = note.id');
		expect(sql).toContain('ORDER BY note.id DESC LIMIT 10');
		expect(parameters).toEqual(['pari']);
	});

	test('keeps SQL-like matching on the outer note query', () => {
		const query = createNoteQuery();

		applyNoteTextSearchQuery(query, 'sqlLike', '100%_MATCH');

		const [sql, parameters] = query.getQueryAndParameters();

		expect(sql).not.toContain('WITH "matched_note"');
		expect(sql).toContain('WHERE LOWER(note.text) LIKE $1');
		expect(parameters).toEqual(['%100\\%\\_match%']);
	});
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm --filter backend exec vitest --config vitest.config.unit.ts test/unit/SearchService.ts --run
```

Expected: FAIL because `applyNoteTextSearchQuery` is not exported by `SearchService.ts`.

- [ ] **Step 3: Add the minimal query helper**

In `packages/backend/src/core/SearchService.ts`, change the TypeORM import and add the helper after the search option types:

```ts
import { In, type SelectQueryBuilder } from 'typeorm';
```

```ts
export function applyNoteTextSearchQuery(
	query: SelectQueryBuilder<MiNote>,
	provider: 'sqlLike' | 'sqlPgroonga',
	q: string,
): void {
	if (provider === 'sqlPgroonga') {
		const matchedNotesQuery = query.connection.createQueryBuilder()
			.select('search_note.id', 'id')
			.from('note', 'search_note')
			.where('search_note.text &@~ :q', { q });

		query
			.addCommonTableExpression(matchedNotesQuery, 'matched_note', { materialized: true })
			.innerJoin('matched_note', 'matched_note', 'matched_note.id = note.id');
	} else {
		query.andWhere('LOWER(note.text) LIKE :q', { q: `%${sqlLikeEscape(q.toLowerCase())}%` });
	}
}
```

- [ ] **Step 4: Use the helper in `searchNoteByLike`**

Replace the existing provider conditional:

```ts
if (this.config.fulltextSearch?.provider === 'sqlPgroonga') {
	query.andWhere('note.text &@~ :q', { q });
} else {
	query.andWhere('LOWER(note.text) LIKE :q', { q: `%${ sqlLikeEscape(q.toLowerCase()) }%` });
}
```

with:

```ts
applyNoteTextSearchQuery(
	query,
	this.config.fulltextSearch?.provider === 'sqlPgroonga' ? 'sqlPgroonga' : 'sqlLike',
	q,
);
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm --filter backend exec vitest --config vitest.config.unit.ts test/unit/SearchService.ts --run
```

Expected: both tests PASS.

- [ ] **Step 6: Run backend type checking**

Run:

```bash
pnpm --filter backend typecheck
```

Expected: PASS with no TypeScript errors.

---

### Task 2: Record the user-visible server fix

**Files:**
- Modify: `CHANGELOG.md` under `## Unreleased` / `### Server`

**Interfaces:**
- Consumes: the completed PGroonga query-planner fix from Task 1.
- Produces: a release-note entry for server operators.

- [ ] **Step 1: Add the changelog entry**

Under the current `## Unreleased` `### Server` section, add:

```md
- Fix: PGroongaを使用したノート検索で、キーワードによってはデータベースのステートメントタイムアウトが発生する問題を修正
```

- [ ] **Step 2: Verify the scoped diff**

Run:

```bash
git diff --check
git diff -- packages/backend/src/core/SearchService.ts packages/backend/test/unit/SearchService.ts CHANGELOG.md
```

Expected: no whitespace errors; the diff contains only the materialized-CTE helper, its focused tests, and the changelog entry.

---

### Task 3: Validate and commit the fix

**Files:**
- Validate: `packages/backend/src/core/SearchService.ts`
- Validate: `packages/backend/test/unit/SearchService.ts`
- Validate: `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a tested Misskey backend fix ready for deployment review.

- [ ] **Step 1: Run backend lint**

Run:

```bash
pnpm --filter backend lint
```

Expected: PASS.

- [ ] **Step 2: Run repository lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Confirm non-applicable shipping checks**

Verify:

- no backend API `meta`, `paramDef`, or `res` changed, so misskey-js regeneration is not required;
- no entity or migration changed, so `check-migrations` is not required;
- no locale file changed;
- the new TypeScript test has the AGPL SPDX header.

- [ ] **Step 4: Review final repository state**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD
```

Expected: only the three intended files are changed and all checks are clean.

- [ ] **Step 5: Commit**

Run:

```bash
git add packages/backend/src/core/SearchService.ts packages/backend/test/unit/SearchService.ts CHANGELOG.md
git commit -m "fix(backend): use PGroonga index for note search"
```

Expected: commit succeeds without bypassing hooks.
