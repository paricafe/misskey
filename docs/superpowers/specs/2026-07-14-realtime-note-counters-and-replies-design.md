# Realtime Note Counters and Replies Design

**Status:** Approved for implementation planning

**Date:** 2026-07-14

## Context

`MkNote.vue` and `MkNoteDetailed.vue` render reply and renote counts from the non-reactive `appearNote` clone. Their shared `useNoteCapture` state currently tracks reactions and poll choices, but not `repliesCount` or `renoteCount`. As a result, those counters remain stale while the note is open.

This branch also contains a legacy backend `replied` note-stream event, but the event is missing from `misskey-js`'s `NoteUpdatedEvent`, is no longer consumed by the frontend after the MkNote/MkNoteDetailed shared-logic refactor, and uses the pre-refactor `publishNoteStream` calling convention. There is no equivalent renote event. Deleting a reply decrements the stored reply count, while deleting a renote currently does not decrement the stored renote count.

`MkNoteDetailed` initially loads up to 30 visible child notes through `notes/children`. That endpoint includes direct replies and renote children that satisfy its existing content predicate, applies the current viewer's visibility and filtering rules, and is therefore the authoritative source for the visible replies tab.

## Goals

- Update reply and renote counters in `MkNote` and `MkNoteDetailed` while the note is open.
- Increment counters when a counted reply, renote, or quote is created.
- Decrement counters when the corresponding child note is deleted or a renote is undone.
- Keep the `MkNoteDetailed` replies tab synchronized with visible direct replies and quote notes.
- Preserve per-viewer visibility rules for child notes.
- Bound refresh traffic for rapidly changing, popular notes.
- Keep non-realtime polling mode eventually consistent with the same counters.

## Non-goals

- Turning the replies tab into an unbounded or fully paginated thread view.
- Realtime updates to the renotes or reactions pagination contents.
- Broadcasting complete reply or quote objects through the target note stream.
- Refactoring unrelated note rendering, stream subscription, or pagination code.

## Considered Approaches

### Refetch the full note after every count event

This provides authoritative absolute counts but adds one API request per event per viewer, duplicates data already known to the server, and creates ordering races when multiple requests complete out of order.

### Poll counts and children only

This is simple and naturally resynchronizes state, but updates are delayed by the polling interval and do not satisfy the realtime requirement.

### Stream count deltas and invalidate the child list

This is the selected approach. Small target-note stream events update counters immediately. A separate child-list invalidation event lets `MkNoteDetailed` refresh through `notes/children`, preserving visibility checks. Refreshes are coalesced and throttled so a burst of replies does not cause a request per event.

## Event Contract

The note stream gains three event variants:

```ts
type NoteCountDelta = 1 | -1;

{
	type: 'repliesCountChanged';
	body: { delta: NoteCountDelta };
}

{
	type: 'renoteCountChanged';
	body: { delta: NoteCountDelta };
}

{
	type: 'childrenChanged';
	body: {
		action: 'added' | 'removed';
		childId: Note['id'];
	};
}
```

These variants are defined in both the backend `NoteEventTypes` contract and `packages/misskey-js/src/streaming.types.ts`.

Count events are emitted only when the corresponding database count changes. `childrenChanged` is emitted for direct replies and non-pure renotes so `notes/children` can authoritatively decide whether the child belongs in the visible list; it is not emitted for pure renotes. At most one child event is emitted per affected target note, even when the new child both replies to and quotes the same target.

The target note object is passed to `publishNoteStream`. This keeps the existing parent-note visibility filtering in `Connection`. The event never includes a packed child note because visibility of the parent does not imply visibility of a reply or quote.

## Backend Data Flow

### Creation

For a direct reply:

1. Increment the target note's `repliesCount`.
2. Publish `repliesCountChanged` with `delta: 1` to the target note stream.
3. Publish `childrenChanged` with `action: 'added'` and the new reply ID.

For a quote:

1. Apply the existing renote-count eligibility rule.
2. If eligible, increment `renoteCount` and publish `renoteCountChanged` with `delta: 1`.
3. Publish `childrenChanged` with `action: 'added'` and the quote ID, regardless of whether the quote was eligible for the count.

For a pure renote:

1. Apply the existing renote-count eligibility rule.
2. If eligible, increment `renoteCount` and publish `renoteCountChanged` with `delta: 1`.
3. Do not publish `childrenChanged`.

The existing eligibility rule remains authoritative: a user's renote of their own note and a bot user's renote do not change `renoteCount`. Quotes follow the same rule because the current creation path counts all eligible renotes, not only pure renotes.

Database mutation completes before its stream event is published. No count event is published when the mutation is skipped or fails.

### Deletion and unrenote

Before deleting a child note, the service resolves any reply target and renote target needed for counter updates and stream visibility metadata.

For a deleted direct reply:

1. Decrement the reply target's `repliesCount`.
2. Publish `repliesCountChanged` with `delta: -1`.
3. Publish `childrenChanged` with `action: 'removed'` and the deleted reply ID.

For a deleted quote:

1. Apply the same renote-count eligibility rule used at creation time.
2. If eligible, decrement the target's `renoteCount` and publish `renoteCountChanged` with `delta: -1`.
3. Publish `childrenChanged` with `action: 'removed'` and the deleted quote ID.

For a deleted pure renote:

1. Apply the same renote-count eligibility rule used at creation time.
2. If eligible, decrement the target's `renoteCount` and publish `renoteCountChanged` with `delta: -1`.
3. Do not publish `childrenChanged`.

A note that is simultaneously a reply and a quote updates both targets independently. If the reply and renote targets differ, each target receives its applicable count and child-list events. If they are the same target, the target receives both applicable count deltas but only one `childrenChanged` event. Missing targets do not produce counter or child-list events. The frontend clamps displayed counts at zero as a defensive measure; the backend remains the source of truth.

## Frontend Counter State

`ReactiveNoteData` in `use-note-capture.ts` gains `repliesCount` and `renoteCount`, initialized from the packed note.

Realtime handlers apply count deltas as follows:

```ts
$note.repliesCount = Math.max(0, $note.repliesCount + delta);
$note.renoteCount = Math.max(0, $note.renoteCount + delta);
```

`MkNote.vue` and `MkNoteDetailed.vue` render both counters from `$appearNote`. The renote tooltip also uses the reactive renote count.

When realtime mode is disabled, `notes/show-partial-bulk` returns `repliesCount` and `renoteCount` alongside reaction differences. The existing polling path replaces the reactive counts with those authoritative values. This is an eventually consistent fallback, not a second realtime mechanism.

## Realtime Replies-Tab Refresh

`useNoteCapture` accepts an optional child-change callback. `useNote` forwards that callback through its options so `MkNoteDetailed` can react to `childrenChanged` without duplicating the note-stream subscription. `MkNote` does not supply the callback.

`MkNoteDetailed` maintains a dirty flag and a single-flight refresh scheduler:

- On `childrenChanged`, mark the replies list dirty.
- For `action: 'removed'`, immediately remove a matching child ID from the displayed list so deletion feels instantaneous.
- If the replies tab is active and its initial load has completed, schedule a refresh.
- Coalesce events received during the throttle window into one refresh.
- Limit refresh starts to at most approximately once per second per open detailed-note view.
- If an event arrives during a request, keep the dirty flag set and run one follow-up refresh after the active request and throttle window complete.
- If another tab is active, do not issue a request. Refresh when the user next activates the replies tab.

The refresh calls the existing `notes/children` endpoint with the current limit of 30 and replaces the list with the authoritative visible result. This handles additions, removals, visibility changes, ordering, direct replies, and quotes without reproducing backend filtering logic in the client.

If a refresh fails, retain the current list and keep it dirty. A later child event or a later activation of the replies tab retries the refresh. Counter updates remain independent and are not rolled back by a list-refresh failure.

## Performance Characteristics

- The design reuses the existing per-note stream subscription; it creates no additional WebSocket connection or subscription.
- Counter events have constant-size payloads and require no follow-up request.
- Only an open `MkNoteDetailed` view with the replies tab active refreshes children immediately.
- Bursts are coalesced, and continuous activity is capped at roughly one `notes/children` request per second per active detailed view.
- Inactive tabs generate no child-list request; they perform one refresh when reopened if dirty.
- Each refresh returns at most the existing 30 child notes.

This makes ordinary usage negligible while preventing request-per-reply amplification on active popular notes. Extremely popular notes can still cause one bounded query per active viewer per throttle interval, which is the trade-off for safe viewer-specific filtering.

## Error Handling and Consistency

- Stream events are published only after successful database mutations.
- Counter values are clamped at zero in the client.
- Child-list refreshes are authoritative and deduplicate results by replacement.
- Failed child-list refreshes do not clear the dirty flag.
- Existing note-stream reconnect behavior is retained. Polling mode periodically restores authoritative counters when realtime mode is disabled.
- No reply content is exposed through a stream event without a viewer-specific API visibility check.

## Expected File Changes

- `packages/backend/src/core/GlobalEventService.ts`
  - Define the count-delta and child-change note events.
- `packages/backend/src/core/NoteCreateService.ts`
  - Publish creation-side events after successful counter updates.
- `packages/backend/src/core/NoteDeleteService.ts`
  - Decrement renote counts and publish deletion-side events.
- `packages/backend/src/core/entities/NoteEntityService.ts`
  - Include both counters in partial polling data.
- `packages/backend/src/server/api/endpoints/notes/show-partial-bulk.ts`
  - Declare both counters in the endpoint response schema.
- `packages/misskey-js/src/streaming.types.ts`
  - Add the public note-stream event variants.
- `packages/misskey-js/src/autogen/`
  - Regenerate endpoint types after changing `notes/show-partial-bulk`.
- `packages/frontend/src/composables/use-note-capture.ts`
  - Store counters, consume events, update polling data, and forward child changes.
- `packages/frontend/src/composables/use-note.ts`
  - Forward the optional child-change callback and use the reactive tooltip count.
- `packages/frontend/src/components/MkNote.vue`
  - Render reactive reply and renote counts.
- `packages/frontend/src/components/MkNoteDetailed.vue`
  - Render reactive counts and implement the throttled replies refresh scheduler.
- Backend and frontend test files selected during implementation planning.
- `CHANGELOG.md`
  - Record the user-visible client behavior change and the corrected renote count on deletion.

## Test Strategy

### Backend

- Verify reply creation and deletion change `repliesCount` in both directions.
- Verify eligible pure renotes and quotes change `renoteCount` in both directions.
- Verify self-renotes and bot renotes do not change `renoteCount` or emit count deltas.
- Verify a reply that is also a quote updates both targets.
- Verify note-stream subscribers receive the correct positive and negative count deltas.
- Verify `childrenChanged` is emitted for direct replies and quotes, but not pure renotes.
- Verify `notes/show-partial-bulk` returns both counters.

### Frontend

- Verify count-delta events increment and decrement reactive counters and clamp at zero.
- Verify polling data replaces both counter values.
- Verify `MkNote` and `MkNoteDetailed` render reactive counter state.
- With fake timers, verify bursts schedule only one replies refresh per throttle window.
- Verify events received during a request result in one follow-up refresh.
- Verify inactive tabs defer refresh until activation.
- Verify removed child IDs disappear immediately.
- Verify failed refreshes retain the list and dirty state for a later retry.

### Validation

- Run focused backend unit/e2e tests for note creation, deletion, and streaming.
- Run focused frontend unit tests for capture state and the refresh scheduler.
- Run `pnpm build-misskey-js-with-types` because the backend endpoint response changes.
- Run frontend and backend typechecks/lint through the repository's required validation commands.
- Run the final Misskey shipping checklist, including SPDX, locale safety, CHANGELOG, and generated-file review.
