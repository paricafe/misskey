# CSS Text Autospace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disconnected JavaScript auto-spacing implementation with scoped CSS `text-autospace` controlled by a migrated boolean preference.

**Architecture:** Preference normalization converts legacy three-state records to a boolean record without losing scope metadata. An immediate boot watcher maps the boolean to a root CSS custom property, while an `_textAutoSpacing` utility class is applied only to user-authored note MFM. The browser performs visual spacing without changing note strings.

**Tech Stack:** Vue 3, TypeScript, Vitest with happy-dom, Sass, Misskey preference manager.

## Global Constraints

- Do not edit locale YAML files other than `locales/ja-JP.yml`.
- Do not retain a JavaScript string-rewriting fallback or the special-word exception list.
- Unsupported browsers must degrade to unchanged readable text.
- New `.ts` files under `packages/frontend/` require the AGPL SPDX header.
- The disabled CSS value is explicitly `no-autospace`; the enabled value is `normal`.

---

### Task 1: Migrate the preference to a boolean

**Files:**
- Create: `packages/frontend/test/unit/preferences-manager.test.ts`
- Modify: `packages/frontend/src/preferences/manager.ts`
- Modify: `packages/frontend/src/preferences/def.ts`

**Interfaces:**
- Consumes: legacy `autoSpacingBehaviour` records shaped as `[scope, 'all' | 'special' | null, meta]`.
- Produces: `migrateLegacyAutoSpacingPreference(preferences)` and the `autoSpacing: boolean` preference.

- [ ] **Step 1: Write the failing migration tests**

```ts
import { assert, describe, test } from 'vitest';
import { migrateLegacyAutoSpacingPreference } from '@/preferences/manager.js';

describe('migrateLegacyAutoSpacingPreference', () => {
	test.each([
		['all', true],
		['special', true],
		[null, false],
	] as const)('migrates %s to %s', (legacy, expected) => {
		const scope = { server: 'example.com', account: 'user' };
		const meta = { sync: false };
		const migrated = migrateLegacyAutoSpacingPreference({
			autoSpacingBehaviour: [[scope, legacy, meta]],
		});
		assert.deepStrictEqual(migrated.autoSpacing, [[scope, expected, meta]]);
	});

	test('keeps existing new records instead of legacy records', () => {
		const current = [[{}, false, { sync: true }]] as [Record<string, never>, boolean, { sync: boolean }][];
		const migrated = migrateLegacyAutoSpacingPreference({
			autoSpacing: current,
			autoSpacingBehaviour: [[{}, 'all', {}]],
		});
		assert.strictEqual(migrated.autoSpacing, current);
	});
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter frontend test -- preferences-manager.test.ts`

Expected: FAIL because `migrateLegacyAutoSpacingPreference` is not exported.

- [ ] **Step 3: Implement migration before normalization**

```ts
export function migrateLegacyAutoSpacingPreference(
	preferences: PossiblyNonNormalizedPreferencesProfile['preferences'],
): PossiblyNonNormalizedPreferencesProfile['preferences'] {
	const currentRecords = preferences.autoSpacing;
	const legacyRecords = preferences.autoSpacingBehaviour;
	if ((currentRecords != null && currentRecords.length > 0) || legacyRecords == null || legacyRecords.length === 0) return preferences;

	return {
		...preferences,
		autoSpacing: legacyRecords.map(([scope, value, meta]) => [
			scope,
			value === 'all' || value === 'special',
			meta,
		]),
	};
}
```

Call this function at the start of `normalizePreferences`, then replace the definition with:

```ts
	autoSpacing: {
		default: false,
	},
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter frontend test -- preferences-manager.test.ts`

Expected: PASS for all migration cases.

### Task 2: Map the preference to CSS state

**Files:**
- Create: `packages/frontend/test/unit/text-autospace.test.ts`
- Create: `packages/frontend/src/utility/text-autospace.ts`
- Modify: `packages/frontend/src/boot/common.ts`
- Modify: `packages/frontend/src/style.scss`

**Interfaces:**
- Produces: `applyTextAutospacePreference(enabled: boolean, root?: HTMLElement): void`.
- Produces: `--MI-textAutospace` and global utility class `_textAutoSpacing`.

- [ ] **Step 1: Write the failing DOM-state test**

```ts
import { afterEach, assert, describe, test } from 'vitest';
import { applyTextAutospacePreference } from '@/utility/text-autospace.js';

describe('applyTextAutospacePreference', () => {
	afterEach(() => document.documentElement.style.removeProperty('--MI-textAutospace'));

	test.each([[true, 'normal'], [false, 'no-autospace']] as const)('maps %s to %s', (enabled, expected) => {
		applyTextAutospacePreference(enabled);
		assert.strictEqual(document.documentElement.style.getPropertyValue('--MI-textAutospace'), expected);
	});
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter frontend test -- text-autospace.test.ts`

Expected: FAIL because the utility module does not exist.

- [ ] **Step 3: Implement the minimal helper and integration**

```ts
export function applyTextAutospacePreference(enabled: boolean, root: HTMLElement = window.document.documentElement): void {
	root.style.setProperty('--MI-textAutospace', enabled ? 'normal' : 'no-autospace');
}
```

In `boot/common.ts`, add an immediate watcher of `prefer.r.autoSpacing` that calls the helper. In `style.scss`, add the root default and scoped utility:

```scss
:root {
	--MI-textAutospace: no-autospace;
}

._textAutoSpacing {
	text-autospace: var(--MI-textAutospace);
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm --filter frontend test -- text-autospace.test.ts`

Expected: PASS for enabled and disabled values.

### Task 3: Scope browser spacing to note MFM

**Files:**
- Create: `packages/frontend/test/unit/note-auto-spacing.test.ts`
- Modify: `packages/frontend/src/components/MkNote.vue`
- Modify: `packages/frontend/src/components/MkNoteDetailed.vue`
- Modify: `packages/frontend/src/components/MkNoteSub.vue`
- Modify: `packages/frontend/src/components/MkNoteSimple.vue`
- Modify: `packages/frontend/src/components/MkNotePreview.vue`
- Modify: `packages/frontend/src/components/MkSubNoteContent.vue`
- Modify: `packages/frontend/src/pages/welcome.timeline.note.vue`

**Interfaces:**
- Consumes: global `_textAutoSpacing` utility class.
- Produces: scoped note MFM elements for CW, body text, translations, summaries, previews, quotes, replies, and the welcome timeline.

- [ ] **Step 1: Write a failing representative render test**

```ts
import { afterEach, assert, describe, test } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import { defineComponent } from 'vue';
import * as Misskey from 'misskey-js';
import MkNotePreview from '@/components/MkNotePreview.vue';

const MfmStub = defineComponent({
	props: { text: { type: String, required: true } },
	template: '<span data-testid="mfm">{{ text }}</span>',
});

const UserNameStub = defineComponent({
	template: '<span data-testid="user-name">Alice</span>',
});

describe('note auto spacing scope', () => {
	afterEach(cleanup);

	test('applies auto spacing to note MFM but not header UI', () => {
		const result = render(MkNotePreview, {
			props: {
				text: '日本語English',
				files: [],
				useCw: true,
				cw: '警告Warning',
				user: {
					id: 'user',
					username: 'alice',
					name: 'Alice',
					host: null,
				} as Misskey.entities.User,
			},
			global: {
				stubs: {
					Mfm: MfmStub,
					MkAvatar: true,
					MkUserName: UserNameStub,
					MkCwButton: true,
				},
			},
		});

		const mfmElements = result.getAllByTestId('mfm');
		assert.strictEqual(mfmElements.length, 2);
		assert.ok(mfmElements.every(element => element.classList.contains('_textAutoSpacing')));
		assert.strictEqual(result.getByTestId('user-name').closest('._textAutoSpacing'), null);
	});
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm --filter frontend test -- note-auto-spacing.test.ts`

Expected: FAIL because note MFM does not yet receive `_textAutoSpacing`.

- [ ] **Step 3: Add the scoped utility class**

Add `class="_textAutoSpacing"` to each user-authored `Mfm` invocation in the listed files. Where a class already exists, combine them, for example:

```vue
<Mfm class="_selectable _textAutoSpacing" ... />
```

For CSS-module bindings, retain the module class while adding the global class:

```vue
:class="[$style.collapsedInReplyToText, '_textAutoSpacing']"
```

Do not add the class to note headers, buttons, navigation, or settings copy.

- [ ] **Step 4: Run the focused render test and verify GREEN**

Run: `pnpm --filter frontend test -- note-auto-spacing.test.ts`

Expected: PASS, with note MFM scoped and unrelated UI outside the class.

### Task 4: Replace the setting and remove the legacy implementation

**Files:**
- Delete: `packages/frontend/src/utility/autospacing.ts`
- Modify: `packages/frontend/src/pages/settings/pari.vue`
- Modify: `locales/ja-JP.yml`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: boolean `prefer.model('autoSpacing')`.
- Removes: `autoSpacingBehaviour`, `autoSpacing()`, `spacingNote()`, hashtag placeholders, exception terms, and note mutation.

- [ ] **Step 1: Replace the three-option select with a switch**

```vue
<MkPreferenceContainer k="autoSpacing">
	<MkSwitch v-model="autoSpacing">
		<template #label>{{ i18n.ts.autoSpacing }}</template>
		<template #caption>{{ i18n.ts.autoSpacingDescription }}</template>
	</MkSwitch>
</MkPreferenceContainer>
```

Replace the model declaration with `const autoSpacing = prefer.model('autoSpacing');`.

- [ ] **Step 2: Delete the string-rewriting module and update copy**

Delete `packages/frontend/src/utility/autospacing.ts`. Change only `locales/ja-JP.yml` so the description says the browser visually adjusts CJK/Latin spacing, and add an Unreleased Client changelog entry explaining the native CSS behavior.

- [ ] **Step 3: Verify the legacy implementation is gone**

Run: `rg -n 'spacingNote|__autospacing|NO_SPACEING_LIST|utility/autospacing' packages/frontend/src packages/frontend/test`

Expected: no matches. `autoSpacingBehaviour` remains only in the migration helper and its tests because it is the persisted legacy key being migrated.

- [ ] **Step 4: Run frontend validation**

Run:

```text
pnpm --filter frontend test -- preferences-manager.test.ts text-autospace.test.ts note-auto-spacing.test.ts
pnpm --filter frontend lint
pnpm lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Run repository safety checks**

Run:

```text
git diff --check
git diff --name-only develop -- 'locales/*.yml'
git status --short
```

Expected: no whitespace errors; no changed locale except `locales/ja-JP.yml`; only intended source, test, plan, locale, and changelog files are modified.
