/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { ScheduledNoteNotReadyError } from '@/core/NoteCreateService.js';
import { PostScheduledNoteProcessorService } from './PostScheduledNoteProcessorService.js';

describe(PostScheduledNoteProcessorService, () => {
	function createService() {
		const draft = { id: 'draft', userId: 'author', user: { id: 'author' }, scheduledAt: new Date(1), scheduleRevision: 3, isActuallyScheduled: true, fileIds: [], text: 'Scheduled', hasPoll: false, visibility: 'public' };
		const drafts = { findOne: vi.fn().mockResolvedValue(draft), update: vi.fn().mockResolvedValue({ affected: 1 }) };
		const notes = { fetchAndCreate: vi.fn().mockResolvedValue({ id: 'posted-note' }) };
		const notifications = { createNotification: vi.fn() };
		const scheduling = { recoverSchedules: vi.fn() };
		const service = new PostScheduledNoteProcessorService(drafts as never, notes as never, notifications as never, { logger: { createSubLogger: vi.fn() } } as never, scheduling as never);
		const job = { data: { noteDraftId: 'draft', scheduleRevision: 3 } };
		return { service, draft, drafts, notes, notifications, scheduling, job };
	}

	test('posts through atomic draft consumption with unchanged native content', async () => {
		const { service, notes, notifications, job } = createService();
		await service.process(job as never);
		expect(notes.fetchAndCreate).toHaveBeenCalledWith({ id: 'author' }, expect.objectContaining({ scheduledDraft: { id: 'draft', revision: 3 }, text: 'Scheduled', visibility: 'public', fileIds: [] }));
		expect(notes.fetchAndCreate.mock.calls[0]?.[1]).not.toHaveProperty('language');
		expect(notifications.createNotification).toHaveBeenCalledWith('author', 'scheduledNotePosted', { noteId: 'posted-note' });
	});

	test('keeps invalid content as an unscheduled draft', async () => {
		const { service, notes, drafts, notifications, job } = createService();
		notes.fetchAndCreate.mockRejectedValue(new IdentifiableError('invalid-content'));
		await service.process(job as never);
		expect(drafts.update).toHaveBeenCalledWith({ id: 'draft', scheduleRevision: 3, isActuallyScheduled: true }, { isActuallyScheduled: false });
		expect(notifications.createNotification).toHaveBeenCalledWith('author', 'scheduledNotePostFailed', { noteDraftId: 'draft' });
	});

	test('ignores stale, cancelled, missing and not-yet-due drafts', async () => {
		for (const value of [null, { isActuallyScheduled: false }, { scheduleRevision: 4 }, { scheduledAt: new Date(Date.now() + 60_000) }]) {
			const { service, draft, drafts, notes, job } = createService();
			drafts.findOne.mockResolvedValue(value === null ? null : { ...draft, ...value });
			await service.process(job as never);
			expect(notes.fetchAndCreate).not.toHaveBeenCalled();
		}
	});

	test('legacy jobs can only consume an unchanged revision-zero draft', async () => {
		const { service, draft, notes } = createService();
		await service.process({ data: { noteDraftId: 'draft' } } as never);
		expect(notes.fetchAndCreate).not.toHaveBeenCalled();
		draft.scheduleRevision = 0;
		await service.process({ data: { noteDraftId: 'draft' } } as never);
		expect(notes.fetchAndCreate).toHaveBeenCalledOnce();
	});

	test('rethrows infrastructure failures for retry without marking publication failed', async () => {
		const { service, notes, drafts, notifications, job } = createService();
		notes.fetchAndCreate.mockRejectedValue(new Error('Database disconnected'));
		await expect(service.process(job as never)).rejects.toThrow('Database disconnected');
		expect(drafts.update).not.toHaveBeenCalled();
		expect(notifications.createNotification).not.toHaveBeenCalled();
	});

	test('does not report failure when the transaction detects another edit or publication', async () => {
		const { service, notes, drafts, notifications, job } = createService();
		notes.fetchAndCreate.mockRejectedValue(new ScheduledNoteNotReadyError());
		await service.process(job as never);
		expect(drafts.update).not.toHaveBeenCalled();
		expect(notifications.createNotification).not.toHaveBeenCalled();
	});

	test('does not convert a success-notification failure into a failed publication', async () => {
		const { service, drafts, notifications, job } = createService();
		notifications.createNotification.mockRejectedValue(new Error('Notification unavailable'));
		await expect(service.process(job as never)).rejects.toThrow('Notification unavailable');
		expect(drafts.update).not.toHaveBeenCalled();
		expect(notifications.createNotification).toHaveBeenCalledTimes(1);
	});

	test('runs persistent schedule recovery', async () => {
		const { service, scheduling } = createService();
		await service.recover();
		expect(scheduling.recoverSchedules).toHaveBeenCalledOnce();
	});
});
