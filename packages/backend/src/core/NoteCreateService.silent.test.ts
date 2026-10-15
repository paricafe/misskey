/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import type { MiNote } from '@/models/Note.js';
import { NoteCreateService } from './NoteCreateService.js';

describe('follower note notifications', () => {
	function createService() {
		const followingsRepository = {
			findBy: vi.fn().mockResolvedValue([{ followerId: 'follower' }]),
		};
		const notificationService = { createNotification: vi.fn() };
		const service = Object.create(NoteCreateService.prototype) as NoteCreateService;
		Object.assign(service, {
			meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false },
			notesChart: { update: vi.fn() },
			perUserNotesChart: { update: vi.fn() },
			hashtagService: { updateHashtags: vi.fn() },
			antennaService: { addNoteToAntennas: vi.fn() },
			followingsRepository,
			notificationService,
		});
		// @bindThis methods are prototype getters, so stub them as own properties.
		for (const method of ['incNotesCountOfUser', 'pushToTl', 'index']) {
			Object.defineProperty(service, method, { value: vi.fn() });
		}
		const note = { id: 'note', userId: 'author', visibility: 'public' } as MiNote;
		const postNoteCreated = (silent: boolean) => service['postNoteCreated'](
			note,
			{ id: 'author', username: 'author', host: null, isBot: false, isCat: false },
			{ text: 'hello', visibility: 'public' },
			silent,
			[],
			[],
		);
		return { followingsRepository, notificationService, postNoteCreated };
	}

	test('does not notify followers about silently created notes such as imports', async () => {
		const { followingsRepository, notificationService, postNoteCreated } = createService();

		await postNoteCreated(true);

		expect(followingsRepository.findBy).not.toHaveBeenCalled();
		expect(notificationService.createNotification).not.toHaveBeenCalled();
	});

	test('notifies followers who enabled note notifications for ordinary notes', async () => {
		const { notificationService, postNoteCreated } = createService();
		// Only the follower path is stubbed; the later non-silent side effects may reject.
		await postNoteCreated(false).catch(() => {});

		await vi.waitFor(() => expect(notificationService.createNotification).toHaveBeenCalledWith('follower', 'note', { noteId: 'note' }, 'author'));
	});
});
