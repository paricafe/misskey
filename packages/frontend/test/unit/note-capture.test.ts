/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import type * as Misskey from 'misskey-js';
import { applyNoteCaptureDiff, noteEvents, useNoteCapture } from '@/composables/use-note-capture.js';

vi.mock('@/store.js', () => ({
	store: { s: { realtimeMode: false } },
}));

const mountedApps: ReturnType<typeof createApp>[] = [];

function makeNote(): Misskey.entities.Note {
	return {
		id: 'note-id',
		createdAt: new Date().toISOString(),
		reactions: {},
		reactionCount: 0,
		reactionEmojis: {},
		myReaction: null,
		poll: null,
		repliesCount: 2,
		renoteCount: 3,
	} as Misskey.entities.Note;
}

function mountCapture(onChildrenChanged = vi.fn()) {
	const note = makeNote();
	let state!: ReturnType<typeof useNoteCapture>['$note'];
	const app = createApp(defineComponent({
		setup() {
			state = useNoteCapture({ note, parentNote: null, mock: true, onChildrenChanged }).$note;
			return () => h('div');
		},
	}));
	app.mount(document.createElement('div'));
	mountedApps.push(app);
	return { note, state, onChildrenChanged };
}

afterEach(() => {
	for (const app of mountedApps.splice(0)) app.unmount();
});

describe('useNoteCapture counts', () => {
	test('initializes and applies bidirectional count events with a zero floor', () => {
		const { note, state } = mountCapture();
		const emit = noteEvents.emit.bind(noteEvents) as (event: string, body: unknown) => boolean;

		expect(state.repliesCount).toBe(2);
		expect(state.renoteCount).toBe(3);
		emit(`repliesCountChanged:${note.id}`, { delta: 1 });
		emit(`renoteCountChanged:${note.id}`, { delta: -1 });
		expect(state.repliesCount).toBe(3);
		expect(state.renoteCount).toBe(2);
		emit(`renoteCountChanged:${note.id}`, { delta: -1 });
		emit(`renoteCountChanged:${note.id}`, { delta: -1 });
		emit(`renoteCountChanged:${note.id}`, { delta: -1 });
		expect(state.renoteCount).toBe(0);
	});

	test('applies authoritative polling counts', () => {
		const { state } = mountCapture();
		applyNoteCaptureDiff(state, {
			reactions: { ':test:': 1 },
			reactionEmojis: {},
			repliesCount: 8,
			renoteCount: 13,
		});
		expect(state.repliesCount).toBe(8);
		expect(state.renoteCount).toBe(13);
	});

	test('forwards child-list invalidations', () => {
		const { note, onChildrenChanged } = mountCapture();
		const emit = noteEvents.emit.bind(noteEvents) as (event: string, body: unknown) => boolean;
		emit(`childrenChanged:${note.id}`, { action: 'removed', childId: 'child-id' });
		expect(onChildrenChanged).toHaveBeenCalledWith({ action: 'removed', childId: 'child-id' });
	});
});
