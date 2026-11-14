/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { describe, expect, test, vi } from 'vitest';
import Connection from './Connection.js';

async function setup(permissions: string[] | null, authenticated = true) {
	const readAllNotification = vi.fn().mockResolvedValue(undefined);
	const connection = new Connection({} as never, { readAllNotification } as never, {} as never, {} as never, {} as never, {} as never, {
		user: authenticated ? { id: 'alice' } : null,
		token: permissions ? { id: 'token', permission: permissions } : null,
	} as never);
	const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN as number, bufferedAmount: 0, send: vi.fn(), terminate: vi.fn() });
	await connection.listen(new EventEmitter(), socket as never);
	return { connection, socket, readAllNotification };
}

describe('streaming connection authorization', () => {
	test.each([
		{ permissions: ['read:account'], authenticated: true, expected: false },
		{ permissions: null, authenticated: false, expected: false },
		{ permissions: null, authenticated: true, expected: true },
		{ permissions: ['read:account', 'write:notifications'], authenticated: true, expected: true },
	])('marks notifications read only with write permission: $permissions / $authenticated', async ({ permissions, authenticated, expected }) => {
		const { connection, socket, readAllNotification } = await setup(permissions, authenticated);
		try {
			socket.emit('message', Buffer.from(JSON.stringify({ type: 'readNotification' })));
			await setImmediate();
			expect(readAllNotification).toHaveBeenCalledTimes(expected ? 1 : 0);
			expect(socket.terminate).not.toHaveBeenCalled();
		} finally {
			connection.dispose();
		}
	});

	test('handles notification storage failure without an unhandled rejection', async () => {
		const { connection, socket, readAllNotification } = await setup(null);
		try {
			readAllNotification.mockRejectedValue(new Error('redis unavailable'));
			socket.emit('message', Buffer.from(JSON.stringify({ type: 'readNotification' })));
			await setImmediate();
			expect(socket.terminate).toHaveBeenCalledOnce();
		} finally {
			connection.dispose();
		}
	});

	test('drops an event that finishes packing after the socket was revoked', async () => {
		const { connection, socket } = await setup(null);
		try {
			const pending = Promise.resolve().then(() => connection.sendMessageToWs('channel', { id: 'a', type: 'note', body: { text: 'private' } }));
			socket.readyState = WebSocket.CLOSING;
			await pending;
			expect(socket.send).not.toHaveBeenCalled();
		} finally {
			connection.dispose();
		}
	});
});
