/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { describe, expect, test, vi } from 'vitest';
import { subscribeInternalEvent, subscribeRedisMessage } from './redis-pubsub-bus.js';

describe('redis-pubsub-bus', () => {
	test('parses each Redis message once across multiple general and internal subscribers', () => {
		const emitter = new EventEmitter();
		const parseSpy = vi.spyOn(JSON, 'parse');
		const generalA = vi.fn();
		const generalB = vi.fn();
		const internalA = vi.fn();
		const internalB = vi.fn();

		const unsubs = [
			subscribeRedisMessage(emitter, generalA),
			subscribeRedisMessage(emitter, generalB),
			subscribeInternalEvent(emitter, internalA),
			subscribeInternalEvent(emitter, internalB),
		];

		expect(emitter.listenerCount('message')).toBe(1);

		const internalPayload = JSON.stringify({
			channel: 'internal',
			message: { type: 'metaUpdated', body: { name: 'test' } },
		});
		emitter.emit('message', 'host', internalPayload);

		expect(parseSpy).toHaveBeenCalledTimes(1);
		expect(generalA).toHaveBeenCalledOnce();
		expect(generalB).toHaveBeenCalledOnce();
		expect(internalA).toHaveBeenCalledWith({ type: 'metaUpdated', body: { name: 'test' } });
		expect(internalB).toHaveBeenCalledWith({ type: 'metaUpdated', body: { name: 'test' } });

		parseSpy.mockClear();
		const notePayload = JSON.stringify({
			channel: 'globalTimeline',
			message: { id: 'note-1' },
		});
		emitter.emit('message', 'host', notePayload);

		expect(parseSpy).toHaveBeenCalledTimes(1);
		expect(generalA).toHaveBeenCalledTimes(2);
		expect(internalA).toHaveBeenCalledTimes(1);

		for (const unsub of unsubs) unsub();
		expect(emitter.listenerCount('message')).toBe(0);
		parseSpy.mockRestore();
	});

	test('returns a combined promise when any subscriber is async and detaches after full cleanup', async () => {
		const emitter = new EventEmitter();
		const order: string[] = [];

		const unsub1 = subscribeInternalEvent(emitter, async () => {
			await Promise.resolve();
			order.push('async-1');
		});
		const unsub2 = subscribeRedisMessage(emitter, () => {
			order.push('sync');
		});

		const listeners = emitter.listeners('message') as Array<(channel: string, data: string) => void | Promise<void>>;
		expect(listeners).toHaveLength(1);

		const maybePromise = listeners[0]('host', JSON.stringify({
			channel: 'internal',
			message: { type: 'userChangeFollowing', body: {} },
		}));
		expect(maybePromise).toBeInstanceOf(Promise);
		await maybePromise;
		expect(order).toEqual(['sync', 'async-1']);

		unsub1();
		expect(emitter.listenerCount('message')).toBe(1);
		unsub2();
		expect(emitter.listenerCount('message')).toBe(0);
	});
});
