/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp, h, KeepAlive, nextTick, ref } from 'vue';
import MkVirtualList from '@/components/MkVirtualList.vue';

const observers: TestResizeObserver[] = [];
const heights = new Map<string, number>();
let scrollContainer: HTMLElement;

class TestResizeObserver {
	observed = new Set<Element>();
	disconnected = false;
	constructor(private callback: ResizeObserverCallback) { observers.push(this); }
	observe(element: Element) { this.observed.add(element); }
	unobserve(element: Element) { this.observed.delete(element); }
	disconnect() { this.disconnected = true; this.observed.clear(); }
	notify(element: Element) {
		this.callback([{ target: element } as ResizeObserverEntry], this as unknown as ResizeObserver);
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	observers.length = 0;
	heights.clear();
	vi.stubGlobal('ResizeObserver', TestResizeObserver);
	scrollContainer = document.createElement('div');
	scrollContainer.style.overflowY = 'auto';
	Object.defineProperty(scrollContainer, 'clientHeight', { value: 300 });
	document.body.append(scrollContainer);
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
		const top = this === scrollContainer ? 20 : this.hasAttribute('data-virtual-list') ? 120 - scrollContainer.scrollTop : 0;
		const height = this.hasAttribute('data-virtual-item') ? heights.get(this.dataset.virtualItem!) ?? 100 : 300;
		return { x: 0, y: top, top, bottom: top + height, left: 0, right: 100, width: 100, height, toJSON: () => ({}) } as DOMRect;
	});
});

afterEach(() => {
	scrollContainer.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function flush() {
	await nextTick();
	await vi.advanceTimersByTimeAsync(50);
	await nextTick();
}

function mountList(overscan = 200) {
	const items = ref(Array.from({ length: 500 }, (_, i) => ({ id: `note-${i}` })));
	const visible = ref(true);
	const app = createApp({
		render: () => h(KeepAlive, () => visible.value ? h(MkVirtualList, { items: items.value, estimatedHeight: 100, overscan }, {
			default: ({ item }: { item: { id: string } }) => h('button', item.id),
		}) : null),
	});
	app.mount(scrollContainer);
	return { app, items, visible };
}

function renderedIds() {
	return Array.from(scrollContainer.querySelectorAll<HTMLElement>('[data-virtual-item]'), el => el.dataset.virtualItem!);
}

describe('MkVirtualList', () => {
	test('retains only the focused row when it scrolls away, then releases it on blur', async () => {
		const { app } = mountList();
		try {
			await flush();
			const button = scrollContainer.querySelector<HTMLButtonElement>('[data-virtual-item="note-0"] button')!;
			button.focus();
			expect(document.activeElement).toBe(button);
			scrollContainer.scrollTop = 10100;
			scrollContainer.dispatchEvent(new Event('scroll'));
			await flush();
			expect(document.activeElement).toBe(button);
			expect(renderedIds()).toContain('note-0');
			expect(renderedIds()).toContain('note-100');
			expect(renderedIds()).not.toContain('note-50');
			expect(renderedIds().length).toBeLessThan(20);
			button.blur();
			await flush();
			expect(renderedIds()).not.toContain('note-0');
			expect(renderedIds()).toContain('note-100');
		} finally {
			app.unmount();
		}
	});

	test('mounts a bounded set and follows its nested scroll container', async () => {
		const { app } = mountList();
		try {
			await flush();
			expect(renderedIds()).toContain('note-0');
			expect(renderedIds().length).toBeLessThan(20);
			scrollContainer.scrollTop = 10100;
			scrollContainer.dispatchEvent(new Event('scroll'));
			await flush();
			expect(renderedIds()).toContain('note-100');
			expect(renderedIds()).not.toContain('note-0');
			expect(renderedIds().length).toBeLessThan(20);
		} finally {
			app.unmount();
		}
	});

	test('retains the visible position when earlier items change height or are inserted', async () => {
		const { app, items } = mountList(500);
		try {
			scrollContainer.scrollTop = 325;
			scrollContainer.dispatchEvent(new Event('scroll'));
			await flush();
			const first = scrollContainer.querySelector<HTMLElement>('[data-virtual-item="note-0"]')!;
			expect(first).toBeTruthy();
			heights.set('note-0', 150);
			observers.at(-1)!.notify(first);
			await flush();
			expect(scrollContainer.scrollTop).toBe(375);
			items.value = [{ id: 'new' }, ...items.value];
			await flush();
			expect(scrollContainer.scrollTop).toBe(475);
		} finally {
			app.unmount();
		}
	});

	test('releases observation and scroll listeners on deactivation and unmount', async () => {
		const added = vi.spyOn(scrollContainer, 'addEventListener');
		const removed = vi.spyOn(scrollContainer, 'removeEventListener');
		const { app, visible } = mountList();
		const assertReleased = () => {
			for (const [type, listener] of added.mock.calls) {
				if (type === 'scroll') expect(removed.mock.calls.some(([removedType, removedListener]) => removedType === type && removedListener === listener)).toBe(true);
			}
		};
		try {
			await flush();
			visible.value = false;
			await flush();
			expect(observers[0].disconnected).toBe(true);
			assertReleased();
			visible.value = true;
			await flush();
			expect(observers.length).toBeGreaterThanOrEqual(2);
		} finally {
			app.unmount();
		}
		expect(observers.every(observer => observer.disconnected)).toBe(true);
		assertReleased();
	});
});
