/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import * as Redis from 'ioredis';
import ms from 'ms';
import {
	type MiNote,
	type MiUser,
	type NotesRepository,
	type NoteFavoritesRepository,
	type NoteReactionsRepository,
	type UserNotePiningsRepository,
	type UsersRepository,
	type UserProfilesRepository,
	MiMeta,
} from '@/models/_.js';
import { CleanRemoteNotesProcessorService } from '@/queue/processors/CleanRemoteNotesProcessorService.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';

describe('CleanRemoteNotesProcessorService', () => {
	let app: TestingModule;
	let service: CleanRemoteNotesProcessorService;
	let idService: IdService;
	let notesRepository: NotesRepository;
	let noteFavoritesRepository: NoteFavoritesRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let userNotePiningsRepository: UserNotePiningsRepository;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let redisClient: Redis.Redis;

	let alice: MiUser;
	let bob: MiUser;
	let carol: MiUser;
	let dave: MiUser;

	const meta = new MiMeta();

	const CURSOR_REDIS_KEY = 'cleanRemoteNotes:cursor';

	const createMockJob = () => ({
		log: vi.fn(),
		updateProgress: vi.fn(),
	});

	async function createUser(data: Partial<MiUser> = {}) {
		const id = idService.gen();
		const un = data.username || secureRndstr(16);
		const user = await usersRepository
			.insert({
				id,
				username: un,
				usernameLower: un.toLowerCase(),
				...data,
			})
			.then(x => usersRepository.findOneByOrFail(x.identifiers[0]));

		await userProfilesRepository.save({
			userId: id,
		});

		return user;
	}

	async function createNote(data: Partial<MiNote>, user: MiUser, time?: number): Promise<MiNote> {
		const id = idService.gen(time);
		const note = await notesRepository
			.insert({
				id: id,
				text: `note_${id}`,
				userId: user.id,
				userHost: user.host,
				visibility: 'public',
				...data,
			})
			.then(x => notesRepository.findOneByOrFail(x.identifiers[0]));
		return note;
	}

	beforeAll(async () => {
		app = await Test
			.createTestingModule({
				imports: [
					GlobalModule,
				],
				providers: [
					CleanRemoteNotesProcessorService,
					IdService,
					{
						provide: QueueLoggerService,
						useFactory: () => ({
							logger: {
								createSubLogger: () => ({
									info: vi.fn(),
									warn: vi.fn(),
									succ: vi.fn(),
								}),
							},
						}),
					},
				],
			})
			.overrideProvider(DI.meta).useFactory({ factory: () => meta })
			.compile();

		service = app.get(CleanRemoteNotesProcessorService);
		idService = app.get(IdService);
		notesRepository = app.get(DI.notesRepository);
		noteFavoritesRepository = app.get(DI.noteFavoritesRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);
		userNotePiningsRepository = app.get(DI.userNotePiningsRepository);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		redisClient = app.get(DI.redis);

		alice = await createUser({ username: 'alice', host: null });
		bob = await createUser({ username: 'bob', host: 'remote1.example.com', isBot: true });
		carol = await createUser({ username: 'carol', host: 'remote2.example.com', isBot: true });
		dave = await createUser({ username: 'dave', host: 'remote3.example.com', isBot: false });

		app.enableShutdownHooks();
	});

	beforeEach(async () => {
		vi.clearAllMocks();

		await redisClient.del(CURSOR_REDIS_KEY);

		meta.enableRemoteNotesCleaning = true;
		meta.remoteNotesCleaningMaxProcessingDurationInMinutes = 0.3;
		meta.remoteNotesCleaningExpiryDaysForEachNotes = 30;
	}, 60 * 1000);

	afterEach(async () => {
		await Promise.all([
			notesRepository.createQueryBuilder().delete().execute(),
			userNotePiningsRepository.createQueryBuilder().delete().execute(),
			noteFavoritesRepository.createQueryBuilder().delete().execute(),
			noteReactionsRepository.createQueryBuilder().delete().execute(),
		]);
	}, 60 * 1000);

	afterAll(async () => {
		await app.close();
	});

	describe('basic', () => {
		test('keeps old remote notes from accounts that are not bots', async () => {
			const job = createMockJob();
			const humanNote = await createNote({}, dave, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);
			const botNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(1);
			expect(await notesRepository.findOneBy({ id: humanNote.id })).not.toBeNull();
			expect(await notesRepository.findOneBy({ id: botNote.id })).toBeNull();
		});

		test('should skip cleaning when enableRemoteNotesCleaning is false', async () => {
			meta.enableRemoteNotesCleaning = false;
			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result).toEqual({
				deletedCount: 0,
				oldest: null,
				newest: null,
				cursor: null,
				skipped: true,
				transientErrors: 0,
			});
		});

		test('should return success result when enableRemoteNotesCleaning is true and no notes to clean', async () => {
			const job = createMockJob();

			await createNote({}, alice);
			const result = await service.process(job as any);

			expect(result).toEqual({
				deletedCount: 0,
				oldest: null,
				newest: null,
				cursor: null,
				skipped: false,
				transientErrors: 0,
			});
		}, 3000);

		test('should clean remote notes and return stats', async () => {
			const remoteNotes = await Promise.all([
				createNote({}, bob),
				createNote({}, carol),
				createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000),
				createNote({}, carol, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 2000),
			]);

			const localNotes = await Promise.all([
				createNote({}, alice),
				createNote({}, alice, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000),
			]);

			const job = createMockJob();

			const result = await service.process(job as any);

			expect(result).toEqual({
				deletedCount: 2,
				oldest: idService.parse(remoteNotes[3].id).date.getTime(),
				newest: idService.parse(remoteNotes[2].id).date.getTime(),
				cursor: null,
				skipped: false,
				transientErrors: 0,
			});

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length).toBe(4);
			expect(remainingNotes.some(n => n.id === remoteNotes[0].id)).toBe(true);
			expect(remainingNotes.some(n => n.id === remoteNotes[1].id)).toBe(true);
			expect(remainingNotes.some(n => n.id === remoteNotes[2].id)).toBe(false);
			expect(remainingNotes.some(n => n.id === remoteNotes[3].id)).toBe(false);
			expect(remainingNotes.some(n => n.id === localNotes[0].id)).toBe(true);
			expect(remainingNotes.some(n => n.id === localNotes[1].id)).toBe(true);
		});
	});

	describe('advanced', () => {
		test('should not delete note that is favorited by any user', async () => {
			const job = createMockJob();

			const olderRemoteNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			await noteFavoritesRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: olderRemoteNote.id,
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNote = await notesRepository.findOneBy({ id: olderRemoteNote.id });
			expect(remainingNote).not.toBeNull();
		});

		test('should not delete note that is pinned by the user', async () => {
			const job = createMockJob();

			const olderRemoteNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			await userNotePiningsRepository.save({
				id: idService.gen(),
				userId: bob.id,
				noteId: olderRemoteNote.id,
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNote = await notesRepository.findOneBy({ id: olderRemoteNote.id });
			expect(remainingNote).not.toBeNull();
		});

		test('should not delete note that is clipped', async () => {
			const job = createMockJob();

			const clippedNote = await createNote({
				clippedCount: 1,
			}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNote = await notesRepository.findOneBy({ id: clippedNote.id });
			expect(remainingNote).not.toBeNull();
		});

		test('should not delete note that is embedded in a page', async () => {
			const job = createMockJob();

			const clippedNote = await createNote({
				pageCount: 1,
			}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNote = await notesRepository.findOneBy({ id: clippedNote.id });
			expect(remainingNote).not.toBeNull();
		});

		test('should handle reply/renote relationships correctly', async () => {
			const job = createMockJob();

			const originalNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);
			const replyNote = await createNote({
				replyId: originalNote.id,
			}, carol, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 2000);
			const renoteNote = await createNote({
				renoteId: originalNote.id,
			}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 3000);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(3);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === originalNote.id)).toBe(false);
			expect(remainingNotes.some(n => n.id === replyNote.id)).toBe(false);
			expect(remainingNotes.some(n => n.id === renoteNote.id)).toBe(false);
		});

		test('should not delete both old remote note with new reply', async () => {
			const job = createMockJob();

			const oldNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			const recentReplyNote = await createNote({
				replyId: oldNote.id,
			}, carol, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) + 1000);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === oldNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === recentReplyNote.id)).toBe(true);
		});

		test('should not delete old remote note with new reply and old reply', async () => {
			const job = createMockJob();

			const oldNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			const recentReplyNote = await createNote({
				replyId: oldNote.id,
			}, carol, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) + 1000);

			const oldReplyNote = await createNote({
				replyId: oldNote.id,
			}, carol, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 2000);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === oldNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === recentReplyNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === oldReplyNote.id)).toBe(true);
		});

		test('should not delete reply note that is favorited', async () => {
			const job = createMockJob();

			const olderRemoteNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			const replyNote = await createNote({
				replyId: olderRemoteNote.id,
			}, carol, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 2000);

			await noteFavoritesRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: replyNote.id,
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === olderRemoteNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === replyNote.id)).toBe(true);
		});

		test('should not delete reply note that is pinned', async () => {
			const job = createMockJob();

			const olderRemoteNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			const replyNote = await createNote({
				replyId: olderRemoteNote.id,
			}, carol, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 2000);

			await userNotePiningsRepository.save({
				id: idService.gen(),
				userId: carol.id,
				noteId: replyNote.id,
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === olderRemoteNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === replyNote.id)).toBe(true);
		});

		test('should not delete reply note that is clipped', async () => {
			const job = createMockJob();

			const olderRemoteNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			const replyNote = await createNote({
				replyId: olderRemoteNote.id,
				clippedCount: 1,
			}, carol, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 2000);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === olderRemoteNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === replyNote.id)).toBe(true);
		});

		test('should handle mixed scenarios with multiple conditions', async () => {
			const job = createMockJob();

			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			const deletableNote = await createNote({}, bob, oldTime);

			const favoritedNote = await createNote({}, carol, oldTime);
			await noteFavoritesRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: favoritedNote.id,
			});

			const pinnedNote = await createNote({}, bob, oldTime);
			await userNotePiningsRepository.save({
				id: idService.gen(),
				userId: bob.id,
				noteId: pinnedNote.id,
			});

			const clippedNote = await createNote({
				clippedCount: 2,
			}, carol, oldTime);

			const localNote = await createNote({}, alice, oldTime);

			const newerRemoteNote = await createNote({}, bob);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(1);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length).toBe(5);
			expect(remainingNotes.some(n => n.id === deletableNote.id)).toBe(false);
			expect(remainingNotes.some(n => n.id === favoritedNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === pinnedNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === clippedNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === localNote.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === newerRemoteNote.id)).toBe(true);
		});

		test('should handle large number of notes correctly', async () => {
			const AMOUNT = 130;
			const job = createMockJob();

			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			const noteIds = [];
			for (let i = 0; i < AMOUNT; i++) {
				const note = await createNote({}, bob, oldTime - i);
				noteIds.push(note.id);
			}

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(AMOUNT);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length).toBe(0);
		});

		test('should handle large number of notes with replies correctly', async () => {
			const AMOUNT = 130;
			const job = createMockJob();

			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			const noteIds = [];
			for (let i = 0; i < AMOUNT; i++) {
				const note = await createNote({}, bob, oldTime - i - AMOUNT);
				noteIds.push(note.id);
				if (i % 2 === 0) {
					await createNote({ replyId: note.id }, carol, oldTime - i);
				} else {
					await createNote({ renoteId: note.id }, bob, oldTime - i);
				}
			}

			const result = await service.process(job as any);
			expect(result.deletedCount).toBe(AMOUNT * 2);
			expect(result.skipped).toBe(false);
		});

		test('should handle large number of old notes with new replies correctly', async () => {
			const AMOUNT = 130;
			const job = createMockJob();

			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			const newTime = Date.now();
			const noteIds = [];
			for (let i = 0; i < AMOUNT; i++) {
				const note = await createNote({}, bob, oldTime - i);
				noteIds.push(note.id);
				if (i % 2 === 0) {
					await createNote({ replyId: note.id }, carol, newTime + i);
				} else {
					await createNote({ renoteId: note.id }, bob, newTime + i);
				}
			}
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);
		});

		test('should handle large number of notes, mixed conditions with clippedCount', async () => {
			const AMOUNT_BASE = 70;
			const job = createMockJob();

			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			const noteIds = [];
			for (let i = 0; i < AMOUNT_BASE; i++) {
				const note = await createNote({ clippedCount: 1 }, bob, oldTime - i - AMOUNT_BASE);
				noteIds.push(note.id);
			}
			for (let i = 0; i < AMOUNT_BASE; i++) {
				const note = await createNote({}, carol, oldTime - i);
				noteIds.push(note.id);
			}

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(AMOUNT_BASE);
			expect(result.skipped).toBe(false);
		});

		test('should handle large number of notes, mixed conditions with replies', async () => {
			const AMOUNT_BASE = 70;
			const job = createMockJob();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			const newTime = Date.now();
			for (let i = 0; i < AMOUNT_BASE; i++) {
				const note = await createNote({}, carol, oldTime - AMOUNT_BASE - i);
				await createNote({ replyId: note.id }, bob, newTime + i);
			}

			const noteIdsExpectedToBeDeleted = [];
			for (let i = 0; i < AMOUNT_BASE; i++) {
				const note = await createNote({}, bob, oldTime - i);
				noteIdsExpectedToBeDeleted.push(note.id);
			}

			const result = await service.process(job as any);
			expect(result.deletedCount).toBe(AMOUNT_BASE);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length).toBe(AMOUNT_BASE * 2);
			noteIdsExpectedToBeDeleted.forEach(id => {
				expect(remainingNotes.some(n => n.id === id)).toBe(false);
			});
		});

		test('should update cursor correctly during batch processing', async () => {
			const job = createMockJob();

			const baseTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 10000;

			const note1 = await createNote({}, bob, baseTime);
			const note2 = await createNote({}, carol, baseTime - 1000);
			const note3 = await createNote({}, bob, baseTime - 2000);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(3);
			expect(result.newest).toBe(idService.parse(note1.id).date.getTime());
			expect(result.oldest).toBe(idService.parse(note3.id).date.getTime());
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === note1.id)).toBe(false);
			expect(remainingNotes.some(n => n.id === note2.id)).toBe(false);
			expect(remainingNotes.some(n => n.id === note3.id)).toBe(false);
		});
	});

	describe('advanced - cursor and iteration', () => {
		const BATCH_LOG_RE = /^Deleted (\d+) notes;/;

		const countBatchLogs = (job: ReturnType<typeof createMockJob>) =>
			(job.log as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call: unknown[]) => typeof call[0] === 'string' && BATCH_LOG_RE.test(call[0] as string),
			).length;

		test('should iterate multiple times when notes exceed currentLimit', async () => {
			const AMOUNT = 350;
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			for (let i = 0; i < AMOUNT; i++) {
				await createNote({}, bob, oldTime - i);
			}

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(AMOUNT);
			expect(result.skipped).toBe(false);

			expect(countBatchLogs(job)).toBeGreaterThanOrEqual(2);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length).toBe(0);
		}, 30 * 1000);

		test('should advance cursor past anti-joined trees to reach deletables beyond', async () => {
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 100000;

			const blockA: MiNote[] = [];
			for (let i = 0; i < 50; i++) {
				blockA.push(await createNote({}, bob, oldTime - 50000 - i));
			}

			const blockBRoots: MiNote[] = [];
			const blockBReplies: MiNote[] = [];
			for (let i = 0; i < 50; i++) {
				const root = await createNote({}, bob, oldTime - 30000 - i * 2);
				const reply = await createNote({ replyId: root.id, clippedCount: 1 }, carol, oldTime - 30000 - i * 2 - 1);
				blockBRoots.push(root);
				blockBReplies.push(reply);
			}

			const blockC: MiNote[] = [];
			for (let i = 0; i < 50; i++) {
				blockC.push(await createNote({}, carol, oldTime - 10000 - i));
			}

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(100);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			blockA.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(false);
			});
			blockBRoots.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(true);
			});
			blockBReplies.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(true);
			});
			blockC.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(false);
			});

			expect(countBatchLogs(job)).toBeGreaterThanOrEqual(2);
		}, 30 * 1000);

		test('should locate a single deletable note buried in irrelevant ones via minId scan', async () => {
			const newTime = Date.now();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			for (let i = 0; i < 50; i++) {
				await createNote({}, bob, newTime - i);
			}

			for (let i = 0; i < 50; i++) {
				await createNote({}, alice, oldTime - i);
			}

			const parent = await createNote({}, bob);
			for (let i = 0; i < 50; i++) {
				await createNote({ replyId: parent.id }, bob, oldTime - 100 - i);
			}

			const target = await createNote({}, bob, oldTime - 5000);

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(1);
			expect(result.skipped).toBe(false);
			expect(result.oldest).toBe(idService.parse(target.id).date.getTime());
			expect(result.newest).toBe(idService.parse(target.id).date.getTime());

			const remainingTarget = await notesRepository.findOneBy({ id: target.id });
			expect(remainingTarget).toBeNull();
		}, 30 * 1000);

		test('should advance cursor correctly across interleaved deletable/protected notes', async () => {
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 10000;

			const deletables: MiNote[] = [];
			const protectedNotes: MiNote[] = [];

			for (let i = 0; i < 250; i++) {
				if (i % 2 === 0) {
					deletables.push(await createNote({}, bob, oldTime - i));
				} else {
					protectedNotes.push(await createNote({ clippedCount: 1 }, bob, oldTime - i));
				}
			}

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(deletables.length);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length).toBe(protectedNotes.length);
			deletables.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(false);
			});
			protectedNotes.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(true);
			});

			expect(countBatchLogs(job)).toBeGreaterThanOrEqual(2);
		}, 30 * 1000);

		test('should not reprocess notes from a previous batch (cursor monotonicity)', async () => {
			const AMOUNT = 250;
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			for (let i = 0; i < AMOUNT; i++) {
				await createNote({}, bob, oldTime - i);
			}

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(AMOUNT);

			const batchSizes = (job.log as ReturnType<typeof vi.fn>).mock.calls
				.map((call: unknown[]) => (typeof call[0] === 'string' ? call[0] as string : ''))
				.map((s: string) => s.match(BATCH_LOG_RE)?.[1])
				.filter((m): m is string => Boolean(m))
				.map((n: string) => Number(n));
			expect(batchSizes.length).toBeGreaterThanOrEqual(2);
			expect(batchSizes.reduce((a, b) => a + b, 0)).toBe(AMOUNT);
		}, 30 * 1000);
	});

	describe('advanced - cursor persistence', () => {
		const oldTimeBase = () => Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 10000;

		test('should clear the stored cursor once the scan reaches the end', async () => {
			await createNote({}, bob, oldTimeBase());

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(1);
			expect(result.cursor).toBe(null);
			expect(await redisClient.get(CURSOR_REDIS_KEY)).toBe(null);
		});

		test('should resume from the stored cursor and leave notes before it untouched', async () => {
			const oldTime = oldTimeBase();
			const beforeCursor = await createNote({}, bob, oldTime);
			const afterCursor = await createNote({}, bob, oldTime + 5000);

			await redisClient.set(CURSOR_REDIS_KEY, beforeCursor.id);

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(1);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.map(n => n.id)).toEqual([beforeCursor.id]);
			expect(remainingNotes.map(n => n.id)).not.toContain(afterCursor.id);
		});

		test('should ignore a stored cursor that fell outside the target range', async () => {
			await createNote({}, bob, oldTimeBase());

			await redisClient.set(CURSOR_REDIS_KEY, idService.gen(Date.now()));

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(1);
		});

		test('should keep the cursor when the run is cut short before reaching the end', async () => {
			const AMOUNT = 250;
			const oldTime = oldTimeBase();
			for (let i = 0; i < AMOUNT; i++) {
				await createNote({}, bob, oldTime - i);
			}

			const job = createMockJob();
			let disabled = false;
			job.updateProgress = vi.fn(() => {
				if (!disabled) {
					meta.enableRemoteNotesCleaning = false;
					disabled = true;
				}
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBeGreaterThan(0);
			expect(result.deletedCount).toBeLessThan(AMOUNT);
			expect(result.cursor).not.toBe(null);
			expect(await redisClient.get(CURSOR_REDIS_KEY)).toBe(result.cursor);
		}, 30 * 1000);
	});

	describe('advanced - note_reaction', () => {
		test('should not delete note that is reacted by a local user', async () => {
			const job = createMockJob();

			const olderRemoteNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			await noteReactionsRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: olderRemoteNote.id,
				reaction: '👍',
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNote = await notesRepository.findOneBy({ id: olderRemoteNote.id });
			expect(remainingNote).not.toBeNull();
		});

		test('should delete note that is reacted only by remote users', async () => {
			const job = createMockJob();

			const olderRemoteNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			await noteReactionsRepository.save({
				id: idService.gen(),
				userId: carol.id,
				noteId: olderRemoteNote.id,
				reaction: '👍',
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(1);
			expect(result.skipped).toBe(false);

			const remainingNote = await notesRepository.findOneBy({ id: olderRemoteNote.id });
			expect(remainingNote).toBeNull();
		});

		test('should not delete note that has both local and remote reactions', async () => {
			const job = createMockJob();

			const olderRemoteNote = await createNote({}, bob, Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000);

			await noteReactionsRepository.save([
				{
					id: idService.gen(),
					userId: alice.id,
					noteId: olderRemoteNote.id,
					reaction: '👍',
				},
				{
					id: idService.gen(),
					userId: carol.id,
					noteId: olderRemoteNote.id,
					reaction: '❤️',
				},
			]);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNote = await notesRepository.findOneBy({ id: olderRemoteNote.id });
			expect(remainingNote).not.toBeNull();
		});

		test('should retain whole tree when root has local user reaction', async () => {
			const job = createMockJob();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			const root = await createNote({}, bob, oldTime);
			const reply = await createNote({ replyId: root.id }, carol, oldTime - 1000);

			await noteReactionsRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: root.id,
				reaction: '👍',
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === root.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === reply.id)).toBe(true);
		});

		test('should retain whole tree when a reply has a local user reaction', async () => {
			const job = createMockJob();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			const root = await createNote({}, bob, oldTime);
			const reply = await createNote({ replyId: root.id }, carol, oldTime - 1000);

			await noteReactionsRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: reply.id,
				reaction: '🎉',
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === root.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === reply.id)).toBe(true);
		});

		test('should delete whole tree when reactions are only from remote users', async () => {
			const job = createMockJob();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			const root = await createNote({}, bob, oldTime);
			const reply = await createNote({ replyId: root.id }, carol, oldTime - 1000);

			await noteReactionsRepository.save([
				{
					id: idService.gen(),
					userId: carol.id,
					noteId: root.id,
					reaction: '👍',
				},
				{
					id: idService.gen(),
					userId: bob.id,
					noteId: reply.id,
					reaction: '❤️',
				},
			]);

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(2);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === root.id)).toBe(false);
			expect(remainingNotes.some(n => n.id === reply.id)).toBe(false);
		});

		test('should retain a deep reply tree when the deepest reply has a local reaction', async () => {
			const job = createMockJob();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			const root = await createNote({}, bob, oldTime);
			const r1 = await createNote({ replyId: root.id }, carol, oldTime - 1000);
			const r2 = await createNote({ replyId: r1.id }, bob, oldTime - 2000);
			const r3 = await createNote({ replyId: r2.id }, carol, oldTime - 3000);

			await noteReactionsRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: r3.id,
				reaction: '👍',
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length).toBe(4);
		});

		test('should keep reacted notes and delete others in a mixed batch', async () => {
			const job = createMockJob();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			const deletables: MiNote[] = [];
			const protectedByLocalReaction: MiNote[] = [];
			for (let i = 0; i < 5; i++) {
				deletables.push(await createNote({}, bob, oldTime - i));
			}
			for (let i = 0; i < 5; i++) {
				const n = await createNote({}, carol, oldTime - 100 - i);
				await noteReactionsRepository.save({
					id: idService.gen(),
					userId: alice.id,
					noteId: n.id,
					reaction: '👍',
				});
				protectedByLocalReaction.push(n);
			}

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(5);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			deletables.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(false);
			});
			protectedByLocalReaction.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(true);
			});
		});
	});

	describe('advanced - maxDuration', () => {
		test('should stop processing when maxDuration is reached', async () => {
			meta.remoteNotesCleaningMaxProcessingDurationInMinutes = 0.00001;

			const AMOUNT = 250;
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			for (let i = 0; i < AMOUNT; i++) {
				await createNote({}, bob, oldTime - i);
			}

			const job = createMockJob();
			const result = await service.process(job as any);

			expect(result.skipped).toBe(false);
			expect(job.log).toHaveBeenCalledWith(expect.stringContaining('Reached maximum duration'));
			expect(job.updateProgress).toHaveBeenCalledWith(100);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length + result.deletedCount).toBe(AMOUNT);
		}, 30 * 1000);
	});

	describe('advanced - early return / dynamic config', () => {
		test('should early-return when no old root remote note exists (only new root with old descendants)', async () => {
			const job = createMockJob();
			const newTime = Date.now();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			const newRoot = await createNote({}, bob, newTime);
			const oldReply = await createNote({ replyId: newRoot.id }, carol, oldTime);

			const result = await service.process(job as any);

			expect(result).toEqual({
				deletedCount: 0,
				oldest: null,
				newest: null,
				cursor: null,
				skipped: false,
				transientErrors: 0,
			});

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.some(n => n.id === newRoot.id)).toBe(true);
			expect(remainingNotes.some(n => n.id === oldReply.id)).toBe(true);
		});

		test('should exit loop when all old root notes are unremovable', async () => {
			const job = createMockJob();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			for (let i = 0; i < 5; i++) {
				await createNote({ clippedCount: 1 }, bob, oldTime - i);
			}

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(0);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();
			expect(remainingNotes.length).toBe(5);
		});

		test('should stop processing when enableRemoteNotesCleaning is disabled mid-process', async () => {
			const AMOUNT = 250;
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;
			for (let i = 0; i < AMOUNT; i++) {
				await createNote({}, bob, oldTime - i);
			}

			const job = createMockJob();
			let disabledAt = -1;
			job.updateProgress = vi.fn(() => {
				if (disabledAt === -1) {
					meta.enableRemoteNotesCleaning = false;
					disabledAt = Date.now();
				}
			});

			const result = await service.process(job as any);

			expect(result.skipped).toBe(false);
			expect(result.deletedCount).toBeGreaterThan(0);
			expect(result.deletedCount).toBeLessThan(AMOUNT);
		}, 30 * 1000);
	});

	describe('advanced - chaos', () => {
		test('should respect every protection condition simultaneously', async () => {
			const job = createMockJob();
			const oldTime = Date.now() - ms(`${meta.remoteNotesCleaningExpiryDaysForEachNotes} days`) - 1000;

			const plainDeletable = await createNote({}, bob, oldTime);

			const favorited = await createNote({}, bob, oldTime - 1);
			await noteFavoritesRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: favorited.id,
			});

			const pinned = await createNote({}, bob, oldTime - 2);
			await userNotePiningsRepository.save({
				id: idService.gen(),
				userId: bob.id,
				noteId: pinned.id,
			});

			const clipped = await createNote({ clippedCount: 1 }, bob, oldTime - 3);

			const paged = await createNote({ pageCount: 1 }, bob, oldTime - 4);

			const reactedByLocal = await createNote({}, bob, oldTime - 5);
			await noteReactionsRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: reactedByLocal.id,
				reaction: '👍',
			});

			const reactedByRemote = await createNote({}, bob, oldTime - 6);
			await noteReactionsRepository.save({
				id: idService.gen(),
				userId: carol.id,
				noteId: reactedByRemote.id,
				reaction: '👍',
			});

			const localOldNote = await createNote({}, alice, oldTime - 7);

			const newRemoteNote = await createNote({}, bob);

			const oldRootWithNewReply = await createNote({}, carol, oldTime - 8);
			const newReplyOfOldRoot = await createNote({ replyId: oldRootWithNewReply.id }, bob);

			const oldTreeRoot = await createNote({}, bob, oldTime - 9);
			const oldTreeReply = await createNote({ replyId: oldTreeRoot.id }, carol, oldTime - 10);

			const protectedTreeRoot = await createNote({}, bob, oldTime - 11);
			const protectedTreeReply = await createNote({ replyId: protectedTreeRoot.id }, carol, oldTime - 12);
			await noteReactionsRepository.save({
				id: idService.gen(),
				userId: alice.id,
				noteId: protectedTreeReply.id,
				reaction: '✨',
			});

			const result = await service.process(job as any);

			expect(result.deletedCount).toBe(4);
			expect(result.skipped).toBe(false);

			const remainingNotes = await notesRepository.find();

			const expectDeleted = [plainDeletable, reactedByRemote, oldTreeRoot, oldTreeReply];
			const expectKept = [
				favorited, pinned, clipped, paged, reactedByLocal, localOldNote,
				newRemoteNote, oldRootWithNewReply, newReplyOfOldRoot,
				protectedTreeRoot, protectedTreeReply,
			];

			expectDeleted.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(false);
			});
			expectKept.forEach(n => {
				expect(remainingNotes.some(r => r.id === n.id)).toBe(true);
			});
		});
	});
});
