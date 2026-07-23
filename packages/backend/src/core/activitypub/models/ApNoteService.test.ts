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
	NoteUpdateService,
} from '@/core/NoteUpdateService.js';
import { ApNoteService } from './ApNoteService.js';

function createService(originNoteOverrides: Record<string, unknown> = {}) {
	const preparedUpdate = { noteId: 'origin-note', history: [] };
	const noteUpdateService = {
		isUpdateAlreadyApplied: vi.fn((
			note: { updatedAt?: Date | null; history?: Array<{ createdAt: string }> | null },
			updatedAt: Date,
		) => NoteUpdateService.prototype.isUpdateAlreadyApplied(note as never, updatedAt)),
		prepareUpdate: vi.fn().mockResolvedValue(preparedUpdate),
		update: vi.fn().mockResolvedValue(undefined),
	};
	const apImageService = { resolveImage: vi.fn() };
	const apPersonService = {
		resolvePerson: vi.fn().mockResolvedValue({
			id: 'remote-user',
			host: 'remote.example',
		}),
	};
	const extractEmojis = vi.fn().mockResolvedValue([]);
	const originNote = {
		id: 'origin-note',
		uri: 'https://remote.example/notes/1',
		userId: 'remote-user',
		fileIds: ['existing-file'],
		...originNoteOverrides,
	};
	let lockOwner: string | null = null;
	const redisClient = {
		set: vi.fn(async (_key: string, identifier: string) => {
			if (lockOwner != null) return null;
			lockOwner = identifier;
			return 'OK';
		}),
		get: vi.fn(async () => lockOwner),
		del: vi.fn(async () => {
			lockOwner = null;
			return 1;
		}),
	};
	const notesRepository = {
		findOneBy: vi.fn().mockResolvedValue(originNote),
	};
	const service = Object.create(ApNoteService.prototype) as ApNoteService;
	Object.assign(service, {
		config: { url: 'https://local.example' },
		redisClient,
		notesRepository,
		apMfmService: {
			htmlToMfm: vi.fn().mockReturnValue('edited text'),
		},
		apPersonService,
		apImageService,
		noteUpdateService,
		logger: { info: vi.fn() },
	});
	Object.defineProperty(service, 'extractEmojis', {
		value: extractEmojis,
	});

	return {
		service,
		noteUpdateService,
		apImageService,
		apPersonService,
		extractEmojis,
		originNote,
		preparedUpdate,
		redisClient,
		notesRepository,
	};
}

const update = {
	id: 'https://remote.example/notes/1',
	type: 'Note',
	attributedTo: 'https://remote.example/users/alice',
	updated: '2025-02-01T00:00:00.000Z',
	content: '<p>edited text</p>',
};

describe(ApNoteService, () => {
	test('rejects an ActivityPub update whose resolved author does not own the cached note before preparing or resolving content', async () => {
		const {
			service,
			noteUpdateService,
			apImageService,
			extractEmojis,
		} = createService({ userId: 'different-remote-user' });

		await expect(service.updateNote({
			...update,
			attachment: [{ type: 'Document', url: 'https://remote.example/files/new.png' }],
		} as never)).rejects.toThrow('note author does not match');

		expect(noteUpdateService.prepareUpdate).not.toHaveBeenCalled();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
		expect(extractEmojis).not.toHaveBeenCalled();
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});

	test('preserves attachments when an ActivityPub update omits attachment', async () => {
		const { service, noteUpdateService, apImageService, originNote } = createService();

		await service.updateNote(update as never);

		const option = noteUpdateService.update.mock.calls[0]?.[2];
		expect(option.files).toBeUndefined();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
		expect(noteUpdateService.prepareUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'remote-user' }), originNote);
		expect(noteUpdateService.update.mock.calls[0]).toHaveLength(4);
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

	test('treats an already-seen update as a no-op before a full-history preflight or attachment resolution', async () => {
		const history = Array.from({ length: MAX_NOTE_HISTORY_REVISIONS }, (_, index) => ({
			createdAt: index === 0 ? update.updated : new Date(index).toISOString(),
			text: `revision-${index}`,
		}));
		const {
			service,
			noteUpdateService,
			apImageService,
			apPersonService,
			extractEmojis,
			originNote,
		} = createService({ history });
		noteUpdateService.prepareUpdate.mockRejectedValueOnce(
			new IdentifiableError(NOTE_HISTORY_LIMIT_ERROR_ID, 'Note edit history limit exceeded.'),
		);

		await expect(service.updateNote({
			...update,
			attachment: [{ type: 'Document', url: 'https://remote.example/files/new.png' }],
		} as never)).resolves.toBeUndefined();

		expect(noteUpdateService.isUpdateAlreadyApplied).toHaveBeenCalledWith(
			originNote,
			new Date(update.updated),
		);
		expect(apPersonService.resolvePerson).toHaveBeenCalledOnce();
		expect(noteUpdateService.prepareUpdate).not.toHaveBeenCalled();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
		expect(extractEmojis).not.toHaveBeenCalled();
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});

	test('treats a replay of the current version as a no-op before resolving any side effects', async () => {
		const history = Array.from({ length: MAX_NOTE_HISTORY_REVISIONS }, (_, index) => ({
			createdAt: new Date(index).toISOString(),
			text: `revision-${index}`,
		}));
		const {
			service,
			noteUpdateService,
			apImageService,
			apPersonService,
			extractEmojis,
		} = createService({
			updatedAt: new Date(update.updated),
			history,
		});
		noteUpdateService.prepareUpdate.mockRejectedValueOnce(
			new IdentifiableError(NOTE_HISTORY_LIMIT_ERROR_ID, 'Note edit history limit exceeded.'),
		);

		await expect(service.updateNote({
			...update,
			attachment: [{ type: 'Document', url: 'https://remote.example/files/new.png' }],
		} as never)).resolves.toBeUndefined();

		expect(apPersonService.resolvePerson).toHaveBeenCalledOnce();
		expect(noteUpdateService.prepareUpdate).not.toHaveBeenCalled();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
		expect(extractEmojis).not.toHaveBeenCalled();
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});

	test('treats a stale update absent from history as a repeatable no-op before resolving any side effects', async () => {
		const {
			service,
			noteUpdateService,
			apImageService,
			apPersonService,
			extractEmojis,
		} = createService({
			updatedAt: new Date('2025-03-01T00:00:00.000Z'),
			history: [],
		});
		const staleUpdate = {
			...update,
			updated: '2025-01-01T00:00:00.000Z',
			attachment: [{ type: 'Document', url: 'https://remote.example/files/new.png' }],
		};

		await expect(service.updateNote(staleUpdate as never)).resolves.toBeUndefined();
		await expect(service.updateNote(staleUpdate as never)).resolves.toBeUndefined();

		expect(noteUpdateService.isUpdateAlreadyApplied).toHaveBeenCalledTimes(2);
		expect(apPersonService.resolvePerson).toHaveBeenCalledTimes(2);
		expect(noteUpdateService.prepareUpdate).not.toHaveBeenCalled();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
		expect(extractEmojis).not.toHaveBeenCalled();
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});

	test('rejects a stale update whose resolved author does not own the cached note', async () => {
		const {
			service,
			noteUpdateService,
			apImageService,
			extractEmojis,
		} = createService({
			userId: 'different-remote-user',
			updatedAt: new Date('2025-03-01T00:00:00.000Z'),
		});

		await expect(service.updateNote({
			...update,
			updated: '2025-01-01T00:00:00.000Z',
			attachment: [{ type: 'Document', url: 'https://remote.example/files/new.png' }],
		} as never)).rejects.toThrow('note author does not match');

		expect(noteUpdateService.prepareUpdate).not.toHaveBeenCalled();
		expect(apImageService.resolveImage).not.toHaveBeenCalled();
		expect(extractEmojis).not.toHaveBeenCalled();
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});

	test('serializes concurrent AP updates and re-reads committed state before resolving the second attachment', async () => {
		const {
			service,
			noteUpdateService,
			apImageService,
			notesRepository,
		} = createService({ history: [] });
		let currentNote = {
			id: 'origin-note',
			uri: 'https://remote.example/notes/1',
			userId: 'remote-user',
			fileIds: ['existing-file'],
			updatedAt: null as Date | null,
			history: [] as Array<{ createdAt: string; text: string }>,
		};
		notesRepository.findOneBy.mockImplementation(async () => ({ ...currentNote }));

		let lockOwner: string | null = null;
		const lockWaiters: Array<{ identifier: string; resolve: (value: string) => void }> = [];
		const redisClient = {
			set: vi.fn(async (_key: string, identifier: string) => {
				if (lockOwner == null) {
					lockOwner = identifier;
					return 'OK';
				}
				return await new Promise<string>(resolve => {
					lockWaiters.push({ identifier, resolve });
				});
			}),
			get: vi.fn(async () => lockOwner),
			del: vi.fn(async () => {
				lockOwner = null;
				const waiter = lockWaiters.shift();
				if (waiter != null) {
					lockOwner = waiter.identifier;
					waiter.resolve('OK');
				}
				return 1;
			}),
		};
		Object.assign(service, { redisClient });

		let releaseFirstAttachment!: () => void;
		const firstAttachmentMayFinish = new Promise<void>(resolve => {
			releaseFirstAttachment = resolve;
		});
		apImageService.resolveImage.mockImplementationOnce(async () => {
			await firstAttachmentMayFinish;
			return { id: 'new-file' };
		});
		noteUpdateService.update.mockImplementationOnce(async (_actor, lockedNote, data) => {
			currentNote = {
				...currentNote,
				...lockedNote,
				updatedAt: data.updatedAt,
				history: [{
					createdAt: '2025-01-01T00:00:00.000Z',
					text: 'Old text',
				}],
			};
		});
		const concurrentUpdate = {
			...update,
			attachment: [{ type: 'Document', url: 'https://remote.example/files/new.png' }],
		};

		const first = service.updateNote(concurrentUpdate as never);
		await vi.waitFor(() => {
			expect(apImageService.resolveImage).toHaveBeenCalledOnce();
		});

		const second = service.updateNote(concurrentUpdate as never);
		await vi.waitFor(() => {
			expect(redisClient.set).toHaveBeenCalledTimes(2);
		});
		expect(notesRepository.findOneBy).toHaveBeenCalledOnce();
		expect(noteUpdateService.update).not.toHaveBeenCalled();

		releaseFirstAttachment();
		await Promise.all([first, second]);

		expect(notesRepository.findOneBy).toHaveBeenCalledTimes(2);
		expect(noteUpdateService.update).toHaveBeenCalledOnce();
		expect(noteUpdateService.prepareUpdate).toHaveBeenCalledOnce();
		expect(apImageService.resolveImage).toHaveBeenCalledOnce();
	});
});
