# MkNote Media Click Isolation Design

**Status:** Approved for implementation planning

**Date:** 2026-07-15

## Context

When `noteClickToOpen` is enabled, `MkNote.vue` handles clicks on the note content container by navigating to the note detail page. `MkMediaList` is rendered inside that container. A click used to open an image or video viewer therefore continues bubbling to the note container and also triggers detail navigation.

`MkSubNoteContent.vue` already prevents the same interaction by attaching `@click.stop` to its `MkMediaList` instance.

## Goal

Clicking media in `MkNote` must perform only the media action, such as opening the lightbox or a new browser tab, without navigating to the note detail page. Clicking non-interactive note content must continue to open the detail page when `noteClickToOpen` is enabled.

## Non-goals

- Changing media behavior outside `MkNote`.
- Changing `noteClickToOpen` behavior for non-media content.
- Refactoring `MkMediaList` or the note click handler.

## Considered Approaches

### Stop clicks at the `MkNote` media-list instance

Add `@click.stop` to the `MkMediaList` rendered by `MkNote`. This is the selected approach because it is the narrowest change and matches the established `MkSubNoteContent` pattern.

### Stop clicks inside `MkMediaList`

Stopping propagation on the component root would protect every caller, but it would also change event behavior in unrelated contexts such as chat, drive, pages, and detailed notes.

### Filter media targets in `noteClickToOpen`

Inspecting the event target would couple the note navigation logic to media DOM structure and require selectors or marker attributes that could become stale.

## Implementation

Update the `MkMediaList` call site in `packages/frontend/src/components/MkNote.vue` with Vue's `@click.stop` event modifier. No changes are required in `MkMediaList`, `MkMediaImage`, `MkMediaVideo`, routing, preferences, or locales.

## Test Strategy

Add a focused frontend regression test covering the event boundary:

- With `noteClickToOpen` enabled, clicking the media-list root does not call the router.
- Clicking ordinary note content still navigates to `/notes/<note-id>`.

Run the focused frontend test, frontend lint/typecheck, and the final Misskey shipping checks. Because the behavior is user-visible, add a Client fix entry under `CHANGELOG.md` Unreleased during implementation.
