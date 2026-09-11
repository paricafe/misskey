# Mastodon compatibility boundaries

The compatibility API follows the common Mastodon request and response contracts. It does not select behavior by client name or user agent. Native Misskey authentication and ordinary native API defaults remain in effect.

## Implemented behavior

| Area | Contract |
| --- | --- |
| Request encoding | JSON, URL-encoded forms and text multipart fields share array and nested-parameter parsing. File upload routes consume their multipart streams separately. |
| Browser access | Compatibility routes allow GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. Pagination and rate-limit response headers are exposed to browser clients. |
| OAuth | Registration accepts redirect URI arrays. OOB authorization displays a code. Token/revoke validate client credentials and ownership; native OAuth retains its original request handling. |
| Consent | Mastodon scopes, including push and collections, are shown separately from native permissions. `force_login` verifies the selected account; `lang` affects the authorization page without changing the saved locale. |
| Pagination | `since_id` selects the newest results above a lower bound. `min_id` selects the nearest newer page. Responses are descending and Link cursors use the actual ID extrema. Intermediate queries retain their own limits. |
| Conversation context | Replies are traversed recursively using reply edges and current visibility checks. Quotes are excluded. Anonymous traversal is bounded to 40 ancestors, 60 descendants and 20 descendant levels; authenticated traversal is bounded to 4096. |
| Account resolution | `resolve=true` supports complete account addresses via native remote resolution. Account lookup only returns an already known account. |
| Relationships | Repeated follow/unfollow/block/unblock requests are idempotent. Compatibility reblog/language preferences filter home streams and timelines. Mute duration and notification settings are persisted and apply to REST, Streaming and Push. |
| List scopes | Reading a list timeline requires `read:lists`. |
| Streaming | List/tag events preserve their full subscription identity. Edits reload the currently visible note and recheck active subscriptions before delivery. |
| Push | Disabling `enableMastodonApi` stops compatibility subscription lookups and delivery at both notification entry points. Unsupported update/admin alerts are returned as false. |
| Favourites | Only heart reactions (`❤`, `❤️`) map to favourites. A different existing emoji produces an explicit conflict on favourite; unfavourite preserves that emoji. Conditional native reaction writes protect concurrent edits while retaining native Like/Undo and notification delivery. |

## Media and status metadata

Each new compatibility upload disables native file deduplication and registers its own attachment record. Media updates and deletion require that registration and reject a file already referenced by a note, draft, avatar or banner. Omitted descriptions are preserved; focus coordinates are validated and returned in attachment metadata.

Cancellation revokes the compatibility attachment without physically deleting the Drive file. A native client can attach that file concurrently, so scheduling a physical deletion from this API would risk breaking native content. The file remains under its owner's native Drive management.

Post-upload description and focus edits are compatibility metadata. Native Drive and ActivityPub retain the upload's original description. Custom replacement thumbnails return 422.

Status language and sensitivity are stored per status in `mastodon_user_state`. Creating or editing a status does not rewrite shared Drive sensitivity. Account posting defaults are also compatibility state; default privacy is translated into the actual native note visibility. A channel's mandatory sensitive setting remains enforced.

REST and Streaming decorate statuses, reblogs and quotes with this metadata. A Redis lock keeps publication events behind a compatibility write without occupying the shared database connection pool while waiting. Scheduled publication copies draft metadata to the resulting status. Native scheduled drafts without metadata use their original publication parameters.

Successful compatibility edits preserve the previous language and sensitivity alongside the native revision timestamp. History responses apply those snapshots to earlier versions and the current metadata to the latest version; internal revision records are not exposed.

These language and sensitivity fields describe the local compatibility API; they do not add new native note fields or ActivityPub language/sensitivity extensions. Existing native content and remote representations are not rewritten.

## Explicit limitations

- Poll editing, hidden poll totals, custom media thumbnails, allowed-mention constraints and non-public quote approval policies remain explicitly unsupported. They return 422 before making the corresponding change.
- `notify=true` can update an accepted follow, or accompany a new ordinary follow of a local unlocked account. A pending/remote/locked follow requiring future acceptance must be accepted before post notifications can be enabled. Unsupported pending cases are rejected before following writes.
- Language filters allow statuses whose language is unknown, matching Mastodon behavior. Native and remote statuses without compatibility language metadata remain unknown.
- Metadata history is not a new native revision/federation format. This work does not claim complete support for every Mastodon extension or every fallback route in `MastodonApiContract.ts`.

## Verification

Regression coverage includes OAuth encoding and native isolation, authorization UI behavior, CORS, pagination, recursive reply traversal, relationship settings, media ownership and concurrent cancellation, failed status mutations, metadata publication ordering, scheduled metadata transfer, Streaming visibility/identity, and conditional native reaction writes.

Run focused backend tests from `packages/backend` using `pnpm exec vitest run --config vitest.config.unit.ts`, then run `pnpm exec tsc --noEmit`. API schema changes require `pnpm build-misskey-js-with-types` from the repository root. The final changed-file checks are `node scripts/check-shipping.mjs --base HEAD`.

Unit and injected HTTP tests do not constitute live federation or real-client acceptance. Those require a separately configured instance and explicit test accounts.

## References

- [Mastodon parameter formats](https://docs.joinmastodon.org/client/intro/#form-data)
- [Pagination](https://docs.joinmastodon.org/api/guidelines/#paginating-through-api-responses)
- [OAuth](https://docs.joinmastodon.org/methods/oauth/)
- [Media](https://docs.joinmastodon.org/methods/media/)
- [Statuses and context](https://docs.joinmastodon.org/methods/statuses/)
- [Account relationships](https://docs.joinmastodon.org/methods/accounts/)
