/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ChannelEventBus } from './ChannelEventBus.js';

describe('stream channel routing', () => {
	test('visits matching connections only and keeps broadcasts', () => {
		const bus = new ChannelEventBus();
		const alice = bus.createSubscriber();
		const bob = bus.createSubscriber();
		const onAlice = vi.fn();
		const onBob = vi.fn();
		const onBroadcast = vi.fn();
		alice.on('mainStream:alice', onAlice);
		bob.on('mainStream:bob', onBob);
		alice.on('broadcast', onBroadcast);
		bob.on('broadcast', onBroadcast);
		const bobEmit = vi.spyOn(bob, 'emit');

		bus.emit('mainStream:alice', { type: 'notification' });
		expect(onAlice).toHaveBeenCalledExactlyOnceWith({ type: 'notification' });
		expect(onBob).not.toHaveBeenCalled();
		expect(bobEmit).not.toHaveBeenCalled();
		bus.emit('broadcast', { type: 'emojiAdded' });
		expect(onBroadcast).toHaveBeenCalledTimes(2);
	});

	test('keeps a channel until its last listener leaves and supports resubscription', () => {
		const bus = new ChannelEventBus();
		const subscriber = bus.createSubscriber();
		const first = vi.fn();
		const second = vi.fn();
		subscriber.on('noteStream:note', first);
		subscriber.on('noteStream:note', second);
		bus.emit('noteStream:note', {});
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
		subscriber.off('noteStream:note', first);
		bus.emit('noteStream:note', {});
		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledTimes(2);
		subscriber.off('noteStream:note', second);
		const emit = vi.spyOn(subscriber, 'emit');
		bus.emit('noteStream:note', {});
		expect(emit).not.toHaveBeenCalled();
		subscriber.on('noteStream:note', first);
		bus.emit('noteStream:note', {});
		expect(first).toHaveBeenCalledTimes(2);
	});

	test('cleans up one-time listeners and every subscription on connection close', () => {
		const bus = new ChannelEventBus();
		const subscriber = bus.createSubscriber();
		const once = vi.fn();
		subscriber.once('once', once);
		bus.emit('once', {});
		bus.emit('once', {});
		expect(once).toHaveBeenCalledOnce();
		subscriber.on('broadcast', vi.fn());
		subscriber.on('mainStream:alice', vi.fn());
		subscriber.removeAllListeners();
		const emit = vi.spyOn(subscriber, 'emit');
		bus.emit('broadcast', {});
		bus.emit('mainStream:alice', {});
		bus.emit('once', {});
		expect(emit).not.toHaveBeenCalled();
	});

	test('does not deliver an in-progress message to newly subscribed connections', () => {
		const bus = new ChannelEventBus();
		const first = bus.createSubscriber();
		const second = bus.createSubscriber();
		const later = vi.fn();
		first.once('channel', () => { second.on('channel', later); });
		bus.emit('channel', {});
		expect(later).not.toHaveBeenCalled();
		bus.emit('channel', {});
		expect(later).toHaveBeenCalledOnce();
	});
});
