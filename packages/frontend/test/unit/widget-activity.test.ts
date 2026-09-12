/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { createApp, h, KeepAlive, nextTick, ref } from 'vue';
import WidgetActivityChart from '@/widgets/WidgetActivity.chart.vue';

afterEach(() => vi.restoreAllMocks());

test('releases all drag listeners after each gesture and when deactivated or unmounted', async () => {
	const added = vi.spyOn(window, 'addEventListener');
	const removed = vi.spyOn(window, 'removeEventListener');
	const visible = ref(true);
	const activity = [{ total: 1, notes: 1, replies: 0, renotes: 0 }];
	const app = createApp({ render: () => h(KeepAlive, () => visible.value ? h(WidgetActivityChart, { activity }) : null) });
	const root = document.createElement('div');
	app.mount(root);
	const svg = root.querySelector('svg')!;
	const startDrag = () => svg.dispatchEvent(new MouseEvent('mousedown', { clientX: 20, clientY: 20 }));
	const assertReleased = () => {
		for (const [type, listener] of added.mock.calls) {
			if (!['mousemove', 'mouseup', 'mouseleave'].includes(type)) continue;
			expect(removed.mock.calls.some(([removedType, removedListener]) => removedType === type && removedListener === listener)).toBe(true);
		}
	};

	try {
		for (let i = 0; i < 10; i++) {
			startDrag();
			window.dispatchEvent(new MouseEvent(i % 2 === 0 ? 'mouseup' : 'mouseleave'));
		}
		assertReleased();
		startDrag();
		visible.value = false;
		await nextTick();
		assertReleased();
		visible.value = true;
		await nextTick();
		startDrag();
	} finally {
		app.unmount();
	}
	assertReleased();
});
