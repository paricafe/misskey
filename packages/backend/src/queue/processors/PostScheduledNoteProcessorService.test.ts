/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { PostScheduledNoteProcessorService } from './PostScheduledNoteProcessorService.js';

describe(PostScheduledNoteProcessorService, () => {
	function createService(metadata: object | null) {
		const draft = { id: 'draft', userId: 'author', user: { id: 'author' }, scheduledAt: 1, isActuallyScheduled: true, fileIds: [], text: 'Scheduled', hasPoll: false, visibility: 'public' };
		const drafts = { findOne: vi.fn().mockResolvedValue(draft), remove: vi.fn() };
		const notes = { fetchAndCreate: vi.fn().mockResolvedValue({ id: 'posted-note' }) };
		const notifications = { createNotification: vi.fn() };
		const state = { get: vi.fn().mockResolvedValue(metadata == null ? null : { value: metadata }), put: vi.fn(), delete: vi.fn() };
		const redis = { set: vi.fn().mockResolvedValue('OK'), eval: vi.fn().mockResolvedValue(1) };
		const service = new PostScheduledNoteProcessorService(drafts as never, notes as never, notifications as never, { logger: { createSubLogger: vi.fn() } } as never, state as never, redis as never);
		return { service, draft, drafts, notes, notifications, state, redis };
	}

	test('posts native drafts with unchanged native parameters and without acquiring a compatibility lock', async () => {
		const { service, notes, notifications, redis, state } = createService(null);
		await service.process({ data: { noteDraftId: 'draft' } } as never);
		expect(notes.fetchAndCreate).toHaveBeenCalledWith({ id: 'author' }, expect.objectContaining({ text: 'Scheduled', visibility: 'public', fileIds: [] }));
		expect(notes.fetchAndCreate.mock.calls[0]?.[1]).not.toHaveProperty('language');
		expect(state.put).not.toHaveBeenCalled();
		expect(redis.set).not.toHaveBeenCalled();
		expect(notifications.createNotification).toHaveBeenCalledWith('author', 'scheduledNotePosted', { noteId: 'posted-note' });
	});

	test('transfers compatibility metadata before releasing the streaming barrier', async () => {
		const { service, state, redis, drafts, notifications } = createService({ language: 'ja', sensitive: true });
		await service.process({ data: { noteDraftId: 'draft' } } as never);
		expect(redis.set).toHaveBeenCalledWith('lock:mastodon-status-write:author', expect.any(String), 'PX', 30_000, 'NX');
		expect(state.put).toHaveBeenCalledWith({ userId: 'author', kind: 'status_metadata', key: 'posted-note', value: { language: 'ja', sensitive: true } });
		expect(state.delete).toHaveBeenCalledWith('author', 'status_metadata', 'draft');
		expect(state.put.mock.invocationCallOrder[0]).toBeLessThan(redis.eval.mock.invocationCallOrder[0]!);
		expect(drafts.remove).toHaveBeenCalledOnce();
		expect(notifications.createNotification).toHaveBeenCalledWith('author', 'scheduledNotePosted', { noteId: 'posted-note' });
	});

	test('keeps draft metadata and releases the barrier when native publication fails', async () => {
		const { service, state, redis, notes, drafts, notifications } = createService({ language: 'ja' });
		notes.fetchAndCreate.mockRejectedValue(new Error('Native publication failed'));
		await service.process({ data: { noteDraftId: 'draft' } } as never);
		expect(state.put).not.toHaveBeenCalled();
		expect(state.delete).not.toHaveBeenCalled();
		expect(drafts.remove).not.toHaveBeenCalled();
		expect(redis.eval).toHaveBeenCalledOnce();
		expect(notifications.createNotification).toHaveBeenCalledWith('author', 'scheduledNotePostFailed', { noteDraftId: 'draft' });
	});
});
