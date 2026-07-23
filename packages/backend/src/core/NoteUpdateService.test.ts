/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiNote } from '@/models/Note.js';
import {
	MAX_NOTE_HISTORY_BYTES,
	MAX_NOTE_HISTORY_REVISIONS,
	NOTE_HISTORY_LIMIT_ERROR_ID,
	NoteUpdateService,
} from './NoteUpdateService.js';

const oldFile = {
	id: 'old-file',
	createdAt: '2025-01-01T00:00:00.000Z',
	name: 'old.png',
	type: 'image/png',
	md5: '0123456789abcdef0123456789abcdef',
	size: 123,
	isSensitive: true,
	blurhash: 'blur',
	properties: { width: 640, height: 480 },
	url: 'https://cdn.example/old.png',
	thumbnailUrl: 'https://cdn.example/old-thumb.webp',
	comment: 'old alt text',
	folderId: null,
	folder: null,
	userId: null,
	user: null,
};

function createService(lockedNote: MiNote = note) {
	const notesRepository = {
		update: vi.fn().mockResolvedValue(undefined),
		findOneBy: vi.fn().mockResolvedValue({
			id: 'quoted-note',
			hasPoll: true,
		}),
	};
	const lockedNotesRepository = {
		findOne: vi.fn().mockResolvedValue(lockedNote),
		update: notesRepository.update,
	};
	Object.assign(notesRepository, {
		manager: {
			transaction: vi.fn(async (callback: (manager: { getRepository: () => typeof lockedNotesRepository }) => Promise<unknown>) =>
				callback({ getRepository: () => lockedNotesRepository })),
		},
	});
	const pollsRepository = {
		findOneByOrFail: vi.fn(async ({ noteId }: { noteId: string }) => ({
			noteId,
			multiple: true,
			expiresAt: null,
			choices: noteId === 'note-id' ? ['old A', 'old B'] : ['quoted A', 'quoted B'],
			votes: noteId === 'note-id' ? [3, 2] : [4, 1],
		})),
	};
	const pollVotesRepository = {
		findBy: vi.fn(async ({ noteId }: { noteId: string }) => noteId === 'note-id'
			? [{ choice: 1 }]
			: []),
		createQueryBuilder: vi.fn(() => ({
			select: vi.fn().mockReturnThis(),
			where: vi.fn().mockReturnThis(),
			getRawOne: vi.fn().mockResolvedValue({ count: '4' }),
		})),
	};
	const noteEntityService = {
		pack: vi.fn(async (value: { id: string }) => value.id === 'note-id'
			? {
				files: [oldFile],
				emojis: { party: 'https://cdn.example/party.webp' },
				channel: { isSensitive: false },
			}
			: {
				id: 'quoted-note',
				createdAt: '2024-12-31T00:00:00.000Z',
				text: 'Quoted old state',
				cw: null,
				userId: 'quoted-user',
				user: { id: 'quoted-user', username: 'bob', host: null },
				replyId: null,
				renoteId: 'nested-quote',
				visibility: 'public',
				files: [],
				fileIds: [],
				emojis: {},
				reactions: {},
				reactionEmojis: {},
				reactionCount: 0,
				renoteCount: 0,
				repliesCount: 0,
				history: [{ createdAt: '2024-01-01T00:00:00.000Z', text: 'must not leak' }],
				renote: { id: 'nested-quote' },
				reply: { id: 'nested-reply' },
			}),
	};
	const customEmojiService = {
		populateEmojis: vi.fn().mockResolvedValue({ party: 'https://cdn.example/party.webp' }),
		localEmojisCache: {
			fetch: vi.fn().mockResolvedValue(new Map([
				['party', { name: 'party', publicUrl: 'https://cdn.example/local-party.webp', originalUrl: 'https://origin.example/local-party.png' }],
			])),
		},
	};
	const globalEventService = { publishNoteStream: vi.fn() };
	const searchService = { indexNote: vi.fn() };
	const driveFileEntityService = {
		packManyByIds: vi.fn().mockResolvedValue([]),
	};
	const userEntityService = {
		isLocalUser: vi.fn().mockReturnValue(false),
	};
	const relayService = {
		deliverToRelays: vi.fn(),
	};
	const apRendererService = {
		renderNote: vi.fn(),
		renderUpdateNote: vi.fn(),
		addContext: vi.fn(),
	};
	const apDeliverManagerService = {
		createDeliverManager: vi.fn(),
	};
	const service = new NoteUpdateService(
		{} as never,
		{} as never,
		notesRepository as never,
		{} as never,
		pollsRepository as never,
		pollVotesRepository as never,
		customEmojiService as never,
		driveFileEntityService as never,
		userEntityService as never,
		noteEntityService as never,
		globalEventService as never,
		relayService as never,
		{} as never,
		{} as never,
		apRendererService as never,
		apDeliverManagerService as never,
		{ fetch: vi.fn().mockResolvedValue({ mediaSilencedHosts: [] }) } as never,
		searchService as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{
			parse: vi.fn().mockReturnValue({ date: new Date('2025-01-01T00:00:00.000Z') }),
		} as never,
		{ isMediaSilencedHost: vi.fn().mockReturnValue(false) } as never,
	);
	return {
		service,
		notesRepository,
		pollsRepository,
		pollVotesRepository,
		noteEntityService,
		customEmojiService,
		globalEventService,
		searchService,
		lockedNotesRepository,
		userEntityService,
		relayService,
		apRendererService,
		apDeliverManagerService,
	};
}

const note = {
	id: 'note-id',
	updatedAt: null,
	history: null,
	text: 'Old text',
	cw: 'Old CW',
	fileIds: ['old-file'],
	emojis: ['party'],
	hasPoll: true,
	renoteId: 'quoted-note',
	userId: 'user-id',
	userHost: null,
	localOnly: true,
	visibility: 'public',
	visibleUserIds: [],
	mentions: [],
	tags: [],
	reactions: {},
	reactionAndUserPairCache: [],
} as unknown as MiNote;

const user = {
	id: 'user-id',
	uri: null,
	host: null,
	isBot: false,
} as never;

describe(NoteUpdateService, () => {
	test('stores a complete immutable bounded snapshot before replacing note state', async () => {
		const { service, notesRepository, noteEntityService, pollVotesRepository } = createService();

		await service.update(user, note, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, true);

		const persisted = notesRepository.update.mock.calls[0]?.[1];
		expect(persisted.history).toHaveLength(1);
		expect(persisted.history[0]).toMatchObject({
			createdAt: '2025-01-01T00:00:00.000Z',
			text: 'Old text',
			cw: 'Old CW',
			fileIds: ['old-file'],
			files: [oldFile],
			sensitive: true,
			emojis: ['party'],
			emojiUrls: { party: 'https://cdn.example/party.webp' },
			poll: {
				multiple: true,
				choices: [
					{ text: 'old A', votes: 3, isVoted: false },
					{ text: 'old B', votes: 2, isVoted: false },
				],
			},
			pollVotersCount: 4,
			renoteId: 'quoted-note',
		});
		expect(persisted.history[0]).not.toHaveProperty('renote');
		expect(persisted.history[0]).not.toHaveProperty('renotePollVotersCount');
		expect(pollVotesRepository.findBy).not.toHaveBeenCalled();
		expect(noteEntityService.pack).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-id' }), user, expect.objectContaining({ detail: false }));
		expect(noteEntityService.pack).toHaveBeenCalledTimes(1);
	});

	test('rebuilds a preflight snapshot from the locked note before persistence', async () => {
		const { service, notesRepository, noteEntityService } = createService();
		const preparedUpdate = await service.prepareUpdate(user, note);

		await service.update(user, note, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, true);

		expect(noteEntityService.pack).toHaveBeenCalledTimes(2);
		expect(notesRepository.update.mock.calls[0]?.[1].history).toEqual(preparedUpdate.history);
	});

	test('recognizes an already-applied revision timestamp without preparing history', () => {
		const { service, noteEntityService } = createService();
		const updatedAt = new Date('2025-02-01T00:00:00.000Z');

		expect(service.isUpdateAlreadyApplied({
			...note,
			history: [{
				createdAt: updatedAt.toISOString(),
				text: 'already stored',
			}],
		} as never, updatedAt)).toBe(true);
		expect(noteEntityService.pack).not.toHaveBeenCalled();
	});

	test('recognizes the current note timestamp as already applied', () => {
		const { service, noteEntityService } = createService();
		const updatedAt = new Date('2025-02-01T00:00:00.000Z');

		expect(service.isUpdateAlreadyApplied({
			...note,
			updatedAt,
			history: [],
		} as never, updatedAt)).toBe(true);
		expect(noteEntityService.pack).not.toHaveBeenCalled();
	});

	test('recognizes an older note timestamp as stale even when it is absent from history', () => {
		const { service, noteEntityService } = createService();

		expect(service.isUpdateAlreadyApplied({
			...note,
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
			history: [],
		} as never, new Date('2025-01-01T00:00:00.000Z'))).toBe(true);
		expect(noteEntityService.pack).not.toHaveBeenCalled();
	});

	test('rejects an update by a user who does not own the note before preparing or mutating it', async () => {
		const { service, notesRepository, noteEntityService, globalEventService, searchService } = createService();

		await expect(service.update({
			id: 'different-user',
			uri: null,
			host: null,
			isBot: false,
		} as never, note, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, false)).rejects.toThrow('note author does not match');

		expect(noteEntityService.pack).not.toHaveBeenCalled();
		expect(notesRepository.update).not.toHaveBeenCalled();
		expect(globalEventService.publishNoteStream).not.toHaveBeenCalled();
		expect(searchService.indexNote).not.toHaveBeenCalled();
	});

	test('rejects when the locked note owner changed before preparing or mutating it', async () => {
		const lockedNote = {
			...note,
			userId: 'different-user',
		} as MiNote;
		const {
			service,
			notesRepository,
			noteEntityService,
			globalEventService,
			searchService,
		} = createService(lockedNote);

		await expect(service.update(user, note, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, false)).rejects.toThrow('note author does not match');

		expect(noteEntityService.pack).not.toHaveBeenCalled();
		expect(notesRepository.update).not.toHaveBeenCalled();
		expect(globalEventService.publishNoteStream).not.toHaveBeenCalled();
		expect(searchService.indexNote).not.toHaveBeenCalled();
	});

	test('treats an update that became stale before the lock as a no-op', async () => {
		const lockedNote = {
			...note,
			text: 'Newer committed text',
			updatedAt: new Date('2025-03-01T00:00:00.000Z'),
			history: [{
				createdAt: '2025-01-01T00:00:00.000Z',
				text: 'Old text',
			}],
		} as MiNote;
		const {
			service,
			notesRepository,
			noteEntityService,
			globalEventService,
			searchService,
		} = createService(lockedNote);

		const result = await service.update(user, note, {
			text: 'Stale edit',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, false);

		expect(result).toEqual(lockedNote);
		expect(noteEntityService.pack).not.toHaveBeenCalled();
		expect(notesRepository.update).not.toHaveBeenCalled();
		expect(globalEventService.publishNoteStream).not.toHaveBeenCalled();
		expect(searchService.indexNote).not.toHaveBeenCalled();
	});

	test('resolves local emoji URLs when the normal packed local Note omits emojis', async () => {
		const { service, notesRepository, noteEntityService, customEmojiService } = createService();
		noteEntityService.pack.mockResolvedValueOnce({
			files: [oldFile],
			channel: { isSensitive: false },
		} as never);

		await service.update(user, note, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, true);

		expect(notesRepository.update.mock.calls[0]?.[1].history[0].emojiUrls).toEqual({
			party: 'https://cdn.example/local-party.webp',
		});
		expect(customEmojiService.localEmojisCache.fetch).toHaveBeenCalledOnce();
	});

	test('preserves existing attachments when files are omitted from a partial update', async () => {
		const { service, notesRepository } = createService();

		await service.update(user, note, {
			text: 'New text',
			cw: null,
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, true);

		expect(notesRepository.update).toHaveBeenCalledWith({ id: 'note-id' }, expect.objectContaining({
			fileIds: ['old-file'],
		}));
	});

	test('rejects a final state with neither text nor files', async () => {
		const { service, notesRepository } = createService();

		await expect(service.update(user, note, {
			text: null,
			cw: null,
			files: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, true)).rejects.toThrow('Note must have text or files');

		expect(notesRepository.update).not.toHaveBeenCalled();
	});

	test('allows the history revision count boundary', async () => {
		const history = Array.from({ length: MAX_NOTE_HISTORY_REVISIONS - 1 }, (_, index) => ({
			createdAt: new Date(index).toISOString(),
			text: `revision-${index}`,
		}));
		const noteWithHistory = { ...note, history } as MiNote;
		const { service, notesRepository } = createService(noteWithHistory);

		await service.update(user, noteWithHistory, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, true);

		expect(notesRepository.update.mock.calls[0]?.[1].history).toHaveLength(MAX_NOTE_HISTORY_REVISIONS);
	});

	test('rejects before mutation when the history revision count would exceed the limit', async () => {
		const history = Array.from({ length: MAX_NOTE_HISTORY_REVISIONS }, (_, index) => ({
			createdAt: new Date(index).toISOString(),
			text: `revision-${index}`,
		}));
		const noteWithHistory = { ...note, history } as MiNote;
		const { service, notesRepository, globalEventService, searchService } = createService(noteWithHistory);

		await expect(service.update(user, noteWithHistory, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, false)).rejects.toMatchObject({
			id: NOTE_HISTORY_LIMIT_ERROR_ID,
		});

		expect(notesRepository.update).not.toHaveBeenCalled();
		expect(globalEventService.publishNoteStream).not.toHaveBeenCalled();
		expect(searchService.indexNote).not.toHaveBeenCalled();
	});

	test('allows a history payload below the byte boundary', async () => {
		const history = [{
			createdAt: '2024-01-01T00:00:00.000Z',
			text: 'x'.repeat(MAX_NOTE_HISTORY_BYTES - 2048),
		}];
		const noteWithHistory = { ...note, history } as MiNote;
		const { service, notesRepository } = createService(noteWithHistory);

		await service.update(user, noteWithHistory, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, true);

		const persistedHistory = notesRepository.update.mock.calls[0]?.[1].history;
		expect(Buffer.byteLength(JSON.stringify(persistedHistory), 'utf8')).toBeLessThanOrEqual(MAX_NOTE_HISTORY_BYTES);
	});

	test('rejects before mutation when the history payload exceeds the byte boundary', async () => {
		const history = [{
			createdAt: '2024-01-01T00:00:00.000Z',
			text: 'x'.repeat(MAX_NOTE_HISTORY_BYTES),
		}];
		const noteWithHistory = { ...note, history } as MiNote;
		const { service, notesRepository, globalEventService, searchService } = createService(noteWithHistory);

		await expect(service.update(user, noteWithHistory, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, false)).rejects.toMatchObject({
			id: NOTE_HISTORY_LIMIT_ERROR_ID,
		});

		expect(notesRepository.update).not.toHaveBeenCalled();
		expect(globalEventService.publishNoteStream).not.toHaveBeenCalled();
		expect(searchService.indexNote).not.toHaveBeenCalled();
	});

	test('emits no external side effects when persistence fails', async () => {
		const nonLocalOnlyNote = {
			...note,
			localOnly: false,
		} as MiNote;
		const {
			service,
			notesRepository,
			globalEventService,
			searchService,
			userEntityService,
			relayService,
			apRendererService,
			apDeliverManagerService,
		} = createService(nonLocalOnlyNote);
		userEntityService.isLocalUser.mockReturnValue(true);
		notesRepository.update.mockRejectedValueOnce(new Error('database write failed'));

		await expect(service.update(user, nonLocalOnlyNote, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, false)).rejects.toThrow('database write failed');

		expect(globalEventService.publishNoteStream).not.toHaveBeenCalled();
		expect(searchService.indexNote).not.toHaveBeenCalled();
		expect(apRendererService.renderNote).not.toHaveBeenCalled();
		expect(apDeliverManagerService.createDeliverManager).not.toHaveBeenCalled();
		expect(relayService.deliverToRelays).not.toHaveBeenCalled();
	});

	test('serializes concurrent edits and builds both history revisions from the locked committed note', async () => {
		const { service, notesRepository, globalEventService, searchService } = createService();
		let persistedNote = { ...note };
		let releaseFirstWrite!: () => void;
		const firstWriteMayFinish = new Promise<void>(resolve => {
			releaseFirstWrite = resolve;
		});
		let signalFirstWrite!: () => void;
		const firstWriteStarted = new Promise<void>(resolve => {
			signalFirstWrite = resolve;
		});
		let transactionTail = Promise.resolve();
		let transactionCount = 0;
		const lockedFindOne = vi.fn(async () => ({ ...persistedNote }));
		const transactionalUpdate = vi.fn(async (_criteria: unknown, patch: Partial<MiNote>) => {
			if (transactionalUpdate.mock.calls.length === 1) {
				signalFirstWrite();
				await firstWriteMayFinish;
			}
			persistedNote = { ...persistedNote, ...patch };
		});
		const transaction = vi.fn(async (callback: (manager: {
			getRepository: () => {
				findOne: typeof lockedFindOne;
				update: typeof transactionalUpdate;
			};
		}) => Promise<unknown>) => {
			transactionCount++;
			const previous = transactionTail;
			let releaseTransaction!: () => void;
			transactionTail = new Promise<void>(resolve => {
				releaseTransaction = resolve;
			});
			await previous;
			try {
				return await callback({
					getRepository: () => ({
						findOne: lockedFindOne,
						update: transactionalUpdate,
					}),
				});
			} finally {
				releaseTransaction();
			}
		});
		Object.assign(notesRepository, {
			manager: { transaction },
		});

		const firstUpdate = service.update(user, note, {
			text: 'First edit',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, false);

		await vi.waitFor(() => {
			expect(transaction).toHaveBeenCalledTimes(1);
		});
		await firstWriteStarted;

		const secondUpdate = service.update(user, note, {
			text: 'Second edit',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-03-01T00:00:00.000Z'),
		}, false);
		await vi.waitFor(() => {
			expect(transactionCount).toBe(2);
		});

		releaseFirstWrite();
		await Promise.all([firstUpdate, secondUpdate]);

		expect(lockedFindOne).toHaveBeenCalledTimes(2);
		expect(lockedFindOne).toHaveBeenNthCalledWith(1, expect.objectContaining({
			lock: { mode: 'pessimistic_write' },
		}));
		expect(persistedNote.text).toBe('Second edit');
		expect(persistedNote.history).toHaveLength(2);
		expect(persistedNote.history?.map(revision => revision.text)).toEqual([
			'Old text',
			'First edit',
		]);
		expect(globalEventService.publishNoteStream).toHaveBeenCalledTimes(2);
		expect(searchService.indexNote).toHaveBeenCalledTimes(2);
	});
});
