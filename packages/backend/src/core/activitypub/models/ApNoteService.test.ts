/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import {
	MAX_NOTE_HISTORY_BYTES,
	MAX_NOTE_HISTORY_REVISIONS,
	NOTE_HISTORY_LIMIT_ERROR_ID,
} from '@/core/NoteUpdateService.js';
import { ApNoteService } from './ApNoteService.js';

function createService(originNoteOverrides: Record<string, unknown> = {}) {
	const preparedUpdate = { noteId: 'origin-note', history: [] };
	const noteUpdateService = {
		prepareUpdate: vi.fn().mockResolvedValue(preparedUpdate),
		update: vi.fn().mockResolvedValue(undefined),
	};
	const apImageService = { resolveImage: vi.fn() };
	const originNote = {
		id: 'origin-note',
		uri: 'https://remote.example/notes/1',
		fileIds: ['existing-file'],
		...originNoteOverrides,
	};
	const service = Object.create(ApNoteService.prototype) as ApNoteService;
	Object.assign(service, {
		config: { url: 'https://local.example' },
		notesRepository: {
			findOneBy: vi.fn().mockResolvedValue(originNote),
		},
		apMfmService: {
			htmlToMfm: vi.fn().mockReturnValue('edited text'),
		},
		apPersonService: {
			resolvePerson: vi.fn().mockResolvedValue({
				id: 'remote-user',
				host: 'remote.example',
			}),
		},
		apImageService,
		noteUpdateService,
		logger: { info: vi.fn() },
	});
	Object.defineProperty(service, 'extractEmojis', {
		value: vi.fn().mockResolvedValue([]),
	});

	return { service, noteUpdateService, apImageService, originNote, preparedUpdate };
}

const update = {
	id: 'https://remote.example/notes/1',
	type: 'Note',
	attributedTo: 'https://remote.example/users/alice',
	updated: '2025-02-01T00:00:00.000Z',
	content: '<p>edited text</p>',
};

describe(ApNoteService, () => {
	test('preserves attachments when an ActivityPub update omits attachment', async () => {
		const { service, noteUpdateService, apImageService, originNote, preparedUpdate } = createService();

		await service.updateNote(update as never);

		const option = noteUpdateService.update.mock.calls[0]?.[2];
		expect(option.files).toBeUndefined();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
		expect(noteUpdateService.prepareUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-user' }), originNote);
		expect(noteUpdateService.update.mock.calls[0]?.[5]).toBe(preparedUpdate);
	});

	test('removes attachments when an ActivityPub update explicitly sends an empty attachment array', async () => {
		const { service, noteUpdateService, apImageService } = createService();

		await service.updateNote({ ...update, attachment: [] } as never);

		const option = noteUpdateService.update.mock.calls[0]?.[2];
		expect(option.files).toEqual([]);
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
	});

	test.each([
		['revision count', {
			history: Array.from({ length: MAX_NOTE_HISTORY_REVISIONS }, (_, index) => ({
				createdAt: new Date(index).toISOString(),
				text: `revision-${index}`,
			})),
		}],
		['byte size', {
			history: [{
				createdAt: '2024-01-01T00:00:00.000Z',
				text: 'x'.repeat(MAX_NOTE_HISTORY_BYTES),
			}],
		}],
	])('rejects a %s overflow before resolving incoming attachments', async (_label, originNoteOverrides) => {
		const { service, noteUpdateService, apImageService } = createService(originNoteOverrides);
		noteUpdateService.prepareUpdate.mockRejectedValueOnce(
			new IdentifiableError(NOTE_HISTORY_LIMIT_ERROR_ID, 'Note edit history limit exceeded.'),
		);

		await expect(service.updateNote({
			...update,
			attachment: [{ type: 'Document', url: 'https://remote.example/files/new.png' }],
		} as never)).rejects.toMatchObject({
			id: NOTE_HISTORY_LIMIT_ERROR_ID,
		});

		expect(noteUpdateService.prepareUpdate).toHaveBeenCalledOnce();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});
});
