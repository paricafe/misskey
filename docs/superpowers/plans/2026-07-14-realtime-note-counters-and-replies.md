# Realtime Note Counters and Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep reply and renote counters in `MkNote` and `MkNoteDetailed`, plus the visible `MkNoteDetailed` replies list, synchronized as replies, renotes, quotes, deletions, and unrenotes happen.

**Architecture:** Backend target-note stream events carry count deltas and content-free child-list invalidations after successful database mutations. `useNoteCapture` owns reactive counts for both note components and forwards child invalidations to a single-flight, one-second-throttled scheduler in `MkNoteDetailed`; `notes/children` remains the viewer-filtered authority for list contents. `notes/show-partial-bulk` carries authoritative counts when realtime mode is disabled.

**Tech Stack:** TypeScript, NestJS, TypeORM, Misskey WebSocket streaming, misskey-js, Vue 3 Composition API, Vitest, Playwright, pnpm.

## Global Constraints

- Read `docs/superpowers/specs/2026-07-14-realtime-note-counters-and-replies-design.md` before starting.
- Invoke `working-on-backend` before editing `packages/backend/` and `working-on-frontend` before editing `packages/frontend/`.
- Invoke `shipping-misskey-change` and `verification-before-completion` before every handoff or final commit.
- Do not edit locale YAML files; if locale work unexpectedly becomes necessary, only `locales/ja-JP.yml` may be edited.
- New `.ts` files under `packages/backend/` or `packages/frontend/` require the AGPL SPDX header. Do not add the AGPL header to `packages/misskey-js` files.
- Preserve the renote-count rule exactly: count only when the renoter is not the target author and the renoter is not a bot; apply the same rule on deletion.
- Stream events are exactly `repliesCountChanged`, `renoteCountChanged`, and `childrenChanged`; count deltas are `1 | -1`.
- Never stream packed child-note content through the target note stream. `notes/children` remains responsible for viewer-specific visibility filtering.
- The replies refresh limit remains 30 and refresh starts are throttled to at most once per 1,000 ms per active detailed-note view.
- Force note capture only for the single note in `MkNoteDetailed`, so old note pages receive events and polling updates; preserve the existing age-based capture policy for timeline `MkNote` instances.
- Backend e2e tests require `.config/test.yml`; create it with `pnpm exec ncp .github/misskey/test.yml .config/test.yml` if absent.
- `pnpm lint` has a known failing baseline on this branch. Do not expand scope to unrelated errors; record the fresh failure list and prove touched files pass focused lint/tests.

---

### Task 1: Centralize the renote-count eligibility rule

**Files:**
- Create: `packages/backend/src/misc/should-count-renote.ts`
- Create: `packages/backend/test/unit/misc/should-count-renote.ts`
- Modify: `packages/backend/src/core/NoteCreateService.ts:807-809,988-994`

**Interfaces:**
- Consumes: a target with `userId` and a renoter with `id` and `isBot`.
- Produces: `shouldCountRenote(target, renoter): boolean` and an awaited `incRenoteCount(renote): Promise<void>`.

- [ ] **Step 1: Write the failing eligibility tests**

Create the test with the required SPDX header:

```ts
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { shouldCountRenote } from '@/misc/should-count-renote.js';

describe('shouldCountRenote', () => {
	test.each([
		[{ userId: 'author' }, { id: 'renoter', isBot: false }, true],
		[{ userId: 'author' }, { id: 'author', isBot: false }, false],
		[{ userId: 'author' }, { id: 'renoter', isBot: true }, false],
	] as const)('target=%o renoter=%o returns %s', (target, renoter, expected) => {
		expect(shouldCountRenote(target, renoter)).toBe(expected);
	});
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter backend test -- should-count-renote.ts`

Expected: FAIL because `@/misc/should-count-renote.js` does not exist.

- [ ] **Step 3: Implement the pure rule**

Create the source file with the required SPDX header:

```ts
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';

export function shouldCountRenote(
	target: Pick<MiNote, 'userId'>,
	renoter: Pick<MiUser, 'id' | 'isBot'>,
): boolean {
	return target.userId !== renoter.id && !renoter.isBot;
}
```

- [ ] **Step 4: Use the rule in the creation path and await the database mutation**

Import `shouldCountRenote` in `NoteCreateService.ts`, replace the existing inline condition with:

```ts
if (data.renote && shouldCountRenote(data.renote, user)) {
	await this.incRenoteCount(data.renote);
}
```

Change `incRenoteCount` to:

```ts
@bindThis
private async incRenoteCount(renote: MiNote): Promise<void> {
	await this.notesRepository.createQueryBuilder().update()
		.set({
			renoteCount: () => '"renoteCount" + 1',
		})
		.where('id = :id', { id: renote.id })
		.execute();

	if (Math.random() < 0.3 && (Date.now() - this.idService.parse(renote.id).date.getTime()) < 1000 * 60 * 60 * 24 * 3) {
		if (renote.channelId != null) {
			if (renote.replyId == null) {
				this.featuredService.updateInChannelNotesRanking(renote.channelId, renote.id, 5);
			}
		} else if (renote.visibility === 'public' && renote.userHost == null && renote.replyId == null) {
			this.featuredService.updateGlobalNotesRanking(renote.id, 5);
			this.featuredService.updatePerUserNotesRanking(renote.userId, renote.id, 5);
		}
	}
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `pnpm --filter backend test -- should-count-renote.ts`

Expected: PASS for eligible, self-renote, and bot-renote cases.

- [ ] **Step 6: Commit the task**

```text
git add packages/backend/src/misc/should-count-renote.ts packages/backend/test/unit/misc/should-count-renote.ts packages/backend/src/core/NoteCreateService.ts
git commit -m "refactor(backend): centralize renote count eligibility"
```

### Task 2: Decrement reply and renote counts symmetrically on deletion

**Files:**
- Modify: `packages/backend/test/e2e/note.ts:956-985`
- Modify: `packages/backend/src/core/NoteDeleteService.ts:5-24,63-72`

**Interfaces:**
- Consumes: `shouldCountRenote`, `MiNote.replyId`, and `MiNote.renoteId`.
- Produces: database counts that return to their pre-child values after reply, quote, or renote deletion.

- [ ] **Step 1: Add failing e2e tests for counted renotes and combined reply-quotes**

Append these tests inside the existing `describe('notes/delete')` block:

```ts
test('delete a counted renote and quote', async () => {
	const target = await post(alice, { text: 'renote target' });
	const renote = await post(bob, { renoteId: target.id });

	let storedTarget = await Notes.findOneByOrFail({ id: target.id });
	assert.strictEqual(storedTarget.renoteCount, 1);

	const deleteRenote = await api('notes/delete', { noteId: renote.id }, bob);
	assert.strictEqual(deleteRenote.status, 204);
	storedTarget = await Notes.findOneByOrFail({ id: target.id });
	assert.strictEqual(storedTarget.renoteCount, 0);

	const quote = await post(bob, { text: 'quote body', renoteId: target.id });
	storedTarget = await Notes.findOneByOrFail({ id: target.id });
	assert.strictEqual(storedTarget.renoteCount, 1);

	const deleteQuote = await api('notes/delete', { noteId: quote.id }, bob);
	assert.strictEqual(deleteQuote.status, 204);
	storedTarget = await Notes.findOneByOrFail({ id: target.id });
	assert.strictEqual(storedTarget.renoteCount, 0);
});

test('delete a note that is both a reply and a quote', async () => {
	const replyTarget = await post(alice, { text: 'reply target' });
	const renoteTarget = await post(alice, { text: 'quote target' });
	const child = await post(bob, {
		text: 'reply and quote',
		replyId: replyTarget.id,
		renoteId: renoteTarget.id,
	});

	let storedReplyTarget = await Notes.findOneByOrFail({ id: replyTarget.id });
	let storedRenoteTarget = await Notes.findOneByOrFail({ id: renoteTarget.id });
	assert.strictEqual(storedReplyTarget.repliesCount, 1);
	assert.strictEqual(storedRenoteTarget.renoteCount, 1);

	const deleted = await api('notes/delete', { noteId: child.id }, bob);
	assert.strictEqual(deleted.status, 204);
	storedReplyTarget = await Notes.findOneByOrFail({ id: replyTarget.id });
	storedRenoteTarget = await Notes.findOneByOrFail({ id: renoteTarget.id });
	assert.strictEqual(storedReplyTarget.repliesCount, 0);
	assert.strictEqual(storedRenoteTarget.renoteCount, 0);
});
```

- [ ] **Step 2: Run the focused e2e file and verify RED**

Run:

```text
pnpm exec ncp .github/misskey/test.yml .config/test.yml
pnpm --filter backend test:e2e -- note.ts
```

Expected: the new renote-deletion assertion FAILS because `renoteCount` remains 1.

- [ ] **Step 3: Resolve related targets once and decrement both counters**

Import `shouldCountRenote` and replace the current reply-only decrement block near the start of `delete` with:

```ts
const relatedNoteIds = [...new Set(
	[note.replyId, note.renoteId].filter((id): id is MiNote['id'] => id != null),
)];
const relatedNotes = relatedNoteIds.length === 0
	? []
	: await this.notesRepository.findBy({ id: In(relatedNoteIds) });
const replyTarget = note.replyId == null ? null : relatedNotes.find(target => target.id === note.replyId) ?? null;
const renoteTarget = note.renoteId == null ? null : relatedNotes.find(target => target.id === note.renoteId) ?? null;

if (replyTarget != null) {
	await this.notesRepository.decrement({ id: replyTarget.id }, 'repliesCount', 1);
}

if (renoteTarget != null && shouldCountRenote(renoteTarget, user)) {
	await this.notesRepository.decrement({ id: renoteTarget.id }, 'renoteCount', 1);
}
```

- [ ] **Step 4: Run the focused e2e file and verify GREEN**

Run: `pnpm --filter backend test:e2e -- note.ts`

Expected: PASS for existing reply deletion, pure renote deletion, quote deletion, and the combined child.

- [ ] **Step 5: Commit the task**

```text
git add packages/backend/test/e2e/note.ts packages/backend/src/core/NoteDeleteService.ts
git commit -m "fix(backend): decrement renote counts on deletion"
```

### Task 3: Publish typed realtime count and child-list events

**Files:**
- Modify: `packages/backend/test/utils.ts:371-433`
- Modify: `packages/backend/test/e2e/streaming.ts:12-18,100-130`
- Modify: `packages/backend/src/core/GlobalEventService.ts:104-141`
- Modify: `packages/backend/src/core/NoteCreateService.ts:778-809,844-850,1045-1048`
- Modify: `packages/backend/src/core/NoteDeleteService.ts:63-90`
- Modify: `packages/backend/src/core/NoteUpdateService.ts:135`
- Modify: `packages/misskey-js/src/streaming.types.ts:293-329`

**Interfaces:**
- Produces backend and misskey-js variants `repliesCountChanged`, `renoteCountChanged`, and `childrenChanged`.
- Produces test helper `captureNoteUpdatedEvents<T>(user, noteId, trigger): Promise<{ events; result }>`.
- Count bodies are `{ delta: 1 | -1 }`; child bodies are `{ action: 'added' | 'removed'; childId: string }`.

- [ ] **Step 1: Add a raw note-stream capture helper**

Add this exported helper to `packages/backend/test/utils.ts`:

```ts
export async function captureNoteUpdatedEvents<T>(
	user: UserToken,
	noteId: string,
	trigger: () => Promise<T>,
): Promise<{ events: Record<string, any>[]; result: T }> {
	const url = new URL(`ws://127.0.0.1:${port}/streaming`);
	const options: ClientOptions = {};
	if (user.bearer) {
		options.headers = { Authorization: `Bearer ${user.token}` };
	} else {
		url.searchParams.set('i', user.token);
	}

	const socket = new WebSocket(url, options);
	const events: Record<string, any>[] = [];
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once('error', reject);
			socket.once('unexpected-response', (_request, response) => reject(response));
			socket.once('open', () => {
				socket.send(JSON.stringify({ type: 'sr', body: { id: noteId } }));
				resolve();
			});
		});
		socket.on('message', data => {
			const message = JSON.parse(data.toString());
			if (message.type === 'noteUpdated') events.push(message.body);
		});

		await new Promise(resolve => setTimeout(resolve, 50));
		const result = await trigger();
		await new Promise(resolve => setTimeout(resolve, 250));
		return { events, result };
	} finally {
		socket.close();
	}
}
```

- [ ] **Step 2: Add failing stream event tests**

Import `captureNoteUpdatedEvents` in `streaming.ts`, then add this test inside `describe('Events')`:

```ts
test('note count and child events are published in both directions', async () => {
	const target = await post(kyoko, { text: 'stream target' });

	const replyAdded = await captureNoteUpdatedEvents(kyoko, target.id, () => post(ayano, {
		text: 'stream reply',
		replyId: target.id,
	}));
	assert.ok(replyAdded.events.some(event => event.type === 'repliesCountChanged' && event.body.delta === 1));
	assert.ok(replyAdded.events.some(event => event.type === 'childrenChanged' && event.body.action === 'added' && event.body.childId === replyAdded.result.id));

	const replyRemoved = await captureNoteUpdatedEvents(kyoko, target.id, () => api('notes/delete', {
		noteId: replyAdded.result.id,
	}, ayano));
	assert.ok(replyRemoved.events.some(event => event.type === 'repliesCountChanged' && event.body.delta === -1));
	assert.ok(replyRemoved.events.some(event => event.type === 'childrenChanged' && event.body.action === 'removed' && event.body.childId === replyAdded.result.id));

	const renoteAdded = await captureNoteUpdatedEvents(kyoko, target.id, () => post(ayano, { renoteId: target.id }));
	assert.ok(renoteAdded.events.some(event => event.type === 'renoteCountChanged' && event.body.delta === 1));
	assert.strictEqual(renoteAdded.events.some(event => event.type === 'childrenChanged'), false);

	const renoteRemoved = await captureNoteUpdatedEvents(kyoko, target.id, () => api('notes/delete', {
		noteId: renoteAdded.result.id,
	}, ayano));
	assert.ok(renoteRemoved.events.some(event => event.type === 'renoteCountChanged' && event.body.delta === -1));
	assert.strictEqual(renoteRemoved.events.some(event => event.type === 'childrenChanged'), false);

	const quoteAdded = await captureNoteUpdatedEvents(kyoko, target.id, () => post(ayano, {
		text: 'stream quote',
		renoteId: target.id,
	}));
	assert.ok(quoteAdded.events.some(event => event.type === 'renoteCountChanged' && event.body.delta === 1));
	assert.ok(quoteAdded.events.some(event => event.type === 'childrenChanged' && event.body.action === 'added' && event.body.childId === quoteAdded.result.id));

	const quoteRemoved = await captureNoteUpdatedEvents(kyoko, target.id, () => api('notes/delete', {
		noteId: quoteAdded.result.id,
	}, ayano));
	assert.ok(quoteRemoved.events.some(event => event.type === 'renoteCountChanged' && event.body.delta === -1));
	assert.ok(quoteRemoved.events.some(event => event.type === 'childrenChanged' && event.body.action === 'removed' && event.body.childId === quoteAdded.result.id));

	const combinedAdded = await captureNoteUpdatedEvents(kyoko, target.id, () => post(ayano, {
		text: 'stream reply quote',
		replyId: target.id,
		renoteId: target.id,
	}));
	assert.ok(combinedAdded.events.some(event => event.type === 'repliesCountChanged' && event.body.delta === 1));
	assert.ok(combinedAdded.events.some(event => event.type === 'renoteCountChanged' && event.body.delta === 1));
	assert.strictEqual(combinedAdded.events.filter(event => event.type === 'childrenChanged' && event.body.action === 'added').length, 1);

	const combinedRemoved = await captureNoteUpdatedEvents(kyoko, target.id, () => api('notes/delete', {
		noteId: combinedAdded.result.id,
	}, ayano));
	assert.ok(combinedRemoved.events.some(event => event.type === 'repliesCountChanged' && event.body.delta === -1));
	assert.ok(combinedRemoved.events.some(event => event.type === 'renoteCountChanged' && event.body.delta === -1));
	assert.strictEqual(combinedRemoved.events.filter(event => event.type === 'childrenChanged' && event.body.action === 'removed').length, 1);

	const selfRenoteAdded = await captureNoteUpdatedEvents(kyoko, target.id, () => post(kyoko, { renoteId: target.id }));
	assert.strictEqual(selfRenoteAdded.events.some(event => event.type === 'renoteCountChanged'), false);
	const selfRenoteRemoved = await captureNoteUpdatedEvents(kyoko, target.id, () => api('notes/delete', {
		noteId: selfRenoteAdded.result.id,
	}, kyoko));
	assert.strictEqual(selfRenoteRemoved.events.some(event => event.type === 'renoteCountChanged'), false);

	const bot = await signup({ username: 'streambot' });
	const botUpdate = await api('i/update', { isBot: true }, bot);
	assert.strictEqual(botUpdate.status, 204);
	const botRenoteAdded = await captureNoteUpdatedEvents(kyoko, target.id, () => post(bot, { renoteId: target.id }));
	assert.strictEqual(botRenoteAdded.events.some(event => event.type === 'renoteCountChanged'), false);
	const botRenoteRemoved = await captureNoteUpdatedEvents(kyoko, target.id, () => api('notes/delete', {
		noteId: botRenoteAdded.result.id,
	}, bot));
	assert.strictEqual(botRenoteRemoved.events.some(event => event.type === 'renoteCountChanged'), false);
});
```

- [ ] **Step 3: Run the focused streaming test and verify RED**

Run: `pnpm --filter backend test:e2e -- streaming.ts`

Expected: FAIL because the new count and child event types are not published.

- [ ] **Step 4: Replace the legacy backend event contract**

Remove `replied` from `NoteEventTypes` and add:

```ts
repliesCountChanged: {
	delta: 1 | -1;
};
renoteCountChanged: {
	delta: 1 | -1;
};
childrenChanged: {
	action: 'added' | 'removed';
	childId: MiNote['id'];
};
```

- [ ] **Step 5: Publish creation events after awaited mutations**

Replace the separated reply and renote count blocks in `NoteCreateService` with one deduplicated flow:

```ts
const childTargets = new Map<MiNote['id'], MiNote>();

if (data.reply) {
	await this.saveReply(data.reply);
	this.globalEventService.publishNoteStream(data.reply, 'repliesCountChanged', { delta: 1 });
	childTargets.set(data.reply.id, data.reply);
}

if (data.renote) {
	if (shouldCountRenote(data.renote, user)) {
		await this.incRenoteCount(data.renote);
		this.globalEventService.publishNoteStream(data.renote, 'renoteCountChanged', { delta: 1 });
	}
	if (this.isQuote(data)) childTargets.set(data.renote.id, data.renote);
}

for (const target of childTargets.values()) {
	this.globalEventService.publishNoteStream(target, 'childrenChanged', {
		action: 'added',
		childId: note.id,
	});
}
```

Change the helper signature to:

```ts
@bindThis
private async saveReply(reply: MiNote): Promise<void> {
	await this.notesRepository.increment({ id: reply.id }, 'repliesCount', 1);
}
```

Delete the old `publishNoteStream(data.reply.id, 'replied', ...)` block.

- [ ] **Step 6: Publish deletion events after awaited mutations**

Extend the Task 2 deletion block so it reads:

```ts
const childTargets = new Map<MiNote['id'], MiNote>();

if (replyTarget != null) {
	await this.notesRepository.decrement({ id: replyTarget.id }, 'repliesCount', 1);
	this.globalEventService.publishNoteStream(replyTarget, 'repliesCountChanged', { delta: -1 });
	childTargets.set(replyTarget.id, replyTarget);
}

if (renoteTarget != null) {
	if (shouldCountRenote(renoteTarget, user)) {
		await this.notesRepository.decrement({ id: renoteTarget.id }, 'renoteCount', 1);
		this.globalEventService.publishNoteStream(renoteTarget, 'renoteCountChanged', { delta: -1 });
	}
	if (isRenote(note) && isQuote(note)) childTargets.set(renoteTarget.id, renoteTarget);
}
```

Do not publish the removal invalidation yet. Immediately after the existing awaited `notesRepository.delete(...)` call succeeds, add:

```ts
for (const target of childTargets.values()) {
	this.globalEventService.publishNoteStream(target, 'childrenChanged', {
		action: 'removed',
		childId: note.id,
	});
}
```

This ordering is required: an active detailed view may call `notes/children` as soon as it receives the event, so the child row must already be gone before the invalidation is published.

- [ ] **Step 7: Update the public misskey-js union and the remaining current publish call**

Add these branches to `NoteUpdatedEvent` in `packages/misskey-js/src/streaming.types.ts`:

```ts
} | {
	type: 'repliesCountChanged';
	body: {
		delta: 1 | -1;
	};
} | {
	type: 'renoteCountChanged';
	body: {
		delta: 1 | -1;
	};
} | {
	type: 'childrenChanged';
	body: {
		action: 'added' | 'removed';
		childId: Note['id'];
	};
```

In `NoteUpdateService.ts`, replace `publishNoteStream(note.id, 'updated', ...)` with `publishNoteStream(note, 'updated', ...)` so it matches the current target-note visibility contract.

- [ ] **Step 8: Run the focused streaming test and verify GREEN**

Run: `pnpm --filter backend test:e2e -- streaming.ts`

Expected: PASS for positive and negative reply/renote deltas, direct-reply and quote child events, same-target child-event deduplication, no pure-renote child event, and no count event for self-renotes or bot renotes.

- [ ] **Step 9: Commit the task**

```text
git add packages/backend/test/utils.ts packages/backend/test/e2e/streaming.ts packages/backend/src/core/GlobalEventService.ts packages/backend/src/core/NoteCreateService.ts packages/backend/src/core/NoteDeleteService.ts packages/backend/src/core/NoteUpdateService.ts packages/misskey-js/src/streaming.types.ts
git commit -m "feat: stream note reply and renote count changes"
```

### Task 4: Add reply and renote counts to the polling fallback

**Files:**
- Modify: `packages/backend/test/e2e/note.ts`
- Modify: `packages/backend/src/core/entities/NoteEntityService.ts:614-650`
- Modify: `packages/backend/src/server/api/endpoints/notes/show-partial-bulk.ts:20-45`
- Regenerate: `packages/misskey-js/src/autogen/`
- Regenerate: `packages/misskey-js/generator/api.json`

**Interfaces:**
- Produces `notes/show-partial-bulk` items with `repliesCount: number` and `renoteCount: number`.

- [ ] **Step 1: Add a failing partial-response e2e test**

Add this test to `packages/backend/test/e2e/note.ts`:

```ts
test('notes/show-partial-bulk returns reply and renote counts', async () => {
	const target = await post(alice, { text: 'partial target' });
	await post(bob, { text: 'partial reply', replyId: target.id });
	await post(bob, { text: 'partial quote', renoteId: target.id });

	const response = await api('notes/show-partial-bulk', { noteIds: [target.id] }, alice);
	assert.strictEqual(response.status, 200);
	assert.strictEqual(response.body.length, 1);
	assert.strictEqual(response.body[0].repliesCount, 1);
	assert.strictEqual(response.body[0].renoteCount, 1);
});
```

- [ ] **Step 2: Run the focused e2e test and verify RED**

Run: `pnpm --filter backend test:e2e -- note.ts`

Expected: FAIL because both response properties are undefined.

- [ ] **Step 3: Select and return both counters**

Add both fields to the `fetchDiffs` select:

```ts
select: {
	id: true,
	userHost: true,
	reactions: true,
	reactionAndUserPairCache: true,
	repliesCount: true,
	renoteCount: true,
},
```

Return them in each packed diff:

```ts
return this.customEmojiService.populateEmojis(reactionEmojiNames, note.userHost).then(reactionEmojis => ({
	id: note.id,
	reactions,
	reactionEmojis,
	repliesCount: note.repliesCount,
	renoteCount: note.renoteCount,
}));
```

Add both properties to the endpoint response schema:

```ts
repliesCount: {
	type: 'integer',
	optional: false, nullable: false,
},
renoteCount: {
	type: 'integer',
	optional: false, nullable: false,
},
```

- [ ] **Step 4: Run the focused e2e test and verify GREEN**

Run: `pnpm --filter backend test:e2e -- note.ts`

Expected: PASS with both counters equal to 1.

- [ ] **Step 5: Regenerate misskey-js endpoint types**

Run: `pnpm build-misskey-js-with-types`

Expected: exit 0; generated `NotesShowPartialBulkResponse` items include both counter fields. Review every generated diff and retain only generator output caused by this endpoint schema change.

- [ ] **Step 6: Commit the task**

```text
git add packages/backend/test/e2e/note.ts packages/backend/src/core/entities/NoteEntityService.ts packages/backend/src/server/api/endpoints/notes/show-partial-bulk.ts packages/misskey-js/generator/api.json packages/misskey-js/src/autogen
git commit -m "enhance: include note counts in partial updates"
```

### Task 5: Make note capture own reactive reply and renote counts

**Files:**
- Create: `packages/frontend/test/unit/note-capture.test.ts`
- Modify: `packages/frontend/src/composables/use-note-capture.ts:16-25,92-185,200-360`

**Interfaces:**
- Produces reactive `$note.repliesCount` and `$note.renoteCount`.
- Produces `applyNoteCaptureDiff($note, diff): void`.
- Produces optional callback `onChildrenChanged(event): void` where the event is `{ action; childId }`.
- Consumes optional `forceCapture` to bypass the age cutoff for a single detailed-note view.

- [ ] **Step 1: Write failing capture-state tests**

Create `note-capture.test.ts` with the required SPDX header:

```ts
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import type * as Misskey from 'misskey-js';
import { applyNoteCaptureDiff, noteEvents, useNoteCapture } from '@/composables/use-note-capture.js';

const mountedApps: ReturnType<typeof createApp>[] = [];

function makeNote(): Misskey.entities.Note {
	return {
		id: 'note-id',
		createdAt: new Date().toISOString(),
		reactions: {},
		reactionCount: 0,
		reactionEmojis: {},
		myReaction: null,
		poll: null,
		repliesCount: 2,
		renoteCount: 3,
	} as Misskey.entities.Note;
}

function mountCapture(onChildrenChanged = vi.fn()) {
	const note = makeNote();
	let state!: ReturnType<typeof useNoteCapture>['$note'];
	const app = createApp(defineComponent({
		setup() {
			state = useNoteCapture({ note, parentNote: null, mock: true, onChildrenChanged }).$note;
			return () => h('div');
		},
	}));
	app.mount(document.createElement('div'));
	mountedApps.push(app);
	return { note, state, onChildrenChanged };
}

afterEach(() => {
	for (const app of mountedApps.splice(0)) app.unmount();
});

describe('useNoteCapture counts', () => {
	test('initializes and applies bidirectional count events with a zero floor', () => {
		const { note, state } = mountCapture();
		const emit = noteEvents.emit.bind(noteEvents) as (event: string, body: unknown) => boolean;

		expect(state.repliesCount).toBe(2);
		expect(state.renoteCount).toBe(3);
		emit(`repliesCountChanged:${note.id}`, { delta: 1 });
		emit(`renoteCountChanged:${note.id}`, { delta: -1 });
		expect(state.repliesCount).toBe(3);
		expect(state.renoteCount).toBe(2);
		emit(`renoteCountChanged:${note.id}`, { delta: -1 });
		emit(`renoteCountChanged:${note.id}`, { delta: -1 });
		emit(`renoteCountChanged:${note.id}`, { delta: -1 });
		expect(state.renoteCount).toBe(0);
	});

	test('applies authoritative polling counts', () => {
		const { state } = mountCapture();
		applyNoteCaptureDiff(state, {
			reactions: { ':test:': 1 },
			reactionEmojis: {},
			repliesCount: 8,
			renoteCount: 13,
		});
		expect(state.repliesCount).toBe(8);
		expect(state.renoteCount).toBe(13);
	});

	test('forwards child-list invalidations', () => {
		const { note, onChildrenChanged } = mountCapture();
		const emit = noteEvents.emit.bind(noteEvents) as (event: string, body: unknown) => boolean;
		emit(`childrenChanged:${note.id}`, { action: 'removed', childId: 'child-id' });
		expect(onChildrenChanged).toHaveBeenCalledWith({ action: 'removed', childId: 'child-id' });
	});
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter frontend test -- note-capture.test.ts`

Expected: FAIL because reactive counts, the diff helper, event listeners, and callback do not exist.

- [ ] **Step 3: Extend the event bus and realtime bridge**

Add three keyed events to `noteEvents`:

```ts
[ev: `repliesCountChanged:${string}`]: (ctx: { delta: 1 | -1 }) => void;
[ev: `renoteCountChanged:${string}`]: (ctx: { delta: 1 | -1 }) => void;
[ev: `childrenChanged:${string}`]: (ctx: { action: 'added' | 'removed'; childId: Misskey.entities.Note['id'] }) => void;
```

Add the matching cases to `onStreamNoteUpdated`:

```ts
case 'repliesCountChanged':
	noteEvents.emit(`repliesCountChanged:${id}`, body);
	break;
case 'renoteCountChanged':
	noteEvents.emit(`renoteCountChanged:${id}`, body);
	break;
case 'childrenChanged':
	noteEvents.emit(`childrenChanged:${id}`, body);
	break;
```

- [ ] **Step 4: Extend reactive state and polling application**

Add to `ReactiveNoteData`:

```ts
repliesCount: Misskey.entities.Note['repliesCount'];
renoteCount: Misskey.entities.Note['renoteCount'];
```

Initialize both fields from `note`, add them to the `fetchEvent` and `onFetched` data shapes, and introduce:

```ts
type NoteCaptureDiff = Pick<
	Misskey.entities.Note,
	'reactions' | 'reactionEmojis' | 'repliesCount' | 'renoteCount'
>;

export function applyNoteCaptureDiff($note: ReactiveNoteData, data: NoteCaptureDiff): void {
	$note.reactions = data.reactions;
	$note.reactionCount = Object.values(data.reactions).reduce((a, b) => a + b, 0);
	$note.reactionEmojis = data.reactionEmojis;
	$note.repliesCount = data.repliesCount;
	$note.renoteCount = data.renoteCount;
}
```

Call `applyNoteCaptureDiff($note, data)` from `pollingSubscribe.onFetched`.

- [ ] **Step 5: Subscribe, clamp, forward, and clean up**

Add `onChildrenChanged` and `forceCapture?: boolean` to the `useNoteCapture` props type, then add:

```ts
function onRepliesCountChanged(ctx: { delta: 1 | -1 }): void {
	$note.repliesCount = Math.max(0, $note.repliesCount + ctx.delta);
}

function onRenoteCountChanged(ctx: { delta: 1 | -1 }): void {
	$note.renoteCount = Math.max(0, $note.renoteCount + ctx.delta);
}

function onChildrenChanged(ctx: { action: 'added' | 'removed'; childId: Misskey.entities.Note['id'] }): void {
	props.onChildrenChanged?.(ctx);
}
```

Register all three listeners next to the existing note listeners and remove all three in `onUnmounted`.

Wrap the existing `parentNote`/five-minute early-return block in `if (!props.forceCapture)`. Keep `subscribe()` unchanged after that block. This lets the detailed view opt into capture for an old note without changing the timeline's age-based subscription policy.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run: `pnpm --filter frontend test -- note-capture.test.ts`

Expected: PASS for initial values, positive/negative deltas, zero clamping, polling replacement, and child forwarding.

- [ ] **Step 7: Commit the task**

```text
git add packages/frontend/test/unit/note-capture.test.ts packages/frontend/src/composables/use-note-capture.ts
git commit -m "enhance(frontend): capture realtime note counts"
```

### Task 6: Build and test the bounded replies refresh scheduler

**Files:**
- Create: `packages/frontend/src/composables/use-replies-refresh.ts`
- Create: `packages/frontend/test/unit/replies-refresh.test.ts`

**Interfaces:**
- Produces `createRepliesRefreshScheduler(options)` with `invalidate()`, `notify(change)`, `activate()`, `dispose()`, and `isDirty()`.
- Consumes `{ action: 'added' | 'removed'; childId: string }`, active/loaded predicates, `refresh()`, and `remove(childId)`.

- [ ] **Step 1: Write failing scheduler tests**

Create the test with the required SPDX header:

```ts
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRepliesRefreshScheduler } from '@/composables/use-replies-refresh.js';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});

afterEach(() => vi.useRealTimers());

describe('createRepliesRefreshScheduler', () => {
	test('removes immediately and refreshes active loaded replies', async () => {
		const refresh = vi.fn().mockResolvedValue(undefined);
		const remove = vi.fn();
		const scheduler = createRepliesRefreshScheduler({
			isActive: () => true,
			isLoaded: () => true,
			refresh,
			remove,
		});

		scheduler.notify({ action: 'removed', childId: 'child' });
		expect(remove).toHaveBeenCalledWith('child');
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	test('coalesces events during a request into one throttled follow-up', async () => {
		let finishFirst!: () => void;
		const first = new Promise<void>(resolve => { finishFirst = resolve; });
		const refresh = vi.fn()
			.mockImplementationOnce(() => first)
			.mockResolvedValue(undefined);
		const scheduler = createRepliesRefreshScheduler({
			isActive: () => true,
			isLoaded: () => true,
			refresh,
			remove: vi.fn(),
			throttleMs: 1000,
		});

		scheduler.notify({ action: 'added', childId: 'one' });
		await vi.advanceTimersByTimeAsync(0);
		scheduler.notify({ action: 'added', childId: 'two' });
		finishFirst();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(999);
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	test('defers inactive tabs until activation', async () => {
		let active = false;
		const refresh = vi.fn().mockResolvedValue(undefined);
		const scheduler = createRepliesRefreshScheduler({
			isActive: () => active,
			isLoaded: () => true,
			refresh,
			remove: vi.fn(),
		});

		scheduler.notify({ action: 'added', childId: 'child' });
		await vi.runAllTimersAsync();
		expect(refresh).not.toHaveBeenCalled();
		active = true;
		scheduler.activate();
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	test('keeps failed refreshes dirty without retrying until reactivated', async () => {
		const refresh = vi.fn()
			.mockRejectedValueOnce(new Error('network'))
			.mockResolvedValue(undefined);
		const scheduler = createRepliesRefreshScheduler({
			isActive: () => true,
			isLoaded: () => true,
			refresh,
			remove: vi.fn(),
		});

		scheduler.notify({ action: 'added', childId: 'child' });
		await vi.advanceTimersByTimeAsync(0);
		expect(scheduler.isDirty()).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(refresh).toHaveBeenCalledTimes(1);
		scheduler.activate();
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(2);
	});
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter frontend test -- replies-refresh.test.ts`

Expected: FAIL because `use-replies-refresh.js` does not exist.

- [ ] **Step 3: Implement the single-flight scheduler**

Create the source file with the required SPDX header:

```ts
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface NoteChildrenChange {
	action: 'added' | 'removed';
	childId: string;
}

export function createRepliesRefreshScheduler(options: {
	isActive: () => boolean;
	isLoaded: () => boolean;
	refresh: () => Promise<void>;
	remove: (childId: string) => void;
	throttleMs?: number;
}) {
	const throttleMs = options.throttleMs ?? 1000;
	let dirty = false;
	let running = false;
	let disposed = false;
	let timer: number | null = null;
	let lastStartedAt = -throttleMs;

	function canRefresh(): boolean {
		return !disposed && dirty && options.isActive() && options.isLoaded();
	}

	function schedule(): void {
		if (!canRefresh() || running || timer != null) return;
		const delay = Math.max(0, lastStartedAt + throttleMs - Date.now());
		timer = window.setTimeout(() => { void run(); }, delay);
	}

	async function run(): Promise<void> {
		timer = null;
		if (!canRefresh() || running) return;
		dirty = false;
		running = true;
		lastStartedAt = Date.now();
		let failed = false;
		try {
			await options.refresh();
		} catch {
			dirty = true;
			failed = true;
		} finally {
			running = false;
			if (!failed) schedule();
		}
	}

	function invalidate(): void {
		dirty = true;
		schedule();
	}

	function notify(change: NoteChildrenChange): void {
		if (change.action === 'removed') options.remove(change.childId);
		invalidate();
	}

	function activate(): void {
		schedule();
	}

	function dispose(): void {
		disposed = true;
		if (timer != null) window.clearTimeout(timer);
		timer = null;
	}

	return {
		invalidate,
		notify,
		activate,
		dispose,
		isDirty: () => dirty,
	};
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter frontend test -- replies-refresh.test.ts`

Expected: PASS for immediate removal, one-second follow-up throttling, inactive-tab deferral, and failure retry gating.

- [ ] **Step 5: Commit the task**

```text
git add packages/frontend/src/composables/use-replies-refresh.ts packages/frontend/test/unit/replies-refresh.test.ts
git commit -m "enhance(frontend): schedule bounded reply refreshes"
```

### Task 7: Integrate both note components and verify real UI behavior

**Files:**
- Create: `packages/frontend/test/e2e/note-realtime.spec.ts`
- Modify: `packages/frontend/src/composables/use-note.ts:43-49,120-128,177-199`
- Modify: `packages/frontend/src/components/MkNote.vue:140-152`
- Modify: `packages/frontend/src/components/MkNoteDetailed.vue:163-173,252,283-350,365-412`

**Interfaces:**
- Consumes: reactive `$appearNote` counters, `onChildrenChanged`, and `createRepliesRefreshScheduler`.
- Produces realtime counters in both note layouts and a viewer-filtered replies list refreshed no more than once per second.
- Keeps one old detailed note captured while retaining the timeline's existing age cutoff.

- [ ] **Step 1: Write failing Playwright coverage for MkNote and MkNoteDetailed**

Create the spec with the required SPDX header:

```ts
/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { BASE_URL, registerUser, resetState, signIn } from './utils.js';
import type { RegisteredUser } from './utils.js';

async function api(request: APIRequestContext, user: RegisteredUser, endpoint: string, data: Record<string, unknown>) {
	const response = await request.post(`${BASE_URL}/api/${endpoint}`, {
		data: { i: user.token, ...data },
	});
	expect(response.ok()).toBeTruthy();
	return response.status() === 204 ? null : await response.json();
}

async function closeSetupDialog(page: Page): Promise<void> {
	await page.locator('[data-testid="user-setup-dialog"] [data-testid="modal-window-close"]').click({ timeout: 30_000 });
	await page.getByTestId('modal-dialog-ok').click();
}

function counterButton(page: Page, noteText: string, iconClass: string) {
	const article = page.locator('article').filter({ hasText: noteText }).first();
	return article.locator(`footer button:has(i.${iconClass})`).first();
}

test.describe('realtime note counters and replies', () => {
	let alice: RegisteredUser;
	let bob: RegisteredUser;

	test.beforeEach(async ({ page }) => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
		bob = await registerUser('bob', 'bob1234');
		await signIn(page, 'alice', 'alice1234');
		await closeSetupDialog(page);
	});

	test('MkNote updates reply and renote counters in both directions', async ({ page, request }) => {
		const { createdNote: target } = await api(request, alice, 'notes/create', { text: 'timeline target' });
		await page.goto(BASE_URL);
		await page.getByText('timeline target', { exact: true }).waitFor();
		const replyButton = counterButton(page, 'timeline target', 'ti-arrow-back-up');
		const renoteButton = counterButton(page, 'timeline target', 'ti-repeat');

		const { createdNote: reply } = await api(request, bob, 'notes/create', {
			text: 'timeline reply',
			replyId: target.id,
		});
		await expect(replyButton.locator('p')).toHaveText('1');
		await api(request, bob, 'notes/delete', { noteId: reply.id });
		await expect(replyButton.locator('p')).toHaveCount(0);

		const { createdNote: renote } = await api(request, bob, 'notes/create', { renoteId: target.id });
		await expect(renoteButton.locator('p')).toHaveText('1');
		await api(request, bob, 'notes/delete', { noteId: renote.id });
		await expect(renoteButton.locator('p')).toHaveCount(0);
	});

	test('MkNoteDetailed refreshes visible replies and quotes', async ({ page, request }) => {
		const { createdNote: target } = await api(request, alice, 'notes/create', { text: 'detail target' });
		await page.goto(`${BASE_URL}/notes/${target.id}`);
		await page.getByText('detail target', { exact: true }).waitFor();
		const replyButton = counterButton(page, 'detail target', 'ti-arrow-back-up');
		const renoteButton = counterButton(page, 'detail target', 'ti-repeat');

		const { createdNote: reply } = await api(request, bob, 'notes/create', {
			text: 'visible live reply',
			replyId: target.id,
		});
		await expect(replyButton.locator('p')).toHaveText('1');
		await expect(page.getByText('visible live reply', { exact: true })).toBeVisible();
		await api(request, bob, 'notes/delete', { noteId: reply.id });
		await expect(replyButton.locator('p')).toHaveCount(0);
		await expect(page.getByText('visible live reply', { exact: true })).toHaveCount(0);

		const { createdNote: quote } = await api(request, bob, 'notes/create', {
			text: 'visible live quote',
			renoteId: target.id,
		});
		await expect(renoteButton.locator('p')).toHaveText('1');
		await expect(page.getByText('visible live quote', { exact: true })).toBeVisible();
		await api(request, bob, 'notes/delete', { noteId: quote.id });
		await expect(renoteButton.locator('p')).toHaveCount(0);
		await expect(page.getByText('visible live quote', { exact: true })).toHaveCount(0);
	});
});
```

- [ ] **Step 2: Build and run the new browser test to verify RED**

Run:

```text
pnpm exec ncp .github/misskey/test.yml .config/test.yml
pnpm build
pnpm exec start-server-and-test start:test http://localhost:61812 "pnpm --filter frontend test:e2e -- note-realtime.spec.ts"
```

Expected: FAIL because the displayed counts still read `appearNote`, capture does not yet forward the callback through `useNote`, and the replies list has no scheduler integration.

- [ ] **Step 3: Forward child changes and use the reactive tooltip count**

Add to `UseNoteOptions`:

```ts
onChildrenChanged?: (event: { action: 'added' | 'removed'; childId: Misskey.entities.Note['id'] }) => void;
forceNoteCapture?: boolean;
```

Pass `onChildrenChanged: options.onChildrenChanged` and `forceCapture: options.forceNoteCapture` into `useNoteCapture`. In the renote tooltip props, replace `count: appearNote.renoteCount` with:

```ts
count: $appearNote.renoteCount,
```

- [ ] **Step 4: Render both counters from reactive state**

In both `MkNote.vue` and `MkNoteDetailed.vue`, replace the reply and renote count expressions with:

```vue
<p v-if="$appearNote.repliesCount > 0" :class="$style.footerButtonCount">{{ number($appearNote.repliesCount) }}</p>
<p v-if="$appearNote.renoteCount > 0" :class="$style.footerButtonCount">{{ number($appearNote.renoteCount) }}</p>
```

Use the existing `noteFooterButtonCount` class name instead of `footerButtonCount` in the `MkNoteDetailed.vue` copies.

- [ ] **Step 5: Integrate the scheduler into MkNoteDetailed**

Import `watch` and `onUnmounted` from Vue and import the scheduler plus `NoteChildrenChange`. Pass `onChildrenChanged` and `forceNoteCapture: true` through the `useNote` options. Replace the existing replies block with this structure:

```ts
const replies = ref<Misskey.entities.Note[]>([]);
const repliesLoaded = ref(false);

async function refreshReplies(): Promise<void> {
	replies.value = await misskeyApi('notes/children', {
		noteId: appearNote.id,
		limit: 30,
	});
}

async function loadReplies(): Promise<void> {
	try {
		await refreshReplies();
	} catch {
		repliesRefreshScheduler.invalidate();
	} finally {
		repliesLoaded.value = true;
		repliesRefreshScheduler.activate();
	}
}

const repliesRefreshScheduler = createRepliesRefreshScheduler({
	isActive: () => tab.value === 'replies',
	isLoaded: () => repliesLoaded.value,
	refresh: refreshReplies,
	remove: (childId) => {
		replies.value = replies.value.filter(reply => reply.id !== childId);
	},
	throttleMs: 1000,
});

function onChildrenChanged(event: NoteChildrenChange): void {
	repliesRefreshScheduler.notify(event);
}

watch(tab, (value) => {
	if (value === 'replies') repliesRefreshScheduler.activate();
});

onUnmounted(() => repliesRefreshScheduler.dispose());
```

Ensure the `onChildrenChanged` function declaration is in scope when passed to `useNote`; function declarations may appear later in the script. Keep the existing `onMounted` call that invokes `loadReplies()` and `loadConversation()`.

- [ ] **Step 6: Run focused frontend unit tests**

Run:

```text
pnpm --filter frontend test -- note-capture.test.ts replies-refresh.test.ts
```

Expected: PASS with no warnings or unhandled rejections.

- [ ] **Step 7: Rebuild and run the Playwright test to verify GREEN**

Run:

```text
pnpm build
pnpm exec start-server-and-test start:test http://localhost:61812 "pnpm --filter frontend test:e2e -- note-realtime.spec.ts"
```

Expected: both tests PASS: MkNote counters change in both directions, and MkNoteDetailed counters/list add and remove visible replies and quotes.

- [ ] **Step 8: Commit the task**

```text
git add packages/frontend/test/e2e/note-realtime.spec.ts packages/frontend/src/composables/use-note.ts packages/frontend/src/components/MkNote.vue packages/frontend/src/components/MkNoteDetailed.vue
git commit -m "fix(frontend): update note counters and replies in realtime"
```

### Task 8: Changelog, generated-diff audit, reviewers, and final validation

**Files:**
- Modify: `CHANGELOG.md`
- Modify only if reviewer findings require it: files already listed in Tasks 1-7

**Interfaces:**
- Produces a review-ready Misskey change with documented validation evidence.

- [ ] **Step 1: Add exact Unreleased changelog entries**

Append under `## Unreleased` → `### Client`:

```text
- Fix: ノートの返信・Renote数と詳細画面の返信一覧がリアルタイムに更新されない問題を修正
```

Append under `## Unreleased` → `### Server`:

```text
- Fix: Renoteを削除した際に対象ノートのRenote数が減少しない問題を修正
```

- [ ] **Step 2: Run focused backend and frontend validation**

Run:

```text
pnpm --filter backend test -- should-count-renote.ts
pnpm --filter backend test:e2e -- note.ts streaming.ts
pnpm --filter frontend test -- note-capture.test.ts replies-refresh.test.ts
pnpm build-misskey-js-with-types
```

Expected: all commands exit 0. After regeneration, `git diff -- packages/misskey-js/src/autogen packages/misskey-js/generator/api.json` contains only the two new partial-response counter fields.

- [ ] **Step 3: Run targeted lint on every touched source and test file**

Run:

```text
pnpm exec eslint --quiet packages/backend/src/misc/should-count-renote.ts packages/backend/test/unit/misc/should-count-renote.ts packages/backend/test/e2e/note.ts packages/backend/test/e2e/streaming.ts packages/backend/test/utils.ts packages/backend/src/core/GlobalEventService.ts packages/backend/src/core/NoteCreateService.ts packages/backend/src/core/NoteDeleteService.ts packages/backend/src/core/NoteUpdateService.ts packages/backend/src/core/entities/NoteEntityService.ts packages/backend/src/server/api/endpoints/notes/show-partial-bulk.ts packages/misskey-js/src/streaming.types.ts packages/frontend/test/unit/note-capture.test.ts packages/frontend/test/unit/replies-refresh.test.ts packages/frontend/test/e2e/note-realtime.spec.ts packages/frontend/src/composables/use-note-capture.ts packages/frontend/src/composables/use-replies-refresh.ts packages/frontend/src/composables/use-note.ts packages/frontend/src/components/MkNote.vue packages/frontend/src/components/MkNoteDetailed.vue
```

Expected: exit 0 for all touched files.

- [ ] **Step 4: Run full repository lint and compare with the recorded baseline**

Run: `pnpm lint`

Expected on the current branch: it may still exit 1 on unrelated pre-existing type errors. Confirm that the previous `NoteCreateService.ts` and `NoteUpdateService.ts` `publishNoteStream(string, ...)` errors are gone and that no new error points to a touched file. If full lint unexpectedly passes, record the successful exit instead.

- [ ] **Step 5: Run repository safety checks**

Run:

```text
git diff --check HEAD~7
git diff --name-only develop -- 'locales/*.yml'
git status --short
```

Expected: no whitespace errors; no locale files changed; status contains only intentional files or is clean after task commits. Inspect the first five lines of every new `.ts` file and confirm the AGPL SPDX header.

- [ ] **Step 6: Run required mechanical reviewers**

Use the `misskey-api-reviewer` agent because `notes/show-partial-bulk` changes, and the `vue-component-reviewer` agent because two `.vue` files change. Give each reviewer the complete final diff. Address every valid finding, rerun the relevant focused test/lint command, and commit corrections normally without amending earlier commits.

- [ ] **Step 7: Commit changelog and reviewer corrections**

```text
git add CHANGELOG.md \
	packages/backend/src/misc/should-count-renote.ts \
	packages/backend/test/unit/misc/should-count-renote.ts \
	packages/backend/test/e2e/note.ts \
	packages/backend/test/e2e/streaming.ts \
	packages/backend/test/utils.ts \
	packages/backend/src/core/GlobalEventService.ts \
	packages/backend/src/core/NoteCreateService.ts \
	packages/backend/src/core/NoteDeleteService.ts \
	packages/backend/src/core/NoteUpdateService.ts \
	packages/backend/src/core/entities/NoteEntityService.ts \
	packages/backend/src/server/api/endpoints/notes/show-partial-bulk.ts \
	packages/misskey-js/generator/api.json \
	packages/misskey-js/src/autogen \
	packages/misskey-js/src/streaming.types.ts \
	packages/frontend/test/unit/note-capture.test.ts \
	packages/frontend/test/unit/replies-refresh.test.ts \
	packages/frontend/test/e2e/note-realtime.spec.ts \
	packages/frontend/src/composables/use-note-capture.ts \
	packages/frontend/src/composables/use-replies-refresh.ts \
	packages/frontend/src/composables/use-note.ts \
	packages/frontend/src/components/MkNote.vue \
	packages/frontend/src/components/MkNoteDetailed.vue
git commit -m "fix: finalize realtime note count updates"
```

- [ ] **Step 8: Verify final commit and worktree state**

Run:

```text
git status --short --branch
git log -8 --oneline --decorate
git show --check --stat HEAD
```

Expected: the worktree is clean, the intended task commits are present, and the final commit has no whitespace errors.
