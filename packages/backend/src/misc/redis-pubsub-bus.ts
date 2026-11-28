/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { EventEmitter } from 'node:events';
import type { GlobalEvents } from '@/core/GlobalEventService.js';

export type ParsedRedisMessage = {
	channel: string;
	message: unknown;
};

type MessageHandler = (parsed: ParsedRedisMessage) => void | Promise<void>;
type InternalEventHandler = (event: GlobalEvents['internal']['payload']) => void | Promise<void>;

type RedisSubscriberLike = Pick<EventEmitter, 'on' | 'off'>;

type BusState = {
	rawListener: (_channel: string, data: string) => void | Promise<void>;
	messageHandlers: Set<MessageHandler>;
	internalHandlers: Set<InternalEventHandler>;
};

const buses = new WeakMap<RedisSubscriberLike, BusState>();

function getOrCreateBus(redisForSub: RedisSubscriberLike): BusState {
	let bus = buses.get(redisForSub);
	if (bus != null) return bus;

	const messageHandlers = new Set<MessageHandler>();
	const internalHandlers = new Set<InternalEventHandler>();

	const rawListener = (_channel: string, data: string): void | Promise<void> => {
		const parsed = JSON.parse(data) as ParsedRedisMessage;
		let pending: Promise<void>[] | null = null;

		const collect = (result: void | Promise<void>) => {
			if (result != null && typeof (result as Promise<void>).then === 'function') {
				if (pending == null) pending = [];
				pending.push(result);
			}
		};

		for (const handler of [...messageHandlers]) {
			collect(handler(parsed));
		}

		if (parsed.channel === 'internal') {
			const event = parsed.message as GlobalEvents['internal']['payload'];
			for (const handler of [...internalHandlers]) {
				collect(handler(event));
			}
		}

		if (pending != null) {
			return Promise.all(pending).then(() => undefined);
		}
	};

	bus = { rawListener, messageHandlers, internalHandlers };
	buses.set(redisForSub, bus);
	redisForSub.on('message', rawListener);
	return bus;
}

function cleanupBusIfEmpty(redisForSub: RedisSubscriberLike, bus: BusState): void {
	if (bus.messageHandlers.size === 0 && bus.internalHandlers.size === 0) {
		redisForSub.off('message', bus.rawListener);
		buses.delete(redisForSub);
	}
}

export function subscribeRedisMessage(
	redisForSub: RedisSubscriberLike,
	handler: MessageHandler,
): () => void {
	const bus = getOrCreateBus(redisForSub);
	bus.messageHandlers.add(handler);
	return () => {
		bus.messageHandlers.delete(handler);
		cleanupBusIfEmpty(redisForSub, bus);
	};
}

export function subscribeInternalEvent(
	redisForSub: RedisSubscriberLike,
	handler: InternalEventHandler,
): () => void {
	const bus = getOrCreateBus(redisForSub);
	bus.internalHandlers.add(handler);
	return () => {
		bus.internalHandlers.delete(handler);
		cleanupBusIfEmpty(redisForSub, bus);
	};
}
