/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import type * as Misskey from 'misskey-js';
import { applyNoteCaptureDiff, noteEvents, useNoteCapture } from '@/composables/use-note-capture.js';
import { useNote } from '@/composables/use-note.js';

const mocks = vi.hoisted(() => {
	const listeners = new Map<string, Set<(data?: unknown) => void>>();
	const connection = {
		send: vi.fn(),
		on: vi.fn((event: string, listener: (data?: unknown) => void) => {
			const eventListeners = listeners.get(event) ?? new Set();
			eventListeners.add(listener);
			listeners.set(event, eventListeners);
		}),
		off: vi.fn((event: string, listener: (data?: unknown) => void) => {
			listeners.get(event)?.delete(listener);
		}),
		emit: (event: string, data?: unknown) => {
			for (const listener of listeners.get(event) ?? []) listener(data);
		},
		reset: () => {
			listeners.clear();
			connection.send.mockClear();
			connection.on.mockClear();
			connection.off.mockClear();
		},
	};

	return {
		connection,
		realtimeMode: false,
	};
});

vi.mock('@/store.js', () => ({
	store: { s: { get realtimeMode() { return mocks.realtimeMode; } } },
}));

vi.mock('@/i.js', () => ({
	$i: {
		id: 'viewer',
		policies: {
			chatAvailability: 'available',
		},
	},
	iAmModerator: false,
}));

vi.mock('@/stream.js', () => ({
	useStream: () => mocks.connection,
}));

vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: vi.fn().mockResolvedValue([]),
	misskeyApiGet: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/plugin.js', () => ({
	getPluginHandlers: () => [],
}));

const mountedApps: ReturnType<typeof createApp>[] = [];

type ChildrenChangedHandler = NonNullable<Parameters<typeof useNoteCapture>[0]['onChildrenChanged']>;

function makeNote(createdAt = new Date().toISOString()): Misskey.entities.Note {
	return {
		id: 'note-id',
		createdAt,
		reactions: {},
		reactionCount: 0,
		reactionEmojis: {},
		myReaction: null,
		poll: null,
		repliesCount: 2,
		renoteCount: 3,
	} as Misskey.entities.Note;
}

function mountCapture(options: {
	note?: Misskey.entities.Note;
	mock?: boolean;
	onChildrenChanged?: ChildrenChangedHandler;
} = {}) {
	const note = options.note ?? makeNote();
	const onChildrenChanged = options.onChildrenChanged ?? vi.fn<ChildrenChangedHandler>();
	let capture!: ReturnType<typeof useNoteCapture>;
	const app = createApp(defineComponent({
		setup() {
			capture = useNoteCapture({ note, parentNote: null, mock: options.mock ?? true, onChildrenChanged });
			return () => h('div');
		},
	}));
	app.mount(document.createElement('div'));
	mountedApps.push(app);
	return { note, capture, state: capture.$note, onChildrenChanged, app };
}

beforeEach(() => {
	mocks.realtimeMode = false;
	mocks.connection.reset();
});

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

	test('shares one stream bridge across two captures of the same note', () => {
		mocks.realtimeMode = true;
		const first = mountCapture({ mock: false });
		const second = mountCapture({ mock: false });

		expect(mocks.connection.send).toHaveBeenCalledTimes(1);
		expect(mocks.connection.send).toHaveBeenCalledWith('sr', { id: first.note.id });

		mocks.connection.emit('noteUpdated', {
			id: first.note.id,
			type: 'repliesCountChanged',
			body: { delta: 1 },
		});

		expect(first.state.repliesCount).toBe(3);
		expect(second.state.repliesCount).toBe(3);

		first.app.unmount();
		mountedApps.splice(mountedApps.indexOf(first.app), 1);
		expect(mocks.connection.send).toHaveBeenCalledTimes(1);
		second.app.unmount();
		mountedApps.splice(mountedApps.indexOf(second.app), 1);
		expect(mocks.connection.send).toHaveBeenCalledWith('un', { id: first.note.id });
		expect(mocks.connection.send).toHaveBeenCalledTimes(2);
	});

	test('manual subscription is idempotent when called repeatedly', () => {
		mocks.realtimeMode = true;
		const oldNote = makeNote(new Date(Date.now() - 1000 * 60 * 10).toISOString());
		const { capture, state } = mountCapture({ note: oldNote, mock: false });

		capture.subscribe();
		capture.subscribe();
		expect(mocks.connection.send).toHaveBeenCalledTimes(1);

		mocks.connection.emit('noteUpdated', {
			id: oldNote.id,
			type: 'renoteCountChanged',
			body: { delta: 1 },
		});

		expect(state.renoteCount).toBe(4);
	});
});

describe('useNote edit updates', () => {
	test('rerenders note content after an updated event', async () => {
		const note = {
			...makeNote(),
			text: 'before',
			cw: null,
			userId: 'author-id',
			user: {
				id: 'author-id',
				instance: null,
			},
			visibility: 'public',
			localOnly: false,
			reactionAcceptance: null,
			tags: [],
			emojis: {},
			fileIds: [],
			files: [],
			history: null,
		} as unknown as Misskey.entities.Note;
		const container = document.createElement('div');
		const app = createApp(defineComponent({
			setup() {
				const { appearNote } = useNote({ note, mock: true });
				return () => h('div', appearNote.text ?? '');
			},
		}));
		app.mount(container);
		mountedApps.push(app);

		expect(container.textContent).toBe('before');
		noteEvents.emit(`updated:${note.id}`, {
			cw: null,
			text: 'after',
			updatedAt: new Date().toISOString(),
			tags: [],
			emojis: {},
			fileIds: [],
			files: [],
		});
		await nextTick();

		expect(container.textContent).toBe('after');
	});
});
