/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MiNote } from '@/models/Note.js';
import { MiNoteDraft } from '@/models/NoteDraft.js';
import { MiPoll } from '@/models/Poll.js';
import { NoteCreateService, ScheduledNoteNotReadyError } from './NoteCreateService.js';

describe('atomic scheduled note publication', () => {
	function createService() {
		const draft = { id: 'draft', userId: 'author', scheduleRevision: 2, scheduledAt: new Date(1), isActuallyScheduled: true };
		const manager = { findOne: vi.fn().mockResolvedValue(draft), insert: vi.fn(), delete: vi.fn() };
		const transaction = vi.fn(async (work) => work(manager));
		const notes = { insert: vi.fn() };
		const service = Object.create(NoteCreateService.prototype) as NoteCreateService;
		Object.assign(service, { db: { transaction }, notesRepository: notes, idService: { gen: () => 'note' } });
		const data = { scheduledDraft: { id: 'draft', revision: 2 }, text: 'Scheduled', visibility: 'public' };
		const publish = (options = data) => service['insertNote']({ id: 'author', host: null }, options, [], [], []);
		return { draft, manager, transaction, notes, service, data, publish };
	}

	test('locks and revalidates the draft before inserting the note and deleting its scheduling record', async () => {
		const { manager, notes, publish } = createService();
		await expect(publish()).resolves.toMatchObject({ id: 'note' });
		expect(manager.findOne).toHaveBeenCalledWith(MiNoteDraft, { where: { id: 'draft', userId: 'author' }, lock: { mode: 'pessimistic_write' } });
		expect(manager.insert).toHaveBeenCalledWith(MiNote, expect.objectContaining({ id: 'note' }));
		expect(manager.delete).toHaveBeenCalledWith(MiNoteDraft, { id: 'draft' });
		expect(manager.findOne.mock.invocationCallOrder[0]).toBeLessThan(manager.insert.mock.invocationCallOrder[0]);
		expect(manager.insert.mock.invocationCallOrder[0]).toBeLessThan(manager.delete.mock.invocationCallOrder[0]);
		expect(notes.insert).not.toHaveBeenCalled();
	});

	test('ignores a draft cancelled, edited, postponed or consumed during content preparation', async () => {
		for (const changed of [null, { isActuallyScheduled: false }, { scheduleRevision: 3 }, { scheduledAt: new Date(Date.now() + 60_000) }]) {
			const { draft, manager, publish } = createService();
			manager.findOne.mockResolvedValue(changed === null ? null : { ...draft, ...changed });
			await expect(publish()).rejects.toBeInstanceOf(ScheduledNoteNotReadyError);
			expect(manager.insert).not.toHaveBeenCalled();
			expect(manager.delete).not.toHaveBeenCalled();
		}
	});

	test('commits the poll and note with the draft deletion in the same transaction', async () => {
		const { service, data, manager, transaction } = createService();
		await service['insertNote']({ id: 'author', host: null }, {
			...data,
			poll: { choices: ['A', 'B'], multiple: false, expiresAt: null },
		}, [], [], []);
		expect(transaction).toHaveBeenCalledOnce();
		expect(manager.insert).toHaveBeenNthCalledWith(2, MiPoll, expect.objectContaining({ noteId: 'note', choices: ['A', 'B'] }));
		expect(manager.insert.mock.invocationCallOrder[1]).toBeLessThan(manager.delete.mock.invocationCallOrder[0]);
	});

	test('does not acknowledge publication until the database commit completes', async () => {
		const { transaction, manager, publish } = createService();
		let commit!: () => void;
		transaction.mockImplementation(async (work) => {
			await work(manager);
			await new Promise<void>(resolve => { commit = resolve; });
		});
		const completed = vi.fn();
		const publishing = publish().then(completed);
		await vi.waitFor(() => expect(manager.delete).toHaveBeenCalledOnce());
		expect(completed).not.toHaveBeenCalled();
		commit();
		await publishing;
		expect(completed).toHaveBeenCalledOnce();
	});

	test('propagates a failed terminal write so the transaction rolls back for retry', async () => {
		const { manager, publish } = createService();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		manager.delete.mockRejectedValue(new Error('Delete failed'));
		await expect(publish()).rejects.toThrow('Delete failed');
	});

	test('preserves the ordinary non-poll note insertion path', async () => {
		const { service, notes, transaction } = createService();
		await service['insertNote']({ id: 'author', host: null }, { visibility: 'public' }, [], [], []);
		expect(notes.insert).toHaveBeenCalledOnce();
		expect(transaction).not.toHaveBeenCalled();
	});
});
