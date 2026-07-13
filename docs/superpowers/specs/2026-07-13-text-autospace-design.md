# CSS Text Autospace Design

**Status:** Approved on 2026-07-13

## Context

The current auto-spacing preference exposes disabled, special-case, and all-text modes, but the string-rewriting implementation is not connected to the note rendering path. The implementation also uses broad regular expressions, placeholder-based hashtag handling, a nearby-text exception list, and in-place mutation of `Note` objects. These mechanisms can change MFM source text, mishandle Unicode, and add JavaScript work to timeline rendering.

Modern browsers provide the CSS `text-autospace` property for visual spacing between ideographs and non-ideographic letters or numbers. The feature should use this layout capability without changing stored, parsed, copied, translated, muted, or plugin-visible note text.

## Goals

- Delete the existing string-rewriting implementation and its exception list.
- Use `text-autospace` only for user-authored MFM content.
- Replace the three-state preference with an off/on preference.
- Preserve existing users' enabled state during the preference migration.
- Make preference changes apply immediately without reprocessing note strings.
- Keep unsupported browsers functional by degrading to no automatic spacing.

## Non-goals

- Do not insert literal spaces into note text.
- Do not provide a JavaScript text-rewriting fallback.
- Do not apply automatic spacing to navigation, settings, buttons, or other application UI copy.
- Do not retain the special-word exception behavior.

## Architecture

### Preference and migration

Replace `autoSpacingBehaviour: 'all' | 'special' | null` with `autoSpacing: boolean`, defaulting to `false`.

Before preference normalization, migrate legacy records only when the new key has no records:

- legacy `all` or `special` becomes `true`;
- legacy `null` becomes `false`;
- each record keeps its existing scope and metadata;
- if both legacy and new records exist, the new records win.

After normalization and the next profile save, only the new preference participates in active state and synchronization. The legacy key is absent from the preference definition and is ignored after migration.

The settings page replaces the three-option select with an `MkSwitch`. The description must say that the browser visually adjusts spacing; it must not claim that literal spaces are added.

### CSS state propagation

Define `--MI-textAutospace` on `:root` with the safe default `no-autospace`.

At frontend boot, an immediate watcher maps the boolean preference to the root custom property:

- enabled: `--MI-textAutospace: normal`;
- disabled: `--MI-textAutospace: no-autospace`.

A global utility class applies the property to scoped content:

```scss
._textAutoSpacing {
	text-autospace: var(--MI-textAutospace);
}
```

Changing the preference therefore causes one root style update and browser relayout. It does not traverse notes, reparse MFM, or mutate data.

### Content scope

Apply `_textAutoSpacing` to the nearest existing container around user-authored MFM in these surfaces:

- normal and detailed notes, including CW and translations;
- compact, quoted, reply, and sub-note renderers;
- collapsed note summaries;
- note previews in the post form;
- the public welcome timeline note renderer.

Quoted and reply notes inherit the behavior through their own note renderer. The class must not be placed on a page-level or application-level container, so interface copy remains unchanged.

### Removal

Delete `packages/frontend/src/utility/autospacing.ts`. No regular expressions, hashtag placeholders, exception terms, raw-text shadow properties, or Note mutation from that implementation remain.

## Browser behavior

Supported browsers render the standard inter-script spacing without altering DOM text. Unsupported browsers ignore `text-autospace`; because no JavaScript fallback is provided, content remains unchanged and readable.

Explicit `no-autospace` is required for the disabled state because the CSS specification defines `normal` as the initial value even though browser defaults have varied during rollout.

## Testing

Automated tests must cover:

1. Legacy preference migration for `all`, `special`, and `null`.
2. New preference records taking precedence over legacy records.
3. Preservation of preference scope and metadata during migration.
4. Mapping enabled and disabled states to `normal` and `no-autospace` on a real DOM element.
5. Representative note content receiving the scoped utility class while unrelated UI content does not.

The implementation follows red-green-refactor: each new migration or CSS-state helper is introduced by a failing test, then minimally implemented.

Final validation includes the focused frontend tests, frontend type checking/linting, repository lint where practical, locale safety, SPDX checks for new source files, and a clean diff check.

## User-facing documentation

Update only `locales/ja-JP.yml` for the revised setting description. Add a Client entry under `CHANGELOG.md` Unreleased explaining that auto spacing now uses the browser's native text layout and no longer modifies note text.
