# Mastodon API Compatibility Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the confirmed Mastodon-compatible API operations exact, side-effect safe, correctly paginated, and mergeable under Misskey repository rules.

**Architecture:** Keep request parsing and Mastodon error normalization in `MastodonApiServerService`, extract transactional multi-choice voting into a focused core service shared by the native and compatibility endpoints, and extend the existing JSONB note-history element shape instead of adding a database migration. Every production edit is preceded by a focused failing test.

**Tech Stack:** TypeScript, NestJS, Fastify, TypeORM/PostgreSQL, Vitest, pnpm.

## Global Constraints

- Do not create a migration without presenting it to the user first.
- An existing unmerged migration may be renamed and receive a missing SPDX header.
- Do not edit an already merged migration.
- New backend TypeScript/JavaScript files require the AGPL SPDX header.
- Only `locales/ja-JP.yml` may be manually edited.
- Mastodon requests must either be honored exactly or rejected before side effects.
- Run `pnpm build-misskey-js-with-types` after changing packed note API types.

---

### Task 1: Status action correctness

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`

**Interfaces:**
- Consumes: `MastodonApiStateService.withUserKindLock(userId, kind, callback)`, `toMisskeyVisibility(value)`.
- Produces: idempotent bookmark/unbookmark and boost routes that preserve requested visibility.

- [ ] **Step 1: Write failing route tests**

Add tests that:

```ts
test('preserves private boost visibility and reuses an existing pure renote', async () => {
	const first = await fastify.inject({
		method: 'POST',
		url: '/api/v1/statuses/target/reblog',
		headers,
		payload: { visibility: 'private' },
	});
	const second = await fastify.inject({
		method: 'POST',
		url: '/api/v1/statuses/target/reblog',
		headers,
		payload: { visibility: 'private' },
	});

	expect(first.statusCode).toBe(200);
	expect(second.statusCode).toBe(200);
	expect(nativeInvoke).toHaveBeenCalledWith('notes/create', {
		renoteId: 'target',
		visibility: 'followers',
	}, expect.any(Object), expect.any(Object));
	expect(nativeInvoke.mock.calls.filter(([name]) => name === 'notes/create')).toHaveLength(1);
});

test.each([
	['bookmark', 'ALREADY_FAVORITED', true],
	['unbookmark', 'NOT_FAVORITED', false],
] as const)('normalizes repeated %s', async (action, code, bookmarked) => {
	nativeInvoke.mockRejectedValueOnce(Object.assign(new ApiError({} as never), { code }));
	const response = await fastify.inject({
		method: 'POST',
		url: `/api/v1/statuses/target/${action}`,
		headers,
	});
	expect(response.statusCode).toBe(200);
	expect(response.json()).toMatchObject({ bookmarked });
});
```

The test fixture must make the first pure-renote lookup empty and the second
lookup return the created renote. A quote with the same `renoteId` must not be
reused.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
pnpm --filter backend exec vitest run --config vitest.config.unit.ts src/server/api/mastodon/MastodonApiServerService.test.ts -t "boost visibility|repeated bookmark"
```

Expected: boost payload lacks `visibility`, a second `notes/create` occurs,
and native bookmark errors produce a non-200 response.

- [ ] **Step 3: Implement the minimal action fixes**

Add `MastodonApiStateService` to the server constructor. Parse the boost body
as `Dictionary`, map `public|unlisted|private`, and serialize compatibility
boosts under a stable lock kind such as `status_reblog:${targetId}`:

```ts
const visibility = this.toMisskeyVisibility(this.string(request.body?.visibility) ?? 'public');
return await this.mastodonApiStateService.withUserKindLock(
	auth.user.id,
	`status_reblog:${request.params.id}`,
	async () => {
		const existing = (await this.notesRepository.findBy({
			userId: auth.user.id,
			renoteId: request.params.id,
		})).find(note => this.isPureRenote(note));
		const packed = existing == null
			? (await this.invoke('notes/create', {
				renoteId: request.params.id,
				visibility,
			}, auth, request) as { createdNote: Packed<'Note'> }).createdNote
			: await this.invoke('notes/show', { noteId: existing.id }, auth, request) as Packed<'Note'>;
		return { ...await this.statusWithState(packed, auth, 'thread'), reblogged: true };
	},
);
```

Extend the existing action-error predicate with only:

```ts
(action === 'bookmark' && error.code === 'ALREADY_FAVORITED') ||
(action === 'unbookmark' && error.code === 'NOT_FAVORITED')
```

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

---

### Task 2: Status poll and schedule validation

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`

**Interfaces:**
- Produces: `parseStatusPoll(body, fileIds)` returning either `undefined` or the exact native poll payload.

- [ ] **Step 1: Add failing validation tests**

Use table-driven Fastify requests proving that each of these returns 422 and
does not call `notes/create`, `notes/drafts/create`, or media sensitivity
updates:

```ts
[
	{ status: 'x', poll: { options: ['only one'], expires_in: 300 } },
	{ status: 'x', poll: { options: ['A', 'B'] } },
	{ status: 'x', poll: { expires_in: 300 } },
	{ status: 'x', media_ids: ['file'], poll: { options: ['A', 'B'], expires_in: 300 } },
	{ status: 'x', poll: { options: ['A', 'B'], expires_in: 300, hide_totals: true } },
	{ status: 'x', poll: { options: ['A', 'B'], expires_in: 'NaN' } },
]
```

Freeze the clock and add a request scheduled four minutes ahead; expect 422.
A request five minutes ahead must remain accepted.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter backend exec vitest run --config vitest.config.unit.ts src/server/api/mastodon/MastodonApiServerService.test.ts -t "poll parameters|five minutes"
```

Expected: malformed poll combinations currently return 200 or reach a native
endpoint, and the four-minute schedule is accepted.

- [ ] **Step 3: Implement complete pre-side-effect parsing**

Create a private parser called before `updateMediaSensitivity`:

```ts
private parseStatusPoll(body: Dictionary, fileIds: string[]) {
	const nested = this.object(body.poll);
	const hasPoll = nested != null || Object.keys(body).some(key => key.startsWith('poll['));
	if (!hasPoll) return undefined;
	const choices = this.strings(body['poll[options][]'] ?? nested?.options);
	const expiresRaw = body['poll[expires_in]'] ?? nested?.expires_in;
	if (choices.length < 2 || choices.some(choice => choice.trim() === '')) {
		throw new MastodonApiError(422, 'unprocessable_entity', 'A poll requires at least two non-empty options');
	}
	if (expiresRaw == null || expiresRaw === '') {
		throw new MastodonApiError(422, 'unprocessable_entity', 'poll.expires_in is required');
	}
	if (fileIds.length > 0) {
		throw new MastodonApiError(422, 'unprocessable_entity', 'A poll cannot be combined with media');
	}
	const expiresIn = Number(expiresRaw);
	if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 2629746) {
		throw new MastodonApiError(422, 'unprocessable_entity', 'poll.expires_in is invalid');
	}
	if (this.boolean(body['poll[hide_totals]'] ?? nested?.hide_totals)) {
		throw new MastodonApiError(422, 'unprocessable_entity', 'Hidden poll totals are not supported');
	}
	return {
		choices,
		multiple: this.boolean(body['poll[multiple]'] ?? nested?.multiple),
		expiredAfter: expiresIn * 1000,
	};
}
```

Use `Date.now() + 300_000` as the minimum in `parseScheduledAt`.

- [ ] **Step 4: Verify GREEN**

Run the focused command from Step 2, then the complete server-service test
file. Expected: PASS.

---

### Task 3: Atomic multi-choice voting

**Files:**
- Create: `packages/backend/src/core/PollVoteService.ts`
- Create: `packages/backend/src/core/PollVoteService.test.ts`
- Modify: `packages/backend/src/core/CoreModule.ts`
- Modify: `packages/backend/src/server/api/endpoints/notes/polls/vote.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`

**Interfaces:**
- Produces:

```ts
PollVoteService.vote(
	noteId: MiNote['id'],
	choices: number[],
	me: MiLocalUser,
): Promise<void>
```

- [ ] **Step 1: Write failing core-service tests**

Cover:

```ts
await expect(service.vote(note.id, [0, 999], me)).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
expect(pollVotesRepository.insert).not.toHaveBeenCalled();

await expect(service.vote(singleNote.id, [0, 1], me)).rejects.toMatchObject({ code: 'INVALID_CHOICE' });
expect(pollVotesRepository.insert).not.toHaveBeenCalled();

await service.vote(multipleNote.id, [0, 1], me);
expect(pollVotesRepository.insert).toHaveBeenCalledWith([
	expect.objectContaining({ choice: 0 }),
	expect.objectContaining({ choice: 1 }),
]);
```

Also test duplicate input, existing votes, expiration, blocking, and a forced
insert/update failure rolling back all rows.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter backend exec vitest run --config vitest.config.unit.ts src/core/PollVoteService.test.ts
```

Expected: module not found.

- [ ] **Step 3: Extract and implement transaction-safe voting**

Move the validation and post-commit side effects from the native endpoint into
`PollVoteService`. Validate the complete unique choice list before opening
side effects. Inside a repository-manager transaction:

```ts
await manager.transaction(async transactionalManager => {
	const polls = transactionalManager.getRepository(MiPoll);
	const votes = transactionalManager.getRepository(MiPollVote);
	const existing = await votes.findBy({ noteId, userId: me.id });
	// Re-check choices and existing votes while the transaction owns a
	// pg_advisory_xact_lock for `${noteId}\0${me.id}`.
	await votes.insert(rows);
	for (const choice of choices) {
		await polls.query(
			'UPDATE poll SET votes[$1] = votes[$1] + 1 WHERE "noteId" = $2',
			[choice + 1, noteId],
		);
	}
});
```

Generate one vote ID per choice. Publish `pollVoted`, remote vote deliveries,
and one question update only after the transaction resolves.

Register and export the service from `CoreModule`. Make the native endpoint
call `vote(ps.noteId, [ps.choice], me)`, preserving its public contract. Make
the Mastodon route reject non-integers instead of filtering them and call the
same service once with the complete list.

- [ ] **Step 4: Verify GREEN**

Run the new core test, native endpoint test, and Mastodon server test.
Expected: all PASS and no partial inserts.

---

### Task 4: Quote-only cursor pagination

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`

**Interfaces:**
- Produces: bounded `quotePage(request, auth)` that returns quotes and source
  IDs suitable for `Link` generation.

- [ ] **Step 1: Add a failing pagination regression**

Mock the first native `notes/renotes` page as twenty pure boosts and the second
page as one quote. Request `limit=1`; assert that the response contains the
quote and that the second call uses the first page's last ID as `untilId`.

- [ ] **Step 2: Verify RED**

Run the test by name. Expected: current route returns `[]` and calls
`linkHeader` with `[]`.

- [ ] **Step 3: Implement bounded scanning**

Parse Mastodon limit with maximum 40. Fetch native pages of at most 100,
carrying `untilId`, until `limit + 1` quotes are collected, native exhaustion
is reached, or ten native pages have been scanned. Treat Mastodon cursor
parameters as opaque: when the safety bound is reached, generate the next
`Link` from the last consumed underlying renote-stream ID even if that row is
a pure boost. Response entities remain quote-only. This resumes the native
stream without skipping an older quote, duplicating a returned quote, or
requiring server-side cursor state.

- [ ] **Step 4: Verify GREEN**

Run quote tests and the complete server-service test. Expected: PASS.

---

### Task 5: Poll voter counts and mention identity mapping

**Files:**
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.ts`

**Interfaces:**
- Produces: `poll(noteId, poll, votersCount?)` and stable deduplicated mention
  mapping.

- [ ] **Step 1: Add failing entity tests**

Assert:

```ts
expect(service.poll('single', singlePoll).voters_count).toBeNull();
expect(service.poll('multiple', multiplePoll, 2).voters_count).toBe(2);
```

For text `@alice @alice @bob`, use mention IDs `['alice-id', 'bob-id']` and
assert Bob retains `bob-id`, `bob`, and Bob's URL.

- [ ] **Step 2: Verify RED**

Run `MastodonEntityService.test.ts` filtered by `voters_count|duplicate
mentions`. Expected: count equality and positional mapping assertions fail.

- [ ] **Step 3: Implement the mappings**

Change poll mapping to:

```ts
voters_count: poll.multiple ? votersCount ?? null : null,
```

Deduplicate parsed mentions by a lower-cased
`${username}@${host ?? this.config.host}` key before pairing with IDs.

Add a bounded `COUNT(DISTINCT "userId") GROUP BY "noteId"` helper for
multiple-choice poll note IDs and pass results when constructing Mastodon
status collections. Batch once per status collection; do not query per status.

- [ ] **Step 4: Verify GREEN**

Run entity tests and server-service tests. Expected: PASS with one count query
per collection.

---

### Task 6: Media-only editing and complete JSONB revision snapshots

**Files:**
- Modify: `packages/backend/src/models/Note.ts`
- Modify: `packages/backend/src/models/json-schema/note.ts`
- Modify: `packages/backend/src/core/NoteUpdateService.test.ts`
- Modify: `packages/backend/src/core/NoteUpdateService.ts`
- Modify: `packages/backend/src/server/api/endpoints/notes/update.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonApiServerService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.test.ts`
- Modify: `packages/backend/src/server/api/mastodon/MastodonEntityService.ts`
- Regenerate: `packages/misskey-js/src/autogen/`

**Interfaces:**
- Extends each existing `note.history` JSONB element with optional immutable
  fields:

```ts
fileIds?: string[];
files?: Packed<'DriveFile'>[];
sensitive?: boolean;
emojis?: string[];
poll?: Packed<'Note'>['poll'];
renote?: Packed<'Note'> | null;
```

- [ ] **Step 1: Add failing media-only and snapshot tests**

Route test: edit a note with `text: null` and one file while omitting `status`;
assert `notes/update` receives `text: null`, not `''`.

Core test: updating a note appends the old file IDs, packed files, sensitivity,
emojis, poll, and quote snapshot to `history`.

Entity test: `statusEdits()` returns those old values instead of hard-coded
empty arrays and `sensitive: false`; a legacy text/CW-only element still maps
with safe empty fallbacks.

- [ ] **Step 2: Verify RED**

Run the three focused test files. Expected: empty text is passed and history
properties are absent/hard-coded.

- [ ] **Step 3: Extend the existing JSON shape without migration**

Make `text` nullable in the native `notes/update` parameter schema and retain
the endpoint's existing rule that a note cannot end with neither text nor
files. Extend the `MiNote.history` type and packed-note JSON schema with
optional fields.

Before mutating the note, assemble the immutable old revision from the current
note, packed current files, current poll, quote, and emojis. Append it to the
JSONB array. Do not alter the database column definition.

Update `statusEdits()` to prefer snapshot values and use legacy fallbacks only
when optional fields are absent.

- [ ] **Step 4: Regenerate API types**

Run:

```powershell
pnpm build-misskey-js-with-types
```

Expected: generated note-history types include the optional snapshot fields.

- [ ] **Step 5: Verify GREEN**

Run focused tests plus:

```powershell
pnpm --filter backend test -- --runInBand
```

Expected: PASS. Confirm `git diff --name-only -- packages/backend/migration`
shows no new migration.

---

### Task 7: Repository hygiene blockers

**Files:**
- Rename: `packages/backend/migration/1727998351591-after-increase_character_limits copy.js`
  to `packages/backend/migration/1727998351591-after-increase-character-limits.js`
- Modify: renamed migration, SPDX header only
- Modify: `locales/en-US.yml`
- Modify: `locales/zh-CN.yml`
- Modify: `locales/zh-TW.yml`

**Interfaces:**
- Produces: a valid unmerged migration filename/header and no prohibited
  non-source locale diff.

- [ ] **Step 1: Confirm migration provenance**

Run:

```powershell
rg -n "AfterIncreaseCharacterLimits1727998351591" packages/backend/migration
git log --all -- "packages/backend/migration/1727998351591-*"
```

Expected: exactly one unmerged companion migration, with implemented `up()` and
`down()`, and no merged copy.

- [ ] **Step 2: Rename and license the existing unmerged migration**

Use `apply_patch` move syntax and prepend:

```js
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
```

This is a rename of an existing unmerged file, not a new migration.

- [ ] **Step 3: Remove non-source locale changes**

For each non-`ja-JP.yml` locale, reverse only the branch hunks relative to the
merge base using `apply_patch`. Do not touch `locales/ja-JP.yml`.

- [ ] **Step 4: Verify repository rules**

Run:

```powershell
git diff --name-only develop -- "locales/*.yml"
git diff --check
pnpm --filter backend check-migrations
```

Expected: locale output contains only `locales/ja-JP.yml`; diff check and
migration check pass.

---

### Task 8: Full regression and shipping review

**Files:**
- Modify if required: `CHANGELOG.md`

**Interfaces:**
- Produces: validated, review-ready branch with no migration addition.

- [ ] **Step 1: Add the user-visible changelog entry**

Under `## Unreleased` → `### Server`, add:

```md
- Fix: Mastodon互換APIのステータス操作、投票、引用ページネーション、編集履歴の互換性を改善
```

- [ ] **Step 2: Run focused Mastodon validation**

Run:

```powershell
pnpm --filter backend exec vitest run --config vitest.config.unit.ts src/server/api/mastodon src/core/PollVoteService.test.ts src/core/NoteUpdateService.test.ts src/server/oauth/OAuth2ProviderService.test.ts src/core/MastodonPushNotificationService.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Run repository validation**

Run:

```powershell
pnpm lint
pnpm build-misskey-js-with-types
pnpm --filter backend check-migrations
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 4: Run safety audits**

Confirm:

```powershell
git diff --name-only develop -- "locales/*.yml"
git diff --name-only --diff-filter=A develop -- packages/backend |
	ForEach-Object {
		if ($_ -match '\.(ts|js|cjs|mjs)$') {
			$header = Get-Content -LiteralPath $_ -TotalCount 5 -Raw
			if ($header -notmatch 'SPDX-License-Identifier') { $_ }
		}
	}
git diff --name-only develop -- packages/backend/migration
```

Expected: only `locales/ja-JP.yml`, no SPDX failures, and no newly created
migration beyond the renamed pre-existing file.

- [ ] **Step 5: Request the mandatory backend API review**

Run the repository's `misskey-api-reviewer` against the final diff, addressing
only reproducible findings. Re-run affected tests after any correction.

- [ ] **Step 6: Present the final diff before commit/push**

Report changed files, test counts, generated API changes, locale/SPDX results,
and confirm explicitly that no migration was added. Do not commit or push until
the user requests it.
