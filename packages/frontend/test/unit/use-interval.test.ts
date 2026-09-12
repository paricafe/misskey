/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { useInterval } from '@@/js/use-interval.js';

const cleanups: (() => void)[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function mountInterval(options: { immediate?: boolean; keepRunningWhenHidden?: boolean } = {}) {
	const interval = ref(1000);
	const visible = ref(true);
	const tick = vi.fn();
	const child = defineComponent({
		setup() {
			useInterval(tick, interval, {
				immediate: options.immediate ?? true,
				afterMounted: true,
				keepRunningWhenHidden: options.keepRunningWhenHidden,
			});
			return () => h('div');
		},
	});
	const app = createApp({ render: () => h(KeepAlive, () => visible.value ? h(child) : null) });
	app.mount(document.createElement('div'));
	cleanups.push(() => app.unmount());
	return { interval, visible, tick, app };
}

describe('useInterval', () => {
	test('updates a reactive interval without duplicate mounted/activated timers', async () => {
		const { interval, tick } = mountInterval();
		expect(tick).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(tick).toHaveBeenCalledTimes(2);
		interval.value = 2000;
		await nextTick();
		expect(tick).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1999);
		expect(tick).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(tick).toHaveBeenCalledTimes(4);
	});

	test('keeps updates paused while deactivated and uses the latest interval on activation', async () => {
		const { interval, visible, tick } = mountInterval();
		visible.value = false;
		await nextTick();
		interval.value = 2000;
		await nextTick();
		await vi.advanceTimersByTimeAsync(5000);
		expect(tick).toHaveBeenCalledTimes(1);
		visible.value = true;
		await nextTick();
		expect(tick).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(tick).toHaveBeenCalledTimes(3);
	});

	test('keeps updated intervals paused in hidden documents', async () => {
		const { interval, tick } = mountInterval();
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		interval.value = 2000;
		await nextTick();
		await vi.advanceTimersByTimeAsync(5000);
		expect(tick).toHaveBeenCalledTimes(1);
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		expect(tick).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(tick).toHaveBeenCalledTimes(3);
	});

	test('preserves non-immediate intervals and stops on unmount', async () => {
		const { interval, tick, app } = mountInterval({ immediate: false, keepRunningWhenHidden: true });
		expect(tick).not.toHaveBeenCalled();
		interval.value = 2000;
		await nextTick();
		await vi.advanceTimersByTimeAsync(2000);
		expect(tick).toHaveBeenCalledTimes(1);
		app.unmount();
		cleanups.pop();
		interval.value = 1000;
		await nextTick();
		await vi.advanceTimersByTimeAsync(5000);
		expect(tick).toHaveBeenCalledTimes(1);
	});
});
