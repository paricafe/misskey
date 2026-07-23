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

function createService() {
	const notesRepository = {
		update: vi.fn().mockResolvedValue(undefined),
		findOneBy: vi.fn().mockResolvedValue({
			id: 'quoted-note',
			hasPoll: true,
		}),
	};
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
	const service = new NoteUpdateService(
		{} as never,
		{} as never,
		notesRepository as never,
		{} as never,
		pollsRepository as never,
		pollVotesRepository as never,
		customEmojiService as never,
		{} as never,
		{ isLocalUser: vi.fn().mockReturnValue(false) } as never,
		noteEntityService as never,
		globalEventService as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
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

	test('reuses a prepared bounded snapshot without packing the old revision twice', async () => {
		const { service, notesRepository, noteEntityService } = createService();
		const preparedUpdate = await service.prepareUpdate(user, note);

		await service.update(user, note, {
			text: 'New text',
			cw: null,
			files: [],
			apHashtags: [],
			apEmojis: [],
			updatedAt: new Date('2025-02-01T00:00:00.000Z'),
		}, true, undefined, preparedUpdate);

		expect(noteEntityService.pack).toHaveBeenCalledTimes(1);
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
		const { service, notesRepository } = createService();
		const history = Array.from({ length: MAX_NOTE_HISTORY_REVISIONS - 1 }, (_, index) => ({
			createdAt: new Date(index).toISOString(),
			text: `revision-${index}`,
		}));

		await service.update(user, { ...note, history } as never, {
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
		const { service, notesRepository, globalEventService, searchService } = createService();
		const history = Array.from({ length: MAX_NOTE_HISTORY_REVISIONS }, (_, index) => ({
			createdAt: new Date(index).toISOString(),
			text: `revision-${index}`,
		}));

		await expect(service.update(user, { ...note, history } as never, {
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
		const { service, notesRepository } = createService();
		const history = [{
			createdAt: '2024-01-01T00:00:00.000Z',
			text: 'x'.repeat(MAX_NOTE_HISTORY_BYTES - 2048),
		}];

		await service.update(user, { ...note, history } as never, {
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
		const { service, notesRepository, globalEventService, searchService } = createService();
		const history = [{
			createdAt: '2024-01-01T00:00:00.000Z',
			text: 'x'.repeat(MAX_NOTE_HISTORY_BYTES),
		}];

		await expect(service.update(user, { ...note, history } as never, {
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
});
