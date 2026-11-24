/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onUnmounted, watch } from 'vue';
import type { Ref } from 'vue';
import type * as Misskey from 'misskey-js';
import type { NoteViewState } from '@/composables/use-note.js';

export function useNoteViewStateCache(notes: Readonly<Ref<Misskey.entities.Note[]>>): Map<string, NoteViewState> {
	const cache = new Map<string, NoteViewState>();
	watch(() => notes.value.map(note => note.id), ids => {
		const retained = new Set(ids);
		for (const [id, state] of cache) {
			if (retained.has(id)) continue;
			state.capture.dispose();
			cache.delete(id);
		}
	}, { flush: 'post' });
	onUnmounted(() => {
		for (const state of cache.values()) state.capture.dispose();
		cache.clear();
	});
	return cache;
}
