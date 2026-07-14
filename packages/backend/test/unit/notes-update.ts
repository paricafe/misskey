/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { DriveFilesRepository, MiNote, UsersRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { GetterService } from '@/server/api/GetterService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteUpdateService } from '@/core/NoteUpdateService.js';
import NotesUpdateEndpoint from '@/server/api/endpoints/notes/update.js';

describe('notes/update', () => {
	test('returns the updated note content', async () => {
		const me = { id: 'userid' } as MiLocalUser;
		const originalNote = {
			id: 'noteid',
			userId: me.id,
			text: 'before',
			cw: null,
			fileIds: [],
		} as MiNote;
		const updatedNote = {
			...originalNote,
			text: 'after',
			updatedAt: new Date(),
		} as MiNote;
		const getNote = vi.fn().mockResolvedValue(originalNote);
		const update = vi.fn().mockResolvedValue(updatedNote);
		const pack = vi.fn(async (note: MiNote) => ({
			id: note.id,
			text: note.text,
		}));
		const endpoint = new NotesUpdateEndpoint(
			{ findOneByOrFail: vi.fn().mockResolvedValue(me) } as unknown as UsersRepository,
			{} as DriveFilesRepository,
			{ getNote } as unknown as GetterService,
			{ pack } as unknown as NoteEntityService,
			{ update } as unknown as NoteUpdateService,
		);

		const result = await endpoint.exec({
			noteId: originalNote.id,
			text: updatedNote.text,
			cw: null,
		}, me, null);

		expect(result.updatedNote.text).toBe('after');
		expect(getNote).toHaveBeenCalledOnce();
		expect(pack).toHaveBeenCalledWith(updatedNote, me);
	});
});
