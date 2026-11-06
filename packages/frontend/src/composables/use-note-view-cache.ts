/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onUnmounted, watch } from 'vue';
import type { Ref } from 'vue';
import type * as Misskey from 'misskey-js';
import type { NoteViewState } from '@/composables/use-note.js';

/** Note data and capture subscriptions live as long as the paginator data, not its rendered rows. */
export function useNoteViewStateCache(notes: Readonly<Ref<Misskey.entities.Note[]>>): Map<Misskey.entities.Note, NoteViewState> {
	const cache = new Map<Misskey.entities.Note, NoteViewState>();
	watch(() => [...notes.value], items => {
		const retained = new Set(items);
		for (const [note, state] of cache) {
			if (retained.has(note)) continue;
			state.capture.dispose();
			cache.delete(note);
		}
	}, { flush: 'post' });
	onUnmounted(() => {
		for (const state of cache.values()) state.capture.dispose();
		cache.clear();
	});
	return cache;
}
