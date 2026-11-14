/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatRoomChannel } from './chat-room.js';

function setup() {
	const subscriber = new EventEmitter();
	const sendMessageToWs = vi.fn();
	const permission = vi.fn().mockResolvedValue(true);
	const readRoomChatMessage = vi.fn();
	const disconnectChannel = vi.fn(() => channel.dispose());
	const room = { id: 'room', ownerId: 'owner' };
	const channel = new ChatRoomChannel(
		{ id: 'channel', connection: { user: { id: 'alice' }, subscriber, sendMessageToWs, disconnectChannel } } as never,
		{ findOneBy: vi.fn().mockResolvedValue(room) } as never,
		{ hasPermissionToViewRoomTimeline: permission, readRoomChatMessage } as never,
	);
	return { channel, subscriber, sendMessageToWs, permission, readRoomChatMessage, disconnectChannel };
}

const message = { type: 'message', body: { text: 'private' } };
const left = { type: 'chatRoomMemberLeft', body: { userId: 'alice', roomId: 'room' } };

afterEach(() => vi.useRealTimers());

describe('chat room streaming authorization', () => {
	test('drops an in-flight message after leaving and removes the subscription', async () => {
		const { channel, subscriber, sendMessageToWs, readRoomChatMessage, disconnectChannel } = setup();
		try {
			expect(await channel.init({ roomId: 'room' })).toBe(true);
			subscriber.emit('chatRoomStream:room', message);
			subscriber.emit('chatRoomMembership:room:alice', left);
			await Promise.resolve();
			expect(sendMessageToWs).not.toHaveBeenCalled();
			expect(subscriber.listenerCount('chatRoomStream:room')).toBe(0);
			expect(subscriber.listenerCount('chatRoomMembership:room:alice')).toBe(0);
			expect(disconnectChannel).toHaveBeenCalledExactlyOnceWith('channel');
			await channel.onMessage('read', {});
			expect(readRoomChatMessage).not.toHaveBeenCalled();
		} finally {
			channel.dispose();
		}
	});

	test('does not install a subscription after a concurrent leave during init', async () => {
		const { channel, subscriber, sendMessageToWs, permission } = setup();
		let resolve!: (allowed: boolean) => void;
		permission.mockImplementation(() => new Promise<boolean>(done => { resolve = done; }));
		try {
			const initialized = channel.init({ roomId: 'room' });
			await vi.waitFor(() => expect(permission).toHaveBeenCalledOnce());
			subscriber.emit('chatRoomMembership:room:alice', left);
			resolve(true);
			expect(await initialized).toBe(false);
			subscriber.emit('chatRoomStream:room', message);
			expect(sendMessageToWs).not.toHaveBeenCalled();
			expect(subscriber.listenerCount('chatRoomStream:room')).toBe(0);
		} finally {
			channel.dispose();
		}
	});

	test('refreshes missed membership changes without querying for every message', async () => {
		vi.useFakeTimers();
		const { channel, subscriber, sendMessageToWs, permission } = setup();
		try {
			await channel.init({ roomId: 'room' });
			for (let i = 0; i < 100; i++) subscriber.emit('chatRoomStream:room', message);
			await Promise.resolve();
			expect(sendMessageToWs).toHaveBeenCalledTimes(100);
			expect(permission).toHaveBeenCalledOnce();
			permission.mockResolvedValue(false);
			await vi.advanceTimersByTimeAsync(10_000);
			subscriber.emit('chatRoomStream:room', message);
			expect(sendMessageToWs).toHaveBeenCalledTimes(100);
			expect(subscriber.listenerCount('chatRoomStream:room')).toBe(0);
		} finally {
			channel.dispose();
		}
	});

	test('fails closed when the permission refresh fails', async () => {
		vi.useFakeTimers();
		const { channel, subscriber, sendMessageToWs, permission } = setup();
		try {
			await channel.init({ roomId: 'room' });
			permission.mockRejectedValue(new Error('database unavailable'));
			await vi.advanceTimersByTimeAsync(10_000);
			subscriber.emit('chatRoomStream:room', message);
			expect(sendMessageToWs).not.toHaveBeenCalled();
			expect(subscriber.listenerCount('chatRoomMembership:room:alice')).toBe(0);
		} finally {
			channel.dispose();
		}
	});

	test('preserves the service permission decision for moderator access', async () => {
		const { channel, subscriber, sendMessageToWs, permission } = setup();
		try {
			await channel.init({ roomId: 'room' });
			expect(permission).toHaveBeenCalledWith('alice', { id: 'room', ownerId: 'owner' });
			subscriber.emit('chatRoomMembership:room:alice', { ...left, body: { roomId: 'room', userId: 'someone-else' } });
			subscriber.emit('chatRoomStream:room', message);
			await Promise.resolve();
			expect(sendMessageToWs).toHaveBeenCalledOnce();
		} finally {
			channel.dispose();
		}
	});
});
