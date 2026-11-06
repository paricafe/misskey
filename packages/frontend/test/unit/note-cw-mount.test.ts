/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/vue';
import type * as Misskey from 'misskey-js';
import MkNoteSimple from '@/components/MkNoteSimple.vue';

vi.mock('@/components/MkNoteHeader.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MkSubNoteContent.vue', () => ({ default: { template: '<div data-testid="body">body</div>' } }));
vi.mock('@/components/MkCwButton.vue', () => ({ default: { props: ['modelValue'], template: '<button data-testid="toggle" @click="$emit(\'update:modelValue\', !modelValue)">toggle</button>' } }));

afterEach(cleanup);

const note = { id: 'note', user: { id: 'author' }, text: 'body', cw: 'warning', files: [] } as unknown as Misskey.entities.Note;
const options = { global: { stubs: { MkAvatar: true, Mfm: true } } };

describe('note content warning', () => {
	test('mounts the body only while the warning is expanded', async () => {
		const result = render(MkNoteSimple, { ...options, props: { note } });
		expect(result.queryByTestId('body')).toBeNull();
		await fireEvent.click(result.getByTestId('toggle'));
		expect(result.getByTestId('body')).toBeTruthy();
		await fireEvent.click(result.getByTestId('toggle'));
		expect(result.queryByTestId('body')).toBeNull();
	});

	test('mounts an unguarded body immediately', () => {
		const result = render(MkNoteSimple, { ...options, props: { note: { ...note, cw: null } } });
		expect(result.getByTestId('body')).toBeTruthy();
	});
});
