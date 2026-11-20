/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { expect, test, vi } from 'vitest';
import { UserListChannel } from './user-list.js';

test('recovers failed list reads and drops stale results after changes or disposal', async () => {
	vi.useFakeTimers();
	const subscriber = new EventEmitter();
	const sendMessageToWs = vi.fn();
	const connection = {
		user: { id: 'owner' }, subscriber, sendMessageToWs,
		userIdsWhoMeMuting: new Set(), userIdsWhoBlockingMe: new Set(), mutingChannels: new Set(), userMutedInstances: new Set(),
		disconnectChannel: () => channel.dispose(),
	};
	const members = [{ userId: 'member', withReplies: true }];
	const find = vi.fn().mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValue(members);
	const channel = new UserListChannel(
		{ exists: async () => true } as never, { find } as never, { id: 'list', connection } as never,
		{ withMyRenoteReaction: async (note: unknown) => note } as never, { filter: async (note: unknown) => note } as never,
	);
	const note = { id: 'note', user: { id: 'member' }, userId: 'member', visibility: 'public' };
	const emitNote = async () => {
		subscriber.emit('notesStream', note);
		await vi.advanceTimersByTimeAsync(0);
	};
	const update = () => subscriber.emit('userListStream:list', { type: 'internalMembershipUpdated', body: { userId: 'member' } });

	try {
		expect(await channel.init({ listId: 'list' })).toBe(true);
		await emitNote();
		expect(sendMessageToWs).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		await emitNote();
		expect(sendMessageToWs).toHaveBeenCalledTimes(1);

		find.mockRejectedValueOnce(new Error('temporarily unavailable')).mockResolvedValueOnce([]);
		update();
		await emitNote();
		await vi.advanceTimersByTimeAsync(1000);
		await emitNote();
		expect(find).toHaveBeenCalledTimes(4);
		expect(sendMessageToWs).toHaveBeenCalledTimes(1);

		const pending = Promise.withResolvers<typeof members>();
		find.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([]);
		update();
		update();
		pending.resolve(members);
		await emitNote();
		expect(sendMessageToWs).toHaveBeenCalledTimes(1);

		find.mockRejectedValueOnce(new Error('temporarily unavailable'));
		update();
		await vi.advanceTimersByTimeAsync(0);
		subscriber.emit('userListStream:list', { type: 'internalListDeleted' });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(find).toHaveBeenCalledTimes(7);
		expect(subscriber.listenerCount('notesStream')).toBe(0);
	} finally {
		channel.dispose();
		vi.useRealTimers();
	}
});
