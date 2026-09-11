/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { PostScheduledNoteProcessorService } from './PostScheduledNoteProcessorService.js';

describe(PostScheduledNoteProcessorService, () => {
	function createService() {
		const draft = { id: 'draft', userId: 'author', user: { id: 'author' }, scheduledAt: 1, isActuallyScheduled: true, fileIds: [], text: 'Scheduled', hasPoll: false, visibility: 'public' };
		const drafts = { findOne: vi.fn().mockResolvedValue(draft), remove: vi.fn() };
		const notes = { fetchAndCreate: vi.fn().mockResolvedValue({ id: 'posted-note' }) };
		const notifications = { createNotification: vi.fn() };
		const service = new PostScheduledNoteProcessorService(drafts as never, notes as never, notifications as never, { logger: { createSubLogger: vi.fn() } } as never);
		return { service, draft, drafts, notes, notifications };
	}

	test('posts native drafts with unchanged native parameters', async () => {
		const { service, notes, notifications, drafts } = createService();
		await service.process({ data: { noteDraftId: 'draft' } } as never);
		expect(notes.fetchAndCreate).toHaveBeenCalledWith({ id: 'author' }, expect.objectContaining({ text: 'Scheduled', visibility: 'public', fileIds: [] }));
		expect(notes.fetchAndCreate.mock.calls[0]?.[1]).not.toHaveProperty('language');
		expect(drafts.remove).toHaveBeenCalledOnce();
		expect(notifications.createNotification).toHaveBeenCalledWith('author', 'scheduledNotePosted', { noteId: 'posted-note' });
	});

	test('keeps the draft when publication fails', async () => {
		const { service, notes, drafts, notifications } = createService();
		notes.fetchAndCreate.mockRejectedValue(new Error('Native publication failed'));
		await service.process({ data: { noteDraftId: 'draft' } } as never);
		expect(drafts.remove).not.toHaveBeenCalled();
		expect(notifications.createNotification).toHaveBeenCalledWith('author', 'scheduledNotePostFailed', { noteDraftId: 'draft' });
	});
});
