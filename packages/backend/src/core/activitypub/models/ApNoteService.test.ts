/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApNoteService } from './ApNoteService.js';

function createService() {
	const noteUpdateService = { update: vi.fn().mockResolvedValue(undefined) };
	const apImageService = { resolveImage: vi.fn() };
	const originNote = {
		id: 'origin-note',
		uri: 'https://remote.example/notes/1',
		fileIds: ['existing-file'],
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

	return { service, noteUpdateService, apImageService };
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
		const { service, noteUpdateService, apImageService } = createService();

		await service.updateNote(update as never);

		const option = noteUpdateService.update.mock.calls[0]?.[2];
		expect(option.files).toBeUndefined();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
	});

	test('removes attachments when an ActivityPub update explicitly sends an empty attachment array', async () => {
		const { service, noteUpdateService, apImageService } = createService();

		await service.updateNote({ ...update, attachment: [] } as never);

		const option = noteUpdateService.update.mock.calls[0]?.[2];
		expect(option.files).toEqual([]);
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
	});
});
