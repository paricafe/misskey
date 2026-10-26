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
			userEntityService: { isLocalUser: () => true },
		});
		// @bindThis methods are prototype getters, so stub them as own properties.
		for (const method of ['incNotesCountOfUser', 'pushToTl', 'index']) {
			Object.defineProperty(service, method, { value: vi.fn() });
		}
		Object.defineProperty(service, 'deliverNote', { value: vi.fn().mockResolvedValue(undefined) });
		const note = { id: 'note', userId: 'author', visibility: 'public' } as MiNote;
		const postNoteCreated = (silent: boolean) => service['postNoteCreated'](
			note,
			{ id: 'author', username: 'author', host: null, isBot: false },
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

describe('federation of created notes', () => {
	function createService() {
		const deliverNote = vi.fn().mockResolvedValue(undefined);
		const logger = { error: vi.fn() };
		const service = Object.create(NoteCreateService.prototype) as NoteCreateService;
		Object.assign(service, {
			meta: { enableChartsForRemoteUser: false, enableStatsForFederatedInstances: false },
			notesChart: { update: vi.fn() },
			perUserNotesChart: { update: vi.fn() },
			hashtagService: { updateHashtags: vi.fn() },
			antennaService: { addNoteToAntennas: vi.fn().mockResolvedValue([]) },
			followingsRepository: { findBy: vi.fn().mockResolvedValue([]) },
			userEntityService: {
				isLocalUser: (user: { host: string | null }) => user.host == null,
				isRemoteUser: (user: { host: string | null }) => user.host != null,
			},
			globalEventService: { publishNoteStream: vi.fn(), publishNotesStream: vi.fn() },
			noteEntityService: { pack: vi.fn().mockResolvedValue({}) },
			roleService: { addNoteToRoleTimeline: vi.fn() },
			webhookService: { enqueueUserWebhook: vi.fn() },
			activeUsersChart: { write: vi.fn() },
			logger,
		});
		for (const method of ['incNotesCountOfUser', 'pushToTl', 'index', 'createMentionedEvents']) {
			Object.defineProperty(service, method, { value: vi.fn() });
		}
		Object.defineProperty(service, 'deliverNote', { value: deliverNote });
		const incrementReplyCountAndPublish = vi.fn().mockRejectedValue(new Error('database is unavailable'));
		Object.defineProperty(service, 'incrementReplyCountAndPublish', { value: incrementReplyCountAndPublish });

		const note = { id: 'note', userId: 'author', visibility: 'public' } as MiNote;
		const reply = { id: 'reply', userId: 'remote', userHost: 'remote.example' } as MiNote;
		const postNoteCreated = (data: Record<string, unknown>, silent = false) => service['postNoteCreated'](
			note,
			{ id: 'author', username: 'author', host: null, isBot: false },
			{ text: 'hello', visibility: 'public', reply, ...data },
			silent,
			[],
			[],
		);
		return { service, deliverNote, logger, note, postNoteCreated };
	}

	test('starts delivery before a failing reply counter and logs the counter failure', async () => {
		const { deliverNote, logger, note, postNoteCreated } = createService();

		await postNoteCreated({});

		expect(deliverNote).toHaveBeenCalledOnce();
		expect(deliverNote.mock.calls[0]?.[0]).toBe(note);
		expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
			attributes: { noteId: 'note', stage: 'repliesCount' },
		}));
	});

	test('logs a failed delivery with the note id instead of rejecting', async () => {
		const { deliverNote, logger, postNoteCreated } = createService();
		deliverNote.mockRejectedValueOnce(new Error('enqueue failed'));

		await postNoteCreated({});

		await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
			attributes: { noteId: 'note', stage: 'deliver' },
		})));
	});

	test.each([
		['silent notes', {}, true],
		['local-only notes', { localOnly: true }, false],
	])('does not deliver %s', async (_label, data, silent) => {
		const { deliverNote, postNoteCreated } = createService();

		await postNoteCreated(data, silent);

		expect(deliverNote).not.toHaveBeenCalled();
	});

	test('waits for the deliver manager and keeps it running when relay delivery fails', async () => {
		const { service, logger, note } = createService();
		const dm = { addDirectRecipe: vi.fn(), addFollowersRecipe: vi.fn(), execute: vi.fn().mockResolvedValue(undefined) };
		Object.assign(service, {
			apDeliverManagerService: { createDeliverManager: vi.fn().mockReturnValue(dm) },
			relayService: { deliverToRelays: vi.fn().mockRejectedValue(new Error('relay is down')) },
		});
		Object.defineProperty(service, 'renderNoteOrRenoteActivity', { value: vi.fn().mockResolvedValue({ type: 'Create' }) });

		// The service fixture stubs deliverNote, so call the real method from the prototype.
		await NoteCreateService.prototype['deliverNote'].call(service, note, { id: 'author', host: null }, { visibility: 'public' }, []);

		expect(dm.addFollowersRecipe).toHaveBeenCalledOnce();
		expect(dm.execute).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
			attributes: { noteId: 'note', stage: 'relay' },
		})));
	});

	test('skips a mention whose muting state cannot be read and still notifies the other mentioned users', async () => {
		const { service, logger, note } = createService();
		const isMutedByRecipient = vi.fn()
			.mockRejectedValueOnce(new Error('redis is unavailable'))
			.mockResolvedValueOnce(false);
		Object.defineProperty(service, 'isMutedByRecipient', { value: isMutedByRecipient });
		const nm = { push: vi.fn() };
		Object.assign(service, { globalEventService: { publishMainStream: vi.fn() } });

		await NoteCreateService.prototype['createMentionedEvents'].call(service, [
			{ id: 'muting-unknown', host: null },
			{ id: 'mentioned', host: null },
		] as never, note, nm as never);

		expect(nm.push).toHaveBeenCalledOnce();
		expect(nm.push).toHaveBeenCalledWith('mentioned', 'mention');
		expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
			attributes: { noteId: 'note', stage: 'mentionNotification' },
		}));
	});
});
