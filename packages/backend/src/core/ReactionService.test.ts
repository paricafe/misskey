/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { QueryFailedError } from 'typeorm';
import { ReactionService } from './ReactionService.js';

const actor = { id: 'actor', host: null, isBot: false };
const note = {
	id: 'note', userId: 'author', userHost: null, localOnly: false, visibility: 'public',
	reactionAcceptance: null, reactionAndUserPairCache: [], renoteId: null, replyId: null,
} as never;

function createService(reaction = '👍') {
	const record = { id: 'original-reaction', noteId: 'note', userId: 'actor', reaction };
	const repository = {
		insert: vi.fn().mockResolvedValue({}),
		findOneByOrFail: vi.fn().mockResolvedValue(record),
		findOneBy: vi.fn().mockResolvedValue(record),
		delete: vi.fn().mockResolvedValue({ affected: 1 }),
	};
	const buffering = { create: vi.fn(), delete: vi.fn() };
	const events = { publishNoteStream: vi.fn() };
	const notification = { createNotification: vi.fn() };
	const renderer = {
		renderLike: vi.fn().mockResolvedValue({ type: 'Like' }),
		renderUndo: vi.fn().mockReturnValue({ type: 'Undo' }),
		addContext: vi.fn(content => content),
	};
	const manager = { addFollowersRecipe: vi.fn(), execute: vi.fn().mockResolvedValue(undefined) };
	const service = new ReactionService(
		{ enableReactionsBuffering: true } as never,
		{} as never,
		{} as never,
		repository as never,
		{ exists: vi.fn().mockResolvedValue(false) } as never,
		{} as never,
		{} as never,
		{} as never,
		{} as never,
		{ isLocalUser: vi.fn().mockReturnValue(true) } as never,
		{ isVisibleForMe: vi.fn().mockResolvedValue(true) } as never,
		{ checkBlocked: vi.fn().mockResolvedValue(false) } as never,
		buffering as never,
		{ gen: vi.fn().mockReturnValue('new-reaction'), parse: vi.fn().mockReturnValue({ date: new Date(0) }) } as never,
		{} as never,
		events as never,
		renderer as never,
		{ createDeliverManager: vi.fn().mockReturnValue(manager) } as never,
		notification as never,
		{ update: vi.fn() } as never,
	);
	return { service, repository, buffering, events, notification, renderer, manager };
}

function duplicate() {
	return new QueryFailedError('insert', undefined, Object.assign(new Error('duplicate'), { code: '23505' }));
}

describe('ReactionService conditional writes', () => {
	test('preserves a concurrently created emoji when replacement is disabled', async () => {
		const { service, repository, buffering, events, notification } = createService();
		repository.insert.mockRejectedValueOnce(duplicate());
		await expect(service.create(actor, note, '❤', { replaceExisting: false })).rejects.toMatchObject({ id: '51c42bb4-931a-456b-bff7-e5a8a70dd298' });
		expect(repository.delete).not.toHaveBeenCalled();
		expect(repository.insert).toHaveBeenCalledOnce();
		expect(buffering.create).not.toHaveBeenCalled();
		expect(events.publishNoteStream).not.toHaveBeenCalled();
		expect(notification.createNotification).not.toHaveBeenCalled();
	});

	test('keeps native replacement behavior by default', async () => {
		const { service, repository, buffering } = createService();
		repository.insert.mockRejectedValueOnce(duplicate());
		const remove = vi.spyOn(service, 'delete').mockResolvedValueOnce(undefined);
		await service.create(actor, note, '❤');
		expect(remove).toHaveBeenCalledWith(actor, note);
		expect(repository.insert).toHaveBeenCalledTimes(2);
		expect(buffering.create).toHaveBeenCalledWith('note', 'actor', '❤');
	});

	test('a guarded new favourite still emits the native notification and federated Like', async () => {
		const { service, notification, renderer, manager } = createService();
		await service.create(actor, note, '❤', { replaceExisting: false });
		expect(notification.createNotification).toHaveBeenCalledWith('author', 'reaction', { noteId: 'note', reaction: '❤' }, 'actor');
		expect(renderer.renderLike).toHaveBeenCalledWith(expect.objectContaining({ reaction: '❤' }), note);
		expect(manager.addFollowersRecipe).toHaveBeenCalledOnce();
		expect(manager.execute).toHaveBeenCalledOnce();
	});

	test('conditional removal preserves a replacement emoji read after the favourite precheck', async () => {
		const { service, repository, buffering, events, renderer } = createService();
		await expect(service.delete(actor, note, '❤')).rejects.toMatchObject({ id: '60527ec9-b4cb-4a88-a6bd-32d3ad26817d' });
		expect(repository.delete).not.toHaveBeenCalled();
		expect(buffering.delete).not.toHaveBeenCalled();
		expect(events.publishNoteStream).not.toHaveBeenCalled();
		expect(renderer.renderUndo).not.toHaveBeenCalled();
	});

	test('conditional removal deletes only the selected reaction ID and emits Undo', async () => {
		const { service, repository, buffering, renderer, manager } = createService('❤');
		await service.delete(actor, note, '❤');
		expect(repository.delete).toHaveBeenCalledWith('original-reaction');
		expect(buffering.delete).toHaveBeenCalledWith('note', 'actor', '❤');
		expect(renderer.renderUndo).toHaveBeenCalledWith({ type: 'Like' }, actor);
		expect(manager.execute).toHaveBeenCalledOnce();
	});

	test('a concurrent delete and replacement after selection cannot decrement the new reaction', async () => {
		const { service, repository, buffering, events } = createService('❤');
		repository.delete.mockResolvedValueOnce({ affected: 0 });
		await expect(service.delete(actor, note, '❤')).rejects.toMatchObject({ id: '60527ec9-b4cb-4a88-a6bd-32d3ad26817d' });
		expect(repository.delete).toHaveBeenCalledWith('original-reaction');
		expect(buffering.delete).not.toHaveBeenCalled();
		expect(events.publishNoteStream).not.toHaveBeenCalled();
	});

	test('native removal still deletes any reaction when no expected value is provided', async () => {
		const { service, repository, buffering } = createService();
		await service.delete(actor, note);
		expect(repository.delete).toHaveBeenCalledWith('original-reaction');
		expect(buffering.delete).toHaveBeenCalledWith('note', 'actor', '👍');
	});
});
