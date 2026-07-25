# PGroonga Note Search Planner Fix

## Problem

`notes/search` currently applies the PGroonga predicate and the newest-first
ordering in the same query:

```sql
WHERE note.text &@~ :q
ORDER BY note.id DESC
LIMIT :limit
```

For a query such as `pari`, PostgreSQL chooses a parallel backward scan of the
note primary key so that it can produce rows in ID order. It then evaluates the
PGroonga predicate as a filter. The production plan estimated a total cost of
about 24.5 million and did not use the PGroonga index, causing Misskey's
10-second statement timeout to cancel the query.

A materialized CTE containing only the PGroonga match reduced the estimated
cost to about 84 thousand and used
`IDX_f27f5d88941e57442be75ba9c8`.

## Requirements

- Preserve exact search semantics: return the newest visible notes among all
  matching notes.
- Preserve all existing pagination, user, channel, host, date-range,
  visibility, blocked-host, suspended-user, mute, and block filters.
- Do not impose a fixed candidate limit or change the ordering to relevance.
- Do not change the `sqlLike` or Meilisearch paths.
- Do not add or modify a database migration.

## Design

When the configured provider is `sqlPgroonga`, build a query that selects
matching note IDs:

```sql
SELECT search_note.id
FROM note AS search_note
WHERE search_note.text &@~ :q
```

Add this query to the existing note query as a `MATERIALIZED` CTE and join the
outer `note` alias to the CTE by ID. The existing outer query remains
responsible for:

- pagination and newest-first ordering;
- selecting the full note, reply, renote, and user entities;
- user, channel, host, and date-range restrictions;
- visibility and base note filtering;
- applying the requested result limit.

The materialization boundary prevents PostgreSQL from flattening the full-text
predicate back into the ordered outer query. It therefore makes the PGroonga
index produce the complete candidate ID set before the outer query sorts and
filters it.

For `sqlLike`, retain the current `LOWER(note.text) LIKE :q` predicate directly
on the outer query.

## Alternatives Considered

### Alter the sort expression

Ordering by a no-op expression derived from `note.id` can prevent PostgreSQL
from using the primary key for ordering. This is smaller but relies on an
optimizer side effect and may stop working after a PostgreSQL change.

### Move installations to Meilisearch

Meilisearch scales independently from PostgreSQL, but it adds operational and
indexing requirements and does not provide an exact drop-in replacement for
the current SQL search semantics.

### Limit PGroonga candidates before filtering

This would be faster for very common terms, but it can omit the true newest
visible results when early candidates are removed by visibility or moderation
filters. It violates the exact-result requirement.

## Testing

Add a focused backend regression test for query construction:

- the PGroonga path produces a materialized CTE;
- the CTE contains the `&@~` predicate and selects note IDs;
- the outer query joins the CTE and retains newest-first pagination and the
  requested limit;
- the SQL-like path does not add the CTE and retains its current predicate.

Run the focused test, the relevant backend test suite, and repository lint.
No API schema regeneration, migration validation, or locale validation is
required because the endpoint contract, entities, migrations, and locales do
not change.

## Operational Verification

After deployment, compare `EXPLAIN` for the complete generated query. The
full-text stage should use
`IDX_f27f5d88941e57442be75ba9c8`, and the application should return the newest
visible results for `pari` without reaching the 10-second statement timeout.
