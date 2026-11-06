/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';

/** Route a process-wide stream message only to connections listening to it. */
export class ChannelEventBus {
	private readonly subscribers = new Map<string | symbol, Set<EventEmitter>>();

	public createSubscriber(): EventEmitter {
		const subscriber = new EventEmitter();
		subscriber.on('newListener', (channel: string | symbol) => {
			if (channel === 'newListener' || channel === 'removeListener') return;
			let connections = this.subscribers.get(channel);
			if (connections == null) {
				connections = new Set();
				this.subscribers.set(channel, connections);
			}
			connections.add(subscriber);
		});
		subscriber.on('removeListener', (channel: string | symbol) => {
			if (subscriber.listenerCount(channel) > 0) return;
			const connections = this.subscribers.get(channel);
			connections?.delete(subscriber);
			if (connections?.size === 0) this.subscribers.delete(channel);
		});
		return subscriber;
	}

	public emit(channel: string, message: unknown): void {
		const connections = this.subscribers.get(channel);
		if (connections == null) return;
		// Match EventEmitter semantics when a callback changes subscriptions.
		for (const subscriber of [...connections]) subscriber.emit(channel, message);
	}
}
