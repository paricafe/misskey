/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NoteUpdateService } from './NoteUpdateService.js';

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

const quotedFile = {
	...oldFile,
	id: 'quoted-file',
	name: 'quoted.png',
	url: 'https://cdn.example/quoted.png',
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
				files: [quotedFile],
				fileIds: ['quoted-file'],
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
	const service = new NoteUpdateService(
		{} as never,
		{} as never,
		notesRepository as never,
		{} as never,
		pollsRepository as never,
		pollVotesRepository as never,
		{
			populateEmojis: vi.fn().mockResolvedValue({ party: 'https://cdn.example/party.webp' }),
		} as never,
		{} as never,
		{ isLocalUser: vi.fn().mockReturnValue(false) } as never,
		noteEntityService as never,
		{ publishNoteStream: vi.fn() } as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{ fetch: vi.fn().mockResolvedValue({ mediaSilencedHosts: [] }) } as never,
		{ indexNote: vi.fn() } as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{
			parse: vi.fn().mockReturnValue({ date: new Date('2025-01-01T00:00:00.000Z') }),
		} as never,
		{ isMediaSilencedHost: vi.fn().mockReturnValue(false) } as never,
	);
	return { service, notesRepository, pollsRepository, pollVotesRepository, noteEntityService };
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
} as never;

const user = {
	id: 'user-id',
	uri: null,
	host: null,
	isBot: false,
} as never;

describe(NoteUpdateService, () => {
	test('stores a complete immutable bounded snapshot before replacing note state', async () => {
		const { service, notesRepository, noteEntityService } = createService();

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
					{ text: 'old B', votes: 2, isVoted: true },
				],
			},
			pollVotersCount: 4,
			renote: expect.objectContaining({
				id: 'quoted-note',
				files: [quotedFile],
				poll: expect.objectContaining({
					multiple: true,
					choices: [
						{ text: 'quoted A', votes: 4, isVoted: false },
						{ text: 'quoted B', votes: 1, isVoted: false },
					],
				}),
			}),
			renotePollVotersCount: 4,
		});
		expect(persisted.history[0].renote).not.toHaveProperty('history');
		expect(persisted.history[0].renote).not.toHaveProperty('reply');
		expect(persisted.history[0].renote).not.toHaveProperty('renote');
		expect(noteEntityService.pack).toHaveBeenCalledWith(expect.objectContaining({ id: 'note-id' }), user, expect.objectContaining({ detail: false }));
		expect(noteEntityService.pack).toHaveBeenCalledWith(expect.objectContaining({ id: 'quoted-note' }), user, expect.objectContaining({ detail: false }));
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
});
