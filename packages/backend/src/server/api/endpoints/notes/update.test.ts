/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NOTE_FILE_NOT_FOUND_ERROR_ID, NOTE_HISTORY_LIMIT_ERROR_ID } from '@/core/NoteUpdateService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import NoteUpdateEndpoint, { meta } from './update.js';

function createEndpoint(
	note: { id: string; userId: string; text: string | null; cw: string | null; fileIds: string[]; hasPoll?: boolean },
	noteUpdateService: { update: ReturnType<typeof vi.fn> },
) {
	return new NoteUpdateEndpoint(
		{ findOneByOrFail: vi.fn().mockResolvedValue({ id: note.userId }) } as never,
		{} as never,
		{ getNote: vi.fn().mockResolvedValue(note) } as never,
		{ pack: vi.fn() } as never,
		noteUpdateService as never,
	);
}

describe('api:notes/update', () => {
	test('declares and returns the no-content error when nullable text and files are both empty', async () => {
		expect(meta.errors.noContent).toMatchObject({
			message: 'A note must have text, files, or a poll.',
			code: 'NO_CONTENT',
			kind: 'client',
			httpStatusCode: 400,
		});
		expect(meta.errors.noContent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

		const note = {
			id: 'noteid',
			userId: 'userid',
			text: 'old',
			cw: null,
			fileIds: [],
		};
		const noteUpdateService = {
			update: vi.fn(),
		};
		const endpoint = createEndpoint(note, noteUpdateService);

		await expect(endpoint.exec({
			noteId: 'noteid',
			text: null,
			cw: null,
			fileIds: [],
		}, { id: 'userid' } as never, null)).rejects.toMatchObject(meta.errors.noContent);
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});

	test('forwards a CW edit for a poll-only note', async () => {
		const note = { id: 'noteid', userId: 'userid', text: null, cw: null, fileIds: [], hasPoll: true };
		const noteUpdateService = { update: vi.fn().mockResolvedValue({ ...note, cw: 'New warning' }) };
		await createEndpoint(note, noteUpdateService).exec({ noteId: note.id, text: null, cw: 'New warning' }, { id: note.userId } as never, null);
		expect(noteUpdateService.update).toHaveBeenCalledOnce();
	});

	test('maps the core history bound to a stable native 422 error', async () => {
		const note = {
			id: 'noteid',
			userId: 'userid',
			text: 'old',
			cw: null,
			fileIds: [],
		};
		const noteUpdateService = {
			update: vi.fn().mockRejectedValue(new IdentifiableError(
				NOTE_HISTORY_LIMIT_ERROR_ID,
				'Note edit history limit exceeded.',
			)),
		};
		const endpoint = createEndpoint(note, noteUpdateService);

		await expect(endpoint.exec({
			noteId: 'noteid',
			text: 'edited',
			cw: null,
		}, { id: 'userid' } as never, null)).rejects.toMatchObject({
			code: 'NOTE_HISTORY_LIMIT_EXCEEDED',
			httpStatusCode: 422,
		});
	});

	test('passes undefined files for an omitted attachment field', async () => {
		const note = {
			id: 'noteid',
			userId: 'userid',
			text: 'old',
			cw: null,
			fileIds: ['existingfile'],
		};
		const noteUpdateService = {
			update: vi.fn().mockResolvedValue({ ...note, text: 'edited' }),
		};
		const endpoint = createEndpoint(note, noteUpdateService);

		await endpoint.exec({
			noteId: 'noteid',
			text: 'edited',
			cw: null,
		}, { id: 'userid' } as never, null);

		expect(noteUpdateService.update.mock.calls[0]?.[2].files).toBeUndefined();
	});

	test('passes an empty files array for an explicit attachment removal', async () => {
		const note = {
			id: 'noteid',
			userId: 'userid',
			text: 'old',
			cw: null,
			fileIds: ['existingfile'],
		};
		const noteUpdateService = {
			update: vi.fn().mockResolvedValue({ ...note, text: 'edited', fileIds: [] }),
		};
		const endpoint = createEndpoint(note, noteUpdateService);

		await endpoint.exec({
			noteId: 'noteid',
			text: 'edited',
			cw: null,
			fileIds: [],
		}, { id: 'userid' } as never, null);

		expect(noteUpdateService.update.mock.calls[0]?.[2].files).toEqual([]);
	});

	test('forwards changed fileComments even when text, cw, and fileIds are unchanged and rejects foreign or unattached files', async () => {
		const note = {
			id: '9x00000001',
			userId: '9x00000002',
			text: 'old',
			cw: null,
			fileIds: ['9x00000010'],
		};
		const driveQuery = {
			where: vi.fn().mockReturnThis(),
			getMany: vi.fn().mockResolvedValue([{ id: '9x00000010', userId: '9x00000002', comment: 'old alt' }]),
		};
		const noteUpdateService = {
			update: vi.fn().mockResolvedValue(note),
		};
		const endpoint = new NoteUpdateEndpoint(
			{ findOneByOrFail: vi.fn().mockResolvedValue({ id: note.userId }) } as never,
			{ createQueryBuilder: vi.fn().mockReturnValue(driveQuery) } as never,
			{ getNote: vi.fn().mockResolvedValue(note) } as never,
			{ pack: vi.fn().mockResolvedValue({ id: note.id }) } as never,
			noteUpdateService as never,
		);

		await endpoint.exec({
			noteId: note.id,
			text: 'old',
			cw: null,
			fileComments: [{ fileId: '9x00000010', comment: 'old alt' }],
		}, { id: note.userId } as never, null);
		expect(noteUpdateService.update).not.toHaveBeenCalled();

		await endpoint.exec({
			noteId: note.id,
			text: 'old',
			cw: null,
			fileComments: [{ fileId: '9x00000010', comment: 'new alt' }],
		}, { id: note.userId } as never, null);
		expect(noteUpdateService.update).toHaveBeenCalledOnce();
		expect(noteUpdateService.update.mock.calls[0]?.[2].fileComments).toEqual([{ fileId: '9x00000010', comment: 'new alt' }]);

		await expect(endpoint.exec({
			noteId: note.id,
			text: 'old',
			cw: null,
			fileComments: [{ fileId: '9x00000099', comment: 'unattached' }],
		}, { id: note.userId } as never, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });

		noteUpdateService.update.mockRejectedValueOnce(new IdentifiableError(NOTE_FILE_NOT_FOUND_ERROR_ID, 'Some files are not found.'));
		await expect(endpoint.exec({
			noteId: note.id,
			text: 'new text',
			cw: null,
			fileComments: [{ fileId: '9x00000010', comment: 'new alt' }],
		}, { id: note.userId } as never, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
	});
});
