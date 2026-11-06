/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, h, KeepAlive, nextTick, ref } from 'vue';
import MkSparkle from '@/components/MkSparkle.vue';

const intersections: TestIntersectionObserver[] = [];
const resizes: TestResizeObserver[] = [];
class TestIntersectionObserver {
	disconnect = vi.fn();
	observe = vi.fn();
	constructor(private callback: IntersectionObserverCallback) { intersections.push(this); }
	setVisible(visible: boolean) {
		this.callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
	}
}
class TestResizeObserver {
	disconnect = vi.fn();
	observe = vi.fn();
	constructor() { resizes.push(this); }
}

beforeEach(() => {
	intersections.length = 0;
	resizes.length = 0;
	vi.useFakeTimers();
	vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
	vi.stubGlobal('ResizeObserver', TestResizeObserver);
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
	vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function mountSparkle() {
	const visible = ref(true);
	const root = document.createElement('div');
	const app = createApp({ render: () => h(KeepAlive, () => visible.value ? h(MkSparkle, null, { default: () => 'sparkle' }) : null) });
	app.mount(root);
	return { app, root, visible };
}

async function flush() { await nextTick(); }

describe('MkSparkle', () => {
	test('only runs while visible and stops all timers when hidden', async () => {
		const scheduled = vi.spyOn(window, 'setTimeout');
		const added = vi.spyOn(document, 'addEventListener');
		const removed = vi.spyOn(document, 'removeEventListener');
		const { app, root } = mountSparkle();
		try {
			await flush();
			expect(root.querySelectorAll('svg')).toHaveLength(0);
			expect(scheduled.mock.calls.filter(([, delay]) => typeof delay === 'number' && delay < 2000)).toHaveLength(0);
			vi.clearAllTimers();
			expect(vi.getTimerCount()).toBe(0);
			intersections[0].setVisible(true);
			await flush();
			expect(root.querySelectorAll('svg')).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(2);
			intersections[0].setVisible(true);
			expect(vi.getTimerCount()).toBe(2);
			intersections[0].setVisible(false);
			await flush();
			expect(root.querySelectorAll('svg')).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			intersections[0].setVisible(true);
			vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
			document.dispatchEvent(new Event('visibilitychange'));
			await flush();
			expect(root.querySelectorAll('svg')).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
			vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
			document.dispatchEvent(new Event('visibilitychange'));
			await flush();
			expect(root.querySelectorAll('svg')).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(2);
		} finally {
			app.unmount();
		}
		expect(vi.getTimerCount()).toBe(0);
		expect(intersections[0].disconnect).toHaveBeenCalled();
		expect(resizes[0].disconnect).toHaveBeenCalled();
		const listener = added.mock.calls.find(([type]) => type === 'visibilitychange')?.[1];
		expect(listener).toBeDefined();
		expect(removed.mock.calls.some(([type, callback]) => type === 'visibilitychange' && callback === listener)).toBe(true);
	});

	test('pauses on keep-alive deactivation and observes afresh on activation', async () => {
		const { app, root, visible } = mountSparkle();
		try {
			intersections[0].setVisible(true);
			await flush();
			visible.value = false;
			await flush();
			expect(vi.getTimerCount()).toBe(0);
			expect(intersections[0].disconnect).toHaveBeenCalled();
			expect(resizes[0].disconnect).toHaveBeenCalled();
			visible.value = true;
			await flush();
			expect(root.querySelectorAll('svg')).toHaveLength(0);
			intersections[1].setVisible(true);
			await flush();
			expect(root.querySelectorAll('svg')).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(2);
		} finally {
			app.unmount();
		}
		expect(vi.getTimerCount()).toBe(0);
		expect(intersections[1].disconnect).toHaveBeenCalled();
		expect(resizes[1].disconnect).toHaveBeenCalled();
	});
});
