/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import type * as Misskey from 'misskey-js';
import { pluginsReady } from '@/plugin.js';
import MkNote from '@/components/MkNote.vue';
import MkNoteDetailed from '@/components/MkNoteDetailed.vue';

vi.mock('@/plugin.js', async () => {
	const { ref } = await import('vue');
	return { pluginsReady: ref(false) };
});
vi.mock('@/components/global/MkLoading.vue', () => ({ default: { template: '<div data-testid="loading" />' } }));
vi.mock('@/components/MkNote.body.vue', () => ({ __esModule: true, default: { props: ['note'], template: '<button data-testid="note-body" @click="$emit(\'reaction\', \'heart\')">{{ note.id }}</button>' } }));
vi.mock('@/components/MkNoteDetailed.body.vue', () => ({ __esModule: true, default: { props: ['note'], template: '<div data-testid="detailed-body">{{ note.id }}</div>' } }));

afterEach(cleanup);

test('waits for plugin startup before rendering note bodies and forwards interactions', async () => {
	const note = { id: 'example' } as Misskey.entities.Note;
	const normal = render(MkNote, { props: { note } });
	const detailed = render(MkNoteDetailed, { props: { note } });
	expect(normal.container.querySelector('[data-testid="loading"]')).toBeTruthy();
	expect(detailed.container.querySelector('[data-testid="loading"]')).toBeTruthy();
	expect(normal.queryByTestId('note-body')).toBeNull();
	expect(detailed.queryByTestId('detailed-body')).toBeNull();
	pluginsReady.value = true;
	await waitFor(() => expect(normal.getByTestId('note-body').textContent).toBe('example'));
	await waitFor(() => expect(detailed.getByTestId('detailed-body').textContent).toBe('example'));
	await fireEvent.click(normal.getByTestId('note-body'));
	expect(normal.emitted('reaction')).toEqual([['heart']]);
});
