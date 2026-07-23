# Mastodon API Compatibility Fixes Design

## Goal

Correct the confirmed Mastodon-compatible API behavior gaps without weakening
Misskey's native API semantics, and make every corrected behavior reproducible
through focused backend tests.

## Scope

The implementation covers the issues confirmed in the second review:

- Preserve the requested visibility when boosting a status.
- Validate status polls as a complete parameter group.
- Apply Mastodon poll votes atomically after validating all choices.
- Paginate quote statuses independently from pure boosts.
- Make bookmark and unbookmark operations idempotent.
- Permit edits to media-only statuses.
- Return a correct `voters_count` for Mastodon poll entities.
- Keep duplicate textual mentions from misaligning account IDs and URLs.
- Correct branch shipping blockers involving SPDX and non-source locale changes.
- Preserve complete status-edit snapshots in the existing JSONB history column.

Changes outside this list are excluded unless they are required to keep an
existing test or public API contract correct.

## Compatibility Strategy

Mastodon requests must either be honored exactly or rejected before creating
side effects. Unsupported or malformed combinations must never succeed while
silently producing a different status.

The compatibility routes continue to delegate ordinary Misskey operations to
native endpoints. Logic that has no safe native equivalent is isolated in a
Mastodon-specific service instead of changing the behavior of native Misskey
clients.

## Status Actions

### Boost visibility and idempotence

The boost route will parse Mastodon's `public`, `unlisted`, and `private`
visibility values and map them through the existing visibility conversion.
The mapped value is passed to `notes/create`.

Before creating a boost, the route checks for an existing pure renote by the
same user and target. Mastodon-originated concurrent requests are serialized
with the existing user/kind advisory-lock mechanism. If a pure renote already
exists, its current entity is returned instead of federating another activity.
Quotes are never reused as boosts.

### Bookmark idempotence

`ALREADY_FAVORITED` and `NOT_FAVORITED` are normalized in the same narrow way
as the existing reaction idempotency errors. Other native errors continue to
propagate.

## Status Creation Validation

Poll input is parsed once into a typed compatibility value before media
sensitivity updates, draft creation, or note creation.

- Poll options and `expires_in` must be provided together.
- A poll must contain at least two non-empty options.
- Media and polls are mutually exclusive.
- `multiple` must be a valid boolean.
- Invalid or unsupported `hide_totals=true` is rejected because Misskey cannot
  preserve that visibility rule.
- Poll expiration must be a positive, bounded integer.
- Scheduled statuses must remain at least five minutes in the future.

Validation failures return a Mastodon 4xx response without creating a note,
draft, vote, or media-side effect.

## Atomic Poll Voting

A Mastodon-specific poll-voting service will:

1. Parse every supplied choice as an integer without silently dropping values.
2. Load the poll and validate bounds, expiration, uniqueness, and
   single/multiple-choice constraints.
3. Check the user's existing votes.
4. Insert all requested votes and update counts inside one database
   transaction.
5. Publish stream and federation effects only after the transaction succeeds.

Any invalid choice or conflicting existing vote rejects the whole request.
No partial vote remains committed.

## Quote Pagination

The quote endpoint will scan native renote pages using native IDs as cursors,
discard pure boosts, and continue until it has collected the requested number
of quotes plus one look-ahead item or has exhausted the source.

The scan is bounded per request to prevent unbounded database work. Mastodon
cursor parameters are opaque, so Link headers use the underlying renote-stream
ID at the scan boundary even when that row is a pure boost. Response entities
remain quote-only. This lets a boost-only scan window continue without
skipping older quotes or requiring server-side cursor state.

## Status Editing and History

Media-only edits pass nullable text through a Mastodon-specific update path
instead of coercing it to an empty string rejected by `notes/update`.

Complete historical Mastodon `StatusEdit` entities require immutable revision
snapshots containing text, content warning, media attachment data and
sensitivity, poll state, quote state, emojis, and revision time.

The existing `note.history` column is JSONB, so its element shape can be
extended with optional snapshot fields without a schema migration. Existing
text/CW-only history remains readable through conservative fallbacks, while
new revisions store the complete shape. The JSON schema and TypeScript types
are extended together.

No migration is planned. If implementation evidence later shows that a schema
change is unavoidable, work stops before creating a migration and the table,
indexes, compatibility strategy, and reversible `up()`/`down()` operations
are presented separately for user review. Existing merged migrations are
never edited.

## Poll Entity Counts

For single-choice polls, `voters_count` is `null`.

For multiple-choice polls, the compatibility response uses a distinct-user
count obtained in a bounded batch query. It does not substitute
`votes_count`, because one voter may select several options. Timeline and
status collection paths must batch these lookups to avoid per-status queries.

## Mention Mapping

Parsed textual mentions are deduplicated by normalized `username@host` in
first-occurrence order before they are paired with Misskey's deduplicated
mention IDs. This preserves the native resolver's ordering and prevents a
repeated mention from shifting later account identities.

## Repository Hygiene

The suspicious copied migration is not rewritten blindly. Its provenance and
whether it duplicates a merged migration are checked first. If it is genuinely
new, it receives the required SPDX header and a valid unique migration name;
if it is accidental or duplicates existing history, a removal proposal is
presented before deletion.

Non-`ja-JP.yml` locale differences are compared against the branch's source
locale change. Generated translation-target edits are removed from this branch
without changing `ja-JP.yml`.

## Testing

Every behavior change follows a red-green cycle with focused tests:

- Boost visibility and repeated/concurrent boost requests.
- Repeated bookmark and unbookmark requests.
- Missing, partial, malformed, media-conflicting, and unsupported poll input.
- Invalid and mixed poll choices proving no partial votes are stored.
- Quote pagination with more pure boosts than one native page.
- Media-only status editing.
- Single- and multiple-choice voter counts.
- Duplicate mention ordering.

After focused tests pass, run the complete Mastodon backend unit set, backend
lint/type checking, `git diff --check`, locale safety, and SPDX validation.
The migration checker is required only if a separately approved migration is
eventually added.

## Success Criteria

- Each confirmed request either produces Mastodon-compatible output or fails
  before side effects.
- Privacy-reducing defaults are never substituted for explicit client input.
- Repeated status actions do not create duplicate activities or native
  idempotency errors.
- Pagination cannot hide reachable quotes.
- Poll votes cannot commit partially.
- The focused and existing Mastodon test suites pass.
- The branch contains no prohibited locale edits or unlicensed new backend
  source files.
