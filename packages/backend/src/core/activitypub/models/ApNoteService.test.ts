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
import { loadConfig } from '@/config.js';
import { MfmService } from '@/core/MfmService.js';
import { ApMfmService } from '@/core/activitypub/ApMfmService.js';
import { StatusError } from '@/misc/status-error.js';
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
		withHistory: vi.fn(async (note: unknown) => note),
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
		eval: vi.fn(async (script: string, _keyCount: number, _key: string, identifier: string) => {
			if (lockOwner !== identifier) return 0;
			if (script.includes('del')) lockOwner = null;
			return 1;
		}),
	};
	const notesRepository = {
		findOneBy: vi.fn().mockResolvedValue(originNote),
		findOne: vi.fn(),
	};
	const apMfmService = { htmlToMfm: vi.fn().mockReturnValue('edited text') };
	const apMentionService = { extractApMentions: vi.fn().mockResolvedValue([]) };
	const service = Object.create(ApNoteService.prototype) as ApNoteService;
	Object.assign(service, {
		config: { url: 'https://local.example' },
		redisClient,
		notesRepository,
		apMfmService,
		apPersonService,
		apResolverService: { createResolver: vi.fn().mockResolvedValue({}) },
		apMentionService,
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
		apMentionService,
		apMfmService,
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

	test('skips an ActivityPub update for a note that is not stored before resolving its author', async () => {
		const { service, notesRepository, apPersonService, noteUpdateService } = createService();
		notesRepository.findOneBy.mockResolvedValueOnce(null);

		await expect(service.updateNote(update as never)).resolves.toBe('skip: note is not registered');

		expect(apPersonService.resolvePerson).not.toHaveBeenCalled();
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});

	test.each([
		['missing', undefined],
		['malformed', 'not a date'],
	])('rejects an ActivityPub update with a %s updated timestamp as an invalid Note', async (_label, updated) => {
		const { service, apPersonService, noteUpdateService } = createService();

		await expect(service.updateNote({ ...update, updated } as never)).rejects.toMatchObject({
			id: 'd450b8a9-48e4-4dab-ae36-f4db763fda7c',
		});

		expect(apPersonService.resolvePerson).not.toHaveBeenCalled();
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

	test('passes resolved ActivityPub Mention tags to the update service', async () => {
		const { service, noteUpdateService, apMentionService } = createService();
		const mentioned = { id: 'mentioned-user', username: 'bob', host: 'other.example' };
		const tag = [{ type: 'Mention', href: 'https://other.example/users/bob', name: '@bob@other.example' }];
		apMentionService.extractApMentions.mockResolvedValue([mentioned]);

		await service.updateNote({ ...update, tag } as never);

		expect(apMentionService.extractApMentions).toHaveBeenCalledWith(tag, expect.anything());
		expect(noteUpdateService.update.mock.calls[0]?.[2]).toMatchObject({ apMentions: [mentioned] });
	});

	test.each([true, false])('edits HTML with two quote links when the stored target matches: %s', async matches => {
		const { service, notesRepository, noteUpdateService } = createService({ renoteId: 'quoted' });
		const other = 'https://unrelated.example/notes/other';
		const uri = 'https://remote.example/notes/quoted';
		const url = 'https://remote.example/@user/123';
		notesRepository.findOne.mockResolvedValue({ id: 'quoted', uri, url });
		Object.assign(service, { apMfmService: new ApMfmService(new MfmService(loadConfig())) });
		const content = [other, url].map(href => `<p class="quote-inline">RE: <a href="${href}">${href}</a></p>`).join('');
		await service.updateNote({ ...update, content, quoteUrl: matches ? uri : other } as never);
		const text = noteUpdateService.update.mock.calls[0]?.[2].text;
		expect(text).toContain(other);
		if (matches) expect(text).not.toContain(url);
		else expect(text).toContain(url);
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

	test('retries a concurrent AP update within the acquisition budget and re-reads committed state before resolving its attachment', async () => {
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
		const redisClient = {
			set: vi.fn(async (_key: string, identifier: string) => {
				if (lockOwner == null) {
					lockOwner = identifier;
					return 'OK';
				}
				return null;
			}),
			get: vi.fn(async () => lockOwner),
			del: vi.fn(async () => {
				lockOwner = null;
				return 1;
			}),
			eval: vi.fn(async (script: string, _keyCount: number, _key: string, identifier: string) => {
				if (lockOwner !== identifier) return 0;
				if (script.includes('del')) {
					lockOwner = null;
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

	test('does not resolve resolveNote before async lock release completes', async () => {
		const {
			service,
			redisClient,
		} = createService();
		const existingNote = { id: 'existing-note' };
		let finishRelease!: () => void;
		const releaseMayFinish = new Promise<void>(resolve => {
			finishRelease = resolve;
		});
		redisClient.eval.mockImplementationOnce(async () => {
			await releaseMayFinish;
			return 1;
		});
		Object.assign(service, {
			utilityService: {
				isFederationAllowedUri: vi.fn().mockReturnValue(true),
			},
			apDbResolverService: {
				getNoteFromApId: vi.fn().mockResolvedValue(existingNote),
			},
		});

		let resolved = false;
		const resolving = service.resolveNote('https://remote.example/notes/existing').then(result => {
			resolved = true;
			return result;
		});
		await vi.waitFor(() => {
			expect(redisClient.eval).toHaveBeenCalledOnce();
		});

		expect(resolved).toBe(false);
		finishRelease();
		await expect(resolving).resolves.toBe(existingNote);
	});

	test('surfaces an async resolveNote lock release failure', async () => {
		const {
			service,
			redisClient,
		} = createService();
		const releaseError = new Error('release failed');
		redisClient.eval.mockRejectedValueOnce(releaseError);
		Object.assign(service, {
			utilityService: {
				isFederationAllowedUri: vi.fn().mockReturnValue(true),
			},
			apDbResolverService: {
				getNoteFromApId: vi.fn().mockResolvedValue({ id: 'existing-note' }),
			},
		});

		await expect(service.resolveNote('https://remote.example/notes/existing')).rejects.toBe(releaseError);
	});

	test('aborts before the Note transaction when the AP object lock is lost during attachment resolution', async () => {
		const {
			service,
			noteUpdateService,
			apImageService,
			redisClient,
		} = createService();
		apImageService.resolveImage.mockResolvedValueOnce({ id: 'new-file' });
		redisClient.eval.mockResolvedValueOnce(0);

		await expect(service.updateNote({
			...update,
			attachment: [{ type: 'Document', url: 'https://remote.example/files/new.png' }],
		} as never)).rejects.toThrow('Lost distributed lock');

		expect(apImageService.resolveImage).toHaveBeenCalledOnce();
		expect(noteUpdateService.update).not.toHaveBeenCalled();
	});
});

describe('incoming HTML quotes', () => {
	test.each(['resolved', 'missing', 'temporary', 'conflict', 'alias', 'blocked'] as const)('handles a %s target', async outcome => {
		const { service } = createService();
		const actor = { id: 'remote-user', host: 'remote.example', uri: update.attributedTo };
		const quoteUrl = 'https://other.example/notes/quoted';
		const unrelated = 'https://unrelated.example/notes/other';
		const displayUrl = outcome === 'alias' ? 'https://other.example/@user/display-url' : quoteUrl;
		const note = {
			...update,
			_misskey_quote: quoteUrl,
			quoteUrl: outcome === 'conflict' ? unrelated : quoteUrl,
			content: `<p class="quote-inline"><a href="${unrelated}">${unrelated}</a></p><p>comment</p><span class="quote-inline">RE: <a href="${displayUrl}">${displayUrl}</a></span>`,
		};
		const create = vi.fn();
		Object.assign(service, {
			logger: { debug: vi.fn(), info: vi.fn() },
			apMfmService: new ApMfmService(new MfmService(loadConfig())),
			apMentionService: { extractApMentionObjects: () => [], extractApMentions: async () => [] },
			apAudienceService: { parseAudience: async () => ({ visibility: 'public', visibleUsers: [] }) },
			apQuestionService: { extractPollFromQuestion: async () => undefined },
			noteCreateService: {
				create,
				checkProhibitedWordsContain: ({ text }: { text: string }) => text.includes(outcome === 'blocked' ? unrelated : 'display-url'),
			},
		});
		vi.spyOn(service, 'validateNote').mockReturnValue(null);
		const target = { id: 'quoted', uri: quoteUrl, url: displayUrl, userHost: 'other.example' };
		const resolve = vi.spyOn(service, 'resolveNote');
		if (outcome === 'conflict') resolve.mockResolvedValueOnce(target as never).mockResolvedValueOnce({ id: 'other', uri: unrelated } as never);
		else if (outcome === 'resolved' || outcome === 'alias' || outcome === 'blocked') resolve.mockResolvedValue(target as never);
		else resolve.mockRejectedValue(new StatusError('remote error', outcome === 'missing' ? 404 : 503, 'remote error'));
		const incoming = service.createNote(note as never, actor as never, { resolve: async () => note } as never);
		if (outcome === 'blocked') {
			await expect(incoming).rejects.toThrow('Note contains prohibited words');
			expect(create).not.toHaveBeenCalled();
		} else if (outcome === 'temporary') {
			await expect(incoming).rejects.toThrow('quote resolve failed');
			expect(create).not.toHaveBeenCalled();
		} else {
			await incoming;
			expect(create.mock.calls[0][1]).toMatchObject(outcome !== 'missing'
				? { text: `${unrelated}\n\ncomment`, renote: target }
				: { text: expect.stringContaining(quoteUrl), renote: undefined });
			expect(create.mock.calls[0][1].text).toContain(unrelated);
		}
	});
});

describe('ActivityPub poll vote dispatch', () => {
	test('routes a remote vote through the shared transactional vote service', async () => {
		const actor = { id: 'remote-voter', host: 'remote.example', uri: 'https://remote.example/users/alice' };
		const vote = {
			id: 'https://remote.example/votes/1', type: 'Note', attributedTo: actor.uri,
			name: 'green', inReplyTo: 'https://local.example/notes/poll',
		};
		const pollVoteService = { vote: vi.fn().mockResolvedValue(undefined) };
		const service = Object.create(ApNoteService.prototype) as ApNoteService;
		Object.assign(service, {
			logger: { debug: vi.fn(), info: vi.fn() },
			apMentionService: { extractApMentionObjects: () => [], extractApMentions: vi.fn().mockResolvedValue([]) },
			apQuestionService: { extractPollFromQuestion: vi.fn().mockResolvedValue(undefined) },
			noteCreateService: { checkProhibitedWordsContain: () => false },
			apAudienceService: { parseAudience: vi.fn().mockResolvedValue({ visibility: 'public', visibleUsers: [] }) },
			pollsRepository: { findOneByOrFail: vi.fn().mockResolvedValue({ choices: ['red', 'green'], expiresAt: null }) },
			pollVoteService,
		});
		Object.defineProperty(service, 'validateNote', { value: () => null });
		Object.defineProperty(service, 'resolveNote', { value: vi.fn().mockResolvedValue({ id: 'poll', hasPoll: true }) });
		const resolver = { resolve: vi.fn().mockResolvedValue(vote) };

		await expect(service.createNote(vote, actor as never, resolver as never)).resolves.toBeNull();
		expect(pollVoteService.vote).toHaveBeenCalledExactlyOnceWith('poll', [1], actor);
	});
});
