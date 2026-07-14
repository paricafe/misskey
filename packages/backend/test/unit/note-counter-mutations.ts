/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import type { MiNote } from '@/models/Note.js';

const replyTarget = { id: 'reply-target', userId: 'target-author' } as MiNote;
const reply = {
	id: 'reply',
	userId: 'reply-author',
	replyId: replyTarget.id,
	renoteId: null,
} as MiNote;
const replyAuthor = {
	id: reply.userId,
	isBot: false,
};

describe('note counter mutations', () => {
	test.each([
		[0, false],
		[1, true],
	] as const)('reply creation reports affected=%i as %s', async (affected, expected) => {
		const service = Object.create(NoteCreateService.prototype) as NoteCreateService;
		const increment = vi.fn().mockResolvedValue({ affected });
		Object.assign(service, { notesRepository: { increment } });

		await expect(service['saveReply'](replyTarget)).resolves.toBe(expected);
	});

	test('renote creation reports a missing target without updating rankings', async () => {
		const service = Object.create(NoteCreateService.prototype) as NoteCreateService;
		const execute = vi.fn().mockResolvedValue({ affected: 0 });
		const where = vi.fn().mockReturnValue({ execute });
		const set = vi.fn().mockReturnValue({ where });
		const update = vi.fn().mockReturnValue({ set });
		const createQueryBuilder = vi.fn().mockReturnValue({ update });
		const updateGlobalNotesRanking = vi.fn();
		Object.assign(service, {
			notesRepository: { createQueryBuilder },
			featuredService: { updateGlobalNotesRanking },
		});

		await expect(service['incRenoteCount'](replyTarget)).resolves.toBe(false);
		expect(updateGlobalNotesRanking).not.toHaveBeenCalled();
	});

	test('creation does not publish count events when target updates affect no rows', async () => {
		const service = Object.create(NoteCreateService.prototype) as NoteCreateService;
		const increment = vi.fn().mockResolvedValue({ affected: 0 });
		const execute = vi.fn().mockResolvedValue({ affected: 0 });
		const where = vi.fn().mockReturnValue({ execute });
		const set = vi.fn().mockReturnValue({ where });
		const update = vi.fn().mockReturnValue({ set });
		const createQueryBuilder = vi.fn().mockReturnValue({ update });
		const publishNoteStream = vi.fn();
		Object.assign(service, {
			notesRepository: { increment, createQueryBuilder },
			globalEventService: { publishNoteStream },
			featuredService: { updateGlobalNotesRanking: vi.fn() },
		});

		await service['incrementReplyCountAndPublish'](replyTarget);
		await service['incrementRenoteCountAndPublish'](replyTarget);

		expect(publishNoteStream).not.toHaveBeenCalled();
	});

	test('only the affected delete decrements its reply target', async () => {
		const service = Object.create(NoteDeleteService.prototype) as NoteDeleteService;
		const deleteResult = vi.fn()
			.mockResolvedValueOnce({ affected: 1 })
			.mockResolvedValueOnce({ affected: 0 });
		const decrement = vi.fn().mockResolvedValue({ affected: 1 });
		const manager = { delete: deleteResult, decrement };
		const transaction = vi.fn(async (callback: (entityManager: typeof manager) => unknown) => callback(manager));
		Object.assign(service, { db: { transaction } });

		const first = await service['deleteNoteAndUpdateCounters'](replyAuthor, reply, replyTarget, null);
		const duplicate = await service['deleteNoteAndUpdateCounters'](replyAuthor, reply, replyTarget, null);

		expect(first).toMatchObject({ deleted: true, replyCountChanged: true });
		expect(duplicate).toMatchObject({ deleted: false, replyCountChanged: false });
		expect(decrement).toHaveBeenCalledTimes(1);
	});

	test('does not mark a missing reply target as changed or publishable', async () => {
		const service = Object.create(NoteDeleteService.prototype) as NoteDeleteService;
		const manager = {
			delete: vi.fn().mockResolvedValue({ affected: 1 }),
			decrement: vi.fn().mockResolvedValue({ affected: 0 }),
		};
		const transaction = vi.fn(async (callback: (entityManager: typeof manager) => unknown) => callback(manager));
		Object.assign(service, { db: { transaction } });

		const result = await service['deleteNoteAndUpdateCounters'](replyAuthor, reply, replyTarget, null);

		expect(result).toMatchObject({
			deleted: true,
			replyCountChanged: false,
			childTargetIds: [],
		});
	});
});
