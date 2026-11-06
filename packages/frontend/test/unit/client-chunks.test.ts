/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { ChunkingContext } from 'rolldown';
import { createClientChunkGroup } from '../../lib/client-chunks.js';

const root = '/test/frontend';
const id = (file: string) => path.resolve(root, file);

type Module = { importedIds: string[]; dynamicallyImportedIds?: string[] };

function graph(modules: Record<string, Module>) {
	const getModuleInfo = vi.fn((moduleId: string) => modules[moduleId] ?? null);

	return { context: { getModuleInfo } as unknown as ChunkingContext, getModuleInfo };
}

function classifier() {
	const group = createClientChunkGroup(root);
	return group.name as (moduleId: string, context: ChunkingContext) => string | undefined;
}

describe('client chunk groups', () => {
	test('keeps welcome reading dependencies separate from the posting editor', () => {
		const visitor = id('src/ui/visitor.vue');
		const welcomeNote = id('src/pages/welcome.timeline.note.vue');
		const note = id('src/components/MkNote.vue');
		const noteBody = id('src/components/MkNote.body.vue');
		const timeline = id('src/pages/timeline.vue');
		const streaming = id('src/components/MkStreamingNotesTimeline.vue');
		const reactions = id('src/components/MkReactionsViewer.vue');
		const cw = id('src/components/MkCwButton.vue');
		const dialog = id('src/components/MkPostFormDialog.vue');
		const form = id('src/components/MkPostForm.vue');
		const preview = id('src/components/MkNotePreview.vue');
		const editor = id('src/components/MkPollEditor.vue');
		const shared = id('node_modules/vue/index.js');
		const { context } = graph({
			[visitor]: { importedIds: [shared] },
			[welcomeNote]: { importedIds: [reactions, cw, shared] },
			[note]: { importedIds: [noteBody, shared] },
			[noteBody]: { importedIds: [reactions, cw] },
			[timeline]: { importedIds: [streaming] },
			[streaming]: { importedIds: [note] },
			[dialog]: { importedIds: [form, shared] },
			[form]: { importedIds: [preview, editor] },
			[preview]: { importedIds: [cw] },
		});
		const name = classifier();
		expect(name(shared, context)).toBe('client-core');
		for (const item of [note, noteBody, streaming, reactions, cw]) expect(name(item, context)).toBe('client-reading');
		for (const item of [timeline, dialog, form, preview, editor]) expect(name(item, context)).toBe('client-interactions');
		expect(name(welcomeNote, context)).toBeUndefined();
	});

	test('gives core priority for shared dependencies and keeps interaction-only code separate', () => {
		const main = id('src/boot/main-boot.ts');
		const timeline = id('src/pages/timeline.vue');
		const post = id('src/components/MkPostFormDialog.vue');
		const emoji = id('src/components/MkEmojiPickerDialog.vue');
		const shared = id('src/shared.ts');
		const timelineOnly = id('src/timeline-only.ts');
		const postOnly = id('src/post-only.ts');
		const emojiOnly = id('src/emoji-only.ts');
		const dynamic = id('src/later.ts');
		const { context } = graph({
			[main]: { importedIds: [shared], dynamicallyImportedIds: [dynamic] },
			[timeline]: { importedIds: [shared, timelineOnly], dynamicallyImportedIds: [dynamic] },
			[post]: { importedIds: [postOnly] },
			[emoji]: { importedIds: [emojiOnly] },
		});
		const name = classifier();
		expect(name(shared, context)).toBe('client-core');
		for (const item of [timeline, timelineOnly, post, postOnly, emoji, emojiOnly]) expect(name(item, context)).toBe('client-interactions');
		expect(name(dynamic, context)).toBeUndefined();
		expect(name(id('src/unrelated.ts'), context)).toBeUndefined();
	});

	test('handles cyclic dependencies and reuses the collected graph', () => {
		const main = id('src/boot/main-boot.ts');
		const a = id('src/a.ts');
		const b = id('src/b.ts');
		const { context, getModuleInfo } = graph({
			[main]: { importedIds: [a] },
			[a]: { importedIds: [b] },
			[b]: { importedIds: [a] },
		});
		const name = classifier();
		expect(name(b, context)).toBe('client-core');
		expect(getModuleInfo.mock.calls.filter(([item]) => item === a)).toHaveLength(1);
		expect(getModuleInfo.mock.calls.filter(([item]) => item === b)).toHaveLength(1);
		const calls = getModuleInfo.mock.calls.length;
		expect(name(a, context)).toBe('client-core');
		expect(getModuleInfo).toHaveBeenCalledTimes(calls);
	});

	test('separate factories collect their own build graph', () => {
		const main = id('src/boot/main-boot.ts');
		const onlyFirst = id('src/first.ts');
		const onlySecond = id('src/second.ts');
		const first = graph({ [main]: { importedIds: [onlyFirst] } });
		const second = graph({ [main]: { importedIds: [onlySecond] } });
		const firstName = classifier();
		const secondName = classifier();
		expect(firstName(onlyFirst, first.context)).toBe('client-core');
		expect(firstName(onlySecond, first.context)).toBeUndefined();
		expect(secondName(onlyFirst, second.context)).toBeUndefined();
		expect(secondName(onlySecond, second.context)).toBe('client-core');
	});
});
