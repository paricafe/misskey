/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import type * as Misskey from 'misskey-js';
import MkPostForm from '@/components/MkPostForm.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';

const { me } = vi.hoisted(() => ({ me: { id: 'author', username: 'author', host: null, avatarUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', policies: { scheduledNoteLimit: 10 }, isSilenced: false } }));
vi.mock('@/i.js', () => ({ $i: me, ensureSignin: () => me, notesCount: 2, incNotesCount: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/os.js', () => ({ popup: vi.fn(), popupMenu: vi.fn(), confirm: vi.fn() }));
vi.mock('@/accounts.js', () => ({ getAccounts: vi.fn(), getAccountMenu: vi.fn() }));
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class { detach() {} } }));
vi.mock('@/utility/drive.js', () => ({ chooseDriveFile: vi.fn() }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: {} }));
vi.mock('@/utility/mfm-function-picker.js', () => ({ mfmFunctionPicker: {} }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: () => [] }));
vi.mock('@/events.js', () => ({ globalEvents: { emit: vi.fn() } }));
vi.mock('@/composables/use-note-capture.js', () => ({ noteEvents: { emit: vi.fn() } }));
vi.mock('@/instance.js', () => ({ instance: { maxNoteTextLength: 3000 } }));
vi.mock('@/store.js', async () => {
	const { ref } = await import('vue');
	return { store: { s: { showPreview: false }, r: { tips: ref({ postForm: true }) }, model: () => ref(''), set: vi.fn() } };
});
vi.mock('@/composables/use-uploader.js', async () => {
	const { ref } = await import('vue');
	return { useUploader: () => ({ items: ref([]), uploading: ref(false), readyForUpload: ref(true), allItemsUploaded: ref(true), events: { on: vi.fn() }, dispose: vi.fn(), abortAll: vi.fn(), reset: vi.fn() }) };
});
vi.mock('@/components/MkNotePreview.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MkNoteSimple.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MkPollEditor.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MkUploaderItems.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/components/MkPostFormAttaches.vue', () => ({ default: { props: ['modelValue'], template: '<button v-if="modelValue.length" data-testid="remove-file" @click="$emit(\'detach\', modelValue[0].id)">Remove</button>' } }));

function note(extra: Partial<Misskey.entities.Note> = {}): Misskey.entities.Note {
	return { id: 'note', userId: me.id, user: me, text: 'Original text', cw: null, visibility: 'public', localOnly: false, files: [], ...extra } as Misskey.entities.Note;
}

async function form(initialNote: Misskey.entities.Note, updateMode = true) {
	const result = render(MkPostForm, {
		props: { initialNote, updateMode, autofocus: false },
		global: {
			stubs: {
				MkAcct: true,
			},
			directives: { clickAnime: {}, tooltip: {} },
		},
	});
	await waitFor(() => expect(result.getByTestId<HTMLTextAreaElement>('post-form-text').value).toBe(initialNote.text ?? ''));
	return result;
}

describe('post form editing', () => {
	beforeEach(() => {
		vi.mocked(misskeyApi).mockReset();
		vi.mocked(misskeyApi).mockImplementation((endpoint) => Promise.resolve(endpoint === 'users/show'
			? [{ id: 'recipient', username: 'recipient', host: null }]
			: { updatedNote: note() }) as never);
	});
	afterEach(cleanup);

	test('locks visibility and federation in edit mode while creation keeps them available', async () => {
		const edited = await form(note());
		for (const icon of ['ti-world', 'ti-rocket']) expect(edited.container.querySelector(`.${icon}`)?.closest('button')?.disabled).toBe(true);
		edited.unmount();
		const created = await form(note(), false);
		for (const icon of ['ti-world', 'ti-rocket']) expect(created.container.querySelector(`.${icon}`)?.closest('button')?.disabled).toBe(false);
	});

	test('locks the recipient controls of a direct note', async () => {
		const result = await form(note({ visibility: 'specified', visibleUserIds: ['recipient'] }));
		await waitFor(() => expect(result.container.querySelector('.ti-plus')?.closest('button')?.disabled).toBe(true));
		const remove = result.container.querySelector('.ti-x')?.closest('button');
		const buttons = Array.from(result.container.querySelectorAll('button')).filter(button => button.querySelector('.ti-x') && button !== remove);
		expect(buttons.some(button => button.disabled)).toBe(true);
	});

	test('submits an explicit empty attachment list and only editable properties', async () => {
		const result = await form(note({ files: [{ id: 'file' } as Misskey.entities.DriveFile] }));
		await fireEvent.click(result.getByTestId('remove-file'));
		await fireEvent.update(result.getByTestId('post-form-text'), 'Edited text');
		await fireEvent.click(result.getByTestId('post-form-submit'));
		await waitFor(() => expect(misskeyApi).toHaveBeenCalledWith('notes/update', { noteId: 'note', text: 'Edited text', cw: null, fileIds: [] }, undefined));
	});

	test('submits a CW edit for a poll-only note', async () => {
		const result = await form(note({ text: null, cw: 'Old warning', poll: { choices: [{ text: 'A', votes: 0, isVoted: false }, { text: 'B', votes: 0, isVoted: false }], multiple: false, expiresAt: null } }));
		await fireEvent.update(result.getByPlaceholderText(i18n.ts.annotation), 'New warning');
		await fireEvent.click(result.getByTestId('post-form-submit'));
		await waitFor(() => expect(misskeyApi).toHaveBeenCalledWith('notes/update', { noteId: 'note', text: null, cw: 'New warning', fileIds: [] }, undefined));
	});
});
