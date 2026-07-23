/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NOTE_HISTORY_LIMIT_ERROR_ID } from '@/core/NoteUpdateService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import NoteUpdateEndpoint from './update.js';

function createEndpoint(
	note: { id: string; userId: string; text: string | null; cw: string | null; fileIds: string[] },
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
});
