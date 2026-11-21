/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import { nextTick } from 'vue';
import type * as Misskey from 'misskey-js';
import { host } from '@@/js/config.js';
import MkPostForm from '@/components/MkPostForm.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { getAccounts, getAccountMenu } from '@/accounts.js';
import { emojiPicker } from '@/utility/emoji-picker.js';
import { chooseDriveFile } from '@/utility/drive.js';
import * as os from '@/os.js';
import type { PostFormProps } from '@/types/post-form.js';
import type { MenuButton } from '@/types/menu.js';

const { me } = vi.hoisted(() => ({ me: { id: 'author', username: 'author', host: null, avatarUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', policies: { scheduledNoteLimit: 10, noteDraftLimit: 11 }, isSilenced: false } }));
const pluginHandler = vi.hoisted(() => vi.fn<(form: unknown, update: (key: string, value: string) => void) => void>());
const uploaderState = vi.hoisted(() => ({ allItemsUploaded: true, addFiles: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: me, ensureSignin: () => me, notesCount: 2, incNotesCount: vi.fn() }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/os.js', () => ({ popup: vi.fn(() => ({ dispose: vi.fn() })), popupMenu: vi.fn(), confirm: vi.fn(), alert: vi.fn(), apiWithDialog: vi.fn(), inputDatetime: vi.fn(), selectUser: vi.fn(), chooseFileFromPc: vi.fn() }));
vi.mock('@/accounts.js', () => ({ getAccounts: vi.fn(), getAccountMenu: vi.fn() }));
vi.mock('@/utility/autocomplete.js', () => ({ Autocomplete: class { close() {} detach() {} } }));
vi.mock('@/utility/drive.js', () => ({ chooseDriveFile: vi.fn() }));
vi.mock('@/utility/achievements.js', () => ({ claimAchievement: vi.fn() }));
vi.mock('@/utility/emoji-picker.js', () => ({ emojiPicker: { show: vi.fn() } }));
vi.mock('@/utility/mfm-function-picker.js', () => ({ mfmFunctionPicker: {} }));
vi.mock('@/plugin.js', () => ({ getPluginHandlers: (type: string) => type === 'post_form_action' ? [{ title: 'Edit draft', handler: pluginHandler }] : [] }));
vi.mock('@/events.js', () => ({ globalEvents: { emit: vi.fn() } }));
vi.mock('@/composables/use-note-capture.js', () => ({ noteEvents: { emit: vi.fn() } }));
vi.mock('@/instance.js', () => ({ instance: { maxNoteTextLength: 3000 } }));
vi.mock('@/store.js', async () => {
	const { ref } = await import('vue');
	return { store: { s: { showPreview: false }, r: { tips: ref({ postForm: true }) }, model: () => ref(''), set: vi.fn() } };
});
vi.mock('@/composables/use-uploader.js', async () => {
	const { ref } = await import('vue');
	return { useUploader: () => ({ items: ref([]), uploading: ref(false), readyForUpload: ref(true), allItemsUploaded: { get value() { return uploaderState.allItemsUploaded; } }, events: { on: vi.fn() }, addFiles: uploaderState.addFiles, dispose: vi.fn(), abortAll: vi.fn(), reset: vi.fn() }) };
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
		await waitFor(() => {
			const buttons = Array.from(result.container.querySelectorAll('button')).filter(button => button.querySelector('.ti-x') && button !== remove);
			expect(buttons.some(button => button.disabled)).toBe(true);
		});
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

describe('post form local drafts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getAccounts).mockResolvedValue([{ host, id: 'bob', username: 'bob', token: 'bob-token' }]);
	});
	afterEach(() => {
		cleanup();
		localStorage.clear();
		me.id = 'author';
		uploaderState.allItemsUploaded = true;
	});

	async function openDraft(account: string, target?: 'reply' | 'renote', props?: PostFormProps) {
		me.id = account;
		const result = render(MkPostForm, {
			props: { ...(target ? { [target]: note() } : {}), autofocus: false, freezeAfterPosted: true, ...props },
			global: { stubs: { MkAcct: true }, directives: { clickAnime: {}, tooltip: {} } },
		});
		await nextTick();
		await nextTick();
		return { ...result, text: result.getByTestId<HTMLTextAreaElement>('post-form-text') };
	}

	async function choose(result: Awaited<ReturnType<typeof openDraft>>, id: string) {
		vi.mocked(getAccountMenu).mockResolvedValue([]);
		await fireEvent.click(result.getByRole('button', { name: i18n.ts.account }));
		const menu = vi.mocked(getAccountMenu).mock.lastCall![0];
		await menu.onChoose!({ ...me, id, username: id } as Misskey.entities.MeDetailed);
		await nextTick();
	}

	async function menuAction(draft: Awaited<ReturnType<typeof openDraft>>, button: string, label: string) {
		await fireEvent.click(draft.container.querySelector(button)!.closest('button')!);
		const items = vi.mocked(os.popupMenu).mock.lastCall![0];
		const item = items.find((entry): entry is MenuButton => !!entry && typeof entry === 'object' && 'text' in entry && entry.text === label && 'action' in entry)!;
		await item.action(new PointerEvent('click'));
		await nextTick();
	}

	test.each([
		{ instant: true, initialText: 'shared content' },
		{ mention: note().user },
		{ specified: note().user, initialText: 'direct message' },
	])('preserves edits when switching authors in a temporary composer %#', async props => {
		const draft = await openDraft('author', undefined, props);
		await fireEvent.update(draft.text, 'Original private text');
		await choose(draft, 'bob');
		expect(draft.text.value).not.toContain('Original private text');
		await fireEvent.update(draft.text, 'Bob text');
		await choose(draft, 'author');
		expect(draft.text.value).toBe('Original private text');
		await choose(draft, 'bob');
		expect(draft.text.value).toBe('Bob text');
		expect(localStorage.getItem('drafts')).toBeNull();
	});

	test('creates, updates and schedules a cloud draft with the selected credentials', async () => {
		const draft = await openDraft('author');
		await choose(draft, 'bob');
		await fireEvent.update(draft.text, 'Bob draft');
		vi.mocked(os.apiWithDialog).mockResolvedValueOnce({ createdDraft: { id: 'draft-b' } } as never);
		await menuAction(draft, '.ti-dots', i18n.ts._drafts.saveToDraft);
		expect(os.apiWithDialog).toHaveBeenCalledWith('notes/drafts/create', expect.objectContaining({ text: 'Bob draft' }), 'bob-token');
		await choose(draft, 'author');
		await choose(draft, 'bob');
		await fireEvent.update(draft.text, 'Bob revision');
		vi.mocked(os.apiWithDialog).mockResolvedValue({ updatedDraft: { id: 'draft-b' } } as never);
		await menuAction(draft, '.ti-dots', i18n.ts._drafts.saveToDraft);
		expect(os.apiWithDialog).toHaveBeenCalledWith('notes/drafts/update', expect.objectContaining({ draftId: 'draft-b', text: 'Bob revision' }), 'bob-token');
		const date = new Date(Date.now() + 86400000);
		vi.mocked(os.inputDatetime).mockResolvedValueOnce({ canceled: false, result: date });
		await menuAction(draft, '.ti-dots', i18n.ts.schedulePost + '...');
		await fireEvent.click(draft.getByTestId('post-form-submit'));
		await waitFor(() => expect(os.apiWithDialog).toHaveBeenCalledWith('notes/drafts/update', expect.objectContaining({ draftId: 'draft-b', scheduledAt: date.getTime(), isActuallyScheduled: true }), 'bob-token'));
	});

	test('restores and deletes the posted cloud draft only for its author', async () => {
		const draft = await openDraft('author');
		await choose(draft, 'bob');
		await menuAction(draft, 'header img', i18n.ts._drafts.listDrafts);
		const [, props, events] = vi.mocked(os.popup).mock.lastCall!;
		expect(props).toMatchObject({ token: 'bob-token', draftLimit: 11 });
		const restore = events!.restore as unknown as (draft: Misskey.entities.NoteDraft) => void;
		const cloud = { id: 'draft-b', userId: 'bob', text: 'Saved by Bob', files: [{ id: 'file-b', userId: null }], visibility: 'public' } as Misskey.entities.NoteDraft;
		restore(cloud);
		await nextTick();
		expect(draft.text.value).toBe('Saved by Bob');
		await choose(draft, 'author');
		restore(cloud);
		await nextTick();
		expect(draft.text.value).toBe('');
		await choose(draft, 'bob');
		vi.mocked(misskeyApi).mockResolvedValue({ createdNote: note() } as never);
		await fireEvent.click(draft.getByTestId('post-form-submit'));
		await waitFor(() => expect(draft.emitted().posted).toHaveLength(1));
		expect(misskeyApi).toHaveBeenCalledWith('notes/create', expect.objectContaining({ text: 'Saved by Bob', fileIds: ['file-b'] }), 'bob-token');
		expect(misskeyApi).toHaveBeenCalledWith('notes/drafts/delete', { draftId: 'draft-b' }, 'bob-token');
	});

	test('a missing token keeps the draft and sends no request as the signed-in account', async () => {
		const draft = await openDraft('author');
		await choose(draft, 'bob');
		vi.mocked(getAccounts).mockResolvedValue([]);
		await fireEvent.update(draft.text, 'Still here');
		await menuAction(draft, 'header img', i18n.ts._drafts.listDrafts);
		await menuAction(draft, '.ti-dots', i18n.ts._drafts.saveToDraft);
		await fireEvent.click(draft.getByTestId('post-form-submit'));
		await waitFor(() => expect(os.alert).toHaveBeenCalledTimes(3));
		expect(os.popup).not.toHaveBeenCalled();
		expect(os.apiWithDialog).not.toHaveBeenCalled();
		expect(misskeyApi).not.toHaveBeenCalled();
		expect(draft.text.value).toBe('Still here');
	});

	test('restricts uploads, drive selection, clipboard files and drops to the signed-in account', async () => {
		const draft = await openDraft('author', undefined, { initialFiles: [{ id: 'file-a' } as Misskey.entities.DriveFile] });
		await choose(draft, 'bob');
		expect(draft.queryByTestId('remove-file')).toBeNull();
		for (const selector of ['.ti-cloud-download', '.ti-photo-plus']) {
			expect(draft.container.querySelector(selector)!.closest('button')!.disabled).toBe(true);
		}
		const file = new File(['file'], 'file.txt');
		await fireEvent.paste(draft.text, { clipboardData: { items: [{ kind: 'file', getAsFile: () => file }] } });
		await fireEvent.drop(draft.text, { dataTransfer: { files: [file] } });
		await fireEvent.drop(draft.text, { dataTransfer: { files: [], getData: () => JSON.stringify([{ id: 'file-a' }]) } });
		expect(uploaderState.addFiles).not.toHaveBeenCalled();
		expect(draft.queryByTestId('remove-file')).toBeNull();
		await choose(draft, 'author');
		expect(draft.queryByTestId('remove-file')).toBeTruthy();
	});

	test.each(['reply', 'renote'] as const)('switches %s drafts inside the same composer and posts only the chosen draft', async target => {
		const key = target + ':note';
		const first = await openDraft('author', target);
		await fireEvent.update(first.text, 'First author');
		await choose(first, 'bob');
		expect(first.text.value).not.toContain('First author');
		await fireEvent.update(first.text, 'Second author');
		await choose(first, 'author');
		expect(first.text.value).toBe('First author');
		first.unmount();

		const second = await openDraft('author', target);
		expect(second.text.value).toBe('First author');
		await choose(second, 'bob');
		expect(second.text.value).toBe('Second author');
		vi.mocked(getAccounts).mockResolvedValue([{ host, id: 'bob', username: 'bob', token: 'bob-token' }]);
		vi.mocked(misskeyApi).mockResolvedValue({ createdNote: note() } as never);
		await fireEvent.click(second.getByTestId('post-form-submit'));
		await waitFor(() => expect(second.emitted().posted).toHaveLength(1));
		expect(misskeyApi).toHaveBeenCalledWith('notes/create', expect.objectContaining({ text: 'Second author' }), 'bob-token');
		expect(JSON.parse(localStorage.getItem('drafts:author')!)[key].data.text).toBe('First author');
		expect(JSON.parse(localStorage.getItem('drafts:bob')!)[key]).toBeUndefined();
	});

	test('ignores plugin edits delivered after switching authors, even when returning to the original account', async () => {
		const draft = await openDraft('author', 'reply');
		await menuAction(draft, '.ti-plug', 'Edit draft');
		const [, update] = pluginHandler.mock.lastCall!;
		update('text', 'Alice draft');
		await nextTick();
		expect(draft.text.value).toBe('Alice draft');
		await choose(draft, 'bob');
		await fireEvent.update(draft.text, 'Bob draft');
		update('text', 'Late private text');
		update('cw', 'Late private warning');
		await nextTick();
		expect(draft.text.value).toBe('Bob draft');
		expect(JSON.parse(localStorage.getItem('drafts:bob')!)['reply:note'].data.useCw).toBe(false);
		await choose(draft, 'author');
		update('text', 'Text from an obsolete plugin session');
		await nextTick();
		expect(draft.text.value).toBe('Alice draft');
	});

	test('a pending mention picker cannot insert the selected username into another author’s draft', async () => {
		const selected = Promise.withResolvers<Misskey.entities.UserDetailed>();
		vi.mocked(os.selectUser).mockImplementationOnce(() => selected.promise);
		const draft = await openDraft('author', 'reply');
		await fireEvent.click(draft.container.querySelector('.ti-at')!.closest('button')!);
		await choose(draft, 'bob');
		await fireEvent.update(draft.text, 'Bob draft');
		selected.resolve({ ...note().user, username: 'private-recipient' } as Misskey.entities.UserDetailed);
		await selected.promise;
		await nextTick();
		expect(draft.text.value).toBe('Bob draft');
		expect(JSON.parse(localStorage.getItem('drafts:bob')!)['reply:note'].data.text).toBe('Bob draft');
	});

	test('switching authors frees the editor and ignores the old emoji picker’s selection', async () => {
		const draft = await openDraft('author');
		await fireEvent.click(draft.container.querySelector('.ti-mood-happy')!.closest('button')!);
		const [, onChosen, onClosed] = vi.mocked(emojiPicker.show).mock.lastCall!;
		expect(draft.text.readOnly).toBe(true);
		await choose(draft, 'bob');
		expect(draft.text.readOnly).toBe(false);
		await fireEvent.update(draft.text, 'Bob draft');
		onChosen!('🐈');
		onClosed!();
		await nextTick();
		expect(draft.text.value).toBe('Bob draft');
	});

	test('a drive picker opened before switching authors cannot attach a file to the new draft', async () => {
		const deferred = Promise.withResolvers<Misskey.entities.DriveFile[]>();
		vi.mocked(chooseDriveFile).mockImplementationOnce(() => deferred.promise);
		const draft = await openDraft('author', 'reply');
		await fireEvent.click(draft.container.querySelector('.ti-cloud-download')!.closest('button')!);
		await choose(draft, 'bob');
		deferred.resolve([{ id: 'alice-file' } as Misskey.entities.DriveFile]);
		await nextTick();
		await fireEvent.update(draft.text, 'Bob text');
		expect(JSON.parse(localStorage.getItem('drafts:bob')!)['reply:note'].data.files).toEqual([]);
	});

	test('canceling a switch with pending uploads keeps the original draft open', async () => {
		const draft = await openDraft('author', 'reply');
		await fireEvent.update(draft.text, 'Original');
		uploaderState.allItemsUploaded = false;
		vi.mocked(os.confirm).mockResolvedValueOnce({ canceled: true });
		await choose(draft, 'bob');
		expect(draft.text.value).toBe('Original');
		await fireEvent.update(draft.text, 'Still the first author');
		expect(localStorage.getItem('drafts:bob')).toBeNull();
		expect(JSON.parse(localStorage.getItem('drafts:author')!)['reply:note'].data.text).toBe('Still the first author');
	});

	test('late recipient lookups keep their original author', async () => {
		const deferred = Promise.withResolvers<Misskey.entities.UserLite[]>();
		vi.mocked(misskeyApi).mockImplementationOnce(() => deferred.promise as never);
		localStorage.setItem('drafts:author', JSON.stringify({ 'reply:note': { data: { text: 'DM', visibility: 'specified', visibleUserIds: ['private-recipient'] } } }));
		const draft = await openDraft('author', 'reply');
		await choose(draft, 'bob');
		deferred.resolve([{ id: 'private-recipient', username: 'private-recipient', host: null } as Misskey.entities.UserLite]);
		await nextTick();
		await fireEvent.update(draft.text, 'Bob text');
		expect(JSON.parse(localStorage.getItem('drafts:bob')!)['reply:note'].data.visibleUserIds).toEqual([]);
		expect(JSON.parse(localStorage.getItem('drafts:author')!)['reply:note'].data.visibleUserIds).toEqual(['private-recipient']);
	});

	test.each(['reply', 'renote'] as const)('%s drafts are saved, restored and deleted only for their account', async target => {
		const key = target + ':note';
		const legacy = JSON.stringify({ [key]: { data: { text: 'old draft without an author' } } });
		localStorage.setItem('drafts', legacy);
		const alice = await openDraft('alice', target);
		expect(alice.text.value).toBe('');
		await fireEvent.update(alice.text, 'Alice draft');
		alice.unmount();

		const bob = await openDraft('bob', target);
		expect(bob.text.value).toBe('');
		await fireEvent.update(bob.text, 'Bob draft');
		bob.unmount();

		const again = await openDraft('alice', target);
		expect(again.text.value).toBe('Alice draft');
		vi.mocked(misskeyApi).mockResolvedValue({ createdNote: note() } as never);
		await fireEvent.click(again.getByTestId('post-form-submit'));
		await waitFor(() => expect(again.emitted().posted).toHaveLength(1));
		again.unmount();

		const posted = await openDraft('alice', target);
		expect(posted.text.value).toBe('');
		posted.unmount();
		expect((await openDraft('bob', target)).text.value).toBe('Bob draft');
		expect(localStorage.getItem('drafts')).toBe(legacy);
	});

	test('restores an existing ordinary draft by author', async () => {
		localStorage.setItem('drafts', JSON.stringify({ 'note:alice': { data: { text: 'old ordinary draft' } } }));
		expect((await openDraft('alice')).text.value).toBe('old ordinary draft');
	});
});
