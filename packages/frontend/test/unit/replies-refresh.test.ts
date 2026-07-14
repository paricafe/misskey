/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRepliesRefreshScheduler } from '@/composables/use-replies-refresh.js';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});

afterEach(() => vi.useRealTimers());

describe('createRepliesRefreshScheduler', () => {
	test('removes immediately and refreshes active loaded replies', async () => {
		const refresh = vi.fn().mockResolvedValue(undefined);
		const remove = vi.fn();
		const scheduler = createRepliesRefreshScheduler({
			isActive: () => true,
			isLoaded: () => true,
			refresh,
			remove,
		});

		scheduler.notify({ action: 'removed', childId: 'child' });
		expect(remove).toHaveBeenCalledWith('child');
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	test('coalesces events during a request into one throttled follow-up', async () => {
		let finishFirst!: () => void;
		const first = new Promise<void>(resolve => { finishFirst = resolve; });
		const refresh = vi.fn()
			.mockImplementationOnce(() => first)
			.mockResolvedValue(undefined);
		const scheduler = createRepliesRefreshScheduler({
			isActive: () => true,
			isLoaded: () => true,
			refresh,
			remove: vi.fn(),
			throttleMs: 1000,
		});

		scheduler.notify({ action: 'added', childId: 'one' });
		await vi.advanceTimersByTimeAsync(0);
		scheduler.notify({ action: 'added', childId: 'two' });
		finishFirst();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(999);
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	test('defers inactive tabs until activation', async () => {
		let active = false;
		const refresh = vi.fn().mockResolvedValue(undefined);
		const scheduler = createRepliesRefreshScheduler({
			isActive: () => active,
			isLoaded: () => true,
			refresh,
			remove: vi.fn(),
		});

		scheduler.notify({ action: 'added', childId: 'child' });
		await vi.runAllTimersAsync();
		expect(refresh).not.toHaveBeenCalled();
		active = true;
		scheduler.activate();
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	test('keeps failed refreshes dirty without retrying until reactivated', async () => {
		const refresh = vi.fn()
			.mockRejectedValueOnce(new Error('network'))
			.mockResolvedValue(undefined);
		const scheduler = createRepliesRefreshScheduler({
			isActive: () => true,
			isLoaded: () => true,
			refresh,
			remove: vi.fn(),
		});

		scheduler.notify({ action: 'added', childId: 'child' });
		await vi.advanceTimersByTimeAsync(0);
		expect(scheduler.isDirty()).toBe(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(refresh).toHaveBeenCalledTimes(1);
		scheduler.activate();
		await vi.advanceTimersByTimeAsync(0);
		expect(refresh).toHaveBeenCalledTimes(2);
	});
});
