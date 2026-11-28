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
const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
const animations: { element: HTMLElement; keyframes: Keyframe[]; options: KeyframeAnimationOptions; cancel: ReturnType<typeof vi.fn> }[] = [];

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
	animations.length = 0;
	Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
		const animation = { element: this, keyframes, options, cancel: vi.fn(), onfinish: null, oncancel: null };
		animations.push(animation);
		return animation;
	}) });
	vi.stubGlobal('ResizeObserver', TestResizeObserver);
	scrollContainer = document.createElement('div');
	scrollContainer.style.overflowY = 'auto';
	Object.defineProperty(scrollContainer, 'clientHeight', { value: 300 });
	document.body.append(scrollContainer);
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
		let top = this === scrollContainer ? 20 : this.hasAttribute('data-virtual-list') ? 120 - scrollContainer.scrollTop : 0;
		if (this.hasAttribute('data-virtual-item')) {
			top = 120 - scrollContainer.scrollTop;
			for (const sibling of Array.from(this.parentElement!.children)) {
				if (sibling === this) break;
				const element = sibling as HTMLElement;
				top += element.hasAttribute('data-virtual-item') ? heights.get(element.dataset.virtualItem!) ?? 100 : parseFloat(element.style.height) || 0;
			}
		}
		const height = this.hasAttribute('data-virtual-item') ? heights.get(this.dataset.virtualItem!) ?? 100 : 300;
		return { x: 0, y: top, top, bottom: top + height, left: 0, right: 100, width: 100, height, toJSON: () => ({}) } as DOMRect;
	});
});

afterEach(() => {
	scrollContainer.remove();
	vi.restoreAllMocks();
	if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
	else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function flush() {
	await nextTick();
	await vi.advanceTimersByTimeAsync(50);
	await nextTick();
}

function mountList(overscan = 200, animationEnabled = false) {
	const animate = ref(animationEnabled);
	const items = ref(Array.from({ length: 500 }, (_, i) => ({ id: `note-${i}` })));
	const visible = ref(true);
	const app = createApp({
		render: () => h(KeepAlive, () => visible.value ? h(MkVirtualList, { items: items.value, estimatedHeight: 100, overscan, animate: animate.value }, {
			default: ({ item }: { item: { id: string } }) => h('button', item.id),
		}) : null),
	});
	app.mount(scrollContainer);
	return { app, items, visible, animate };
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

	test('animates visible new rows and displaced rows only when animation is enabled', async () => {
		const { app, items } = mountList(200, true);
		try {
			await flush();
			expect(animations).toHaveLength(0);
			items.value = [{ id: 'new' }, ...items.value];
			await flush();
			const entrance = animations.find(animation => animation.element.dataset.virtualItem === 'new');
			expect(entrance?.keyframes[0].opacity).toBe(0);
			expect(entrance?.keyframes.at(-1)?.opacity).toBe(1);
			expect(entrance?.options.duration).toBe(700);
			const displaced = animations.find(animation => animation.element.dataset.virtualItem === 'note-0');
			expect(displaced?.keyframes[0].transform).toBe('translateY(-100px)');
			expect(displaced?.keyframes.at(-1)?.transform).toBe('translateY(0)');
		} finally {
			app.unmount();
		}
	});

	test('keeps a new row animation running when its measured height changes', async () => {
		const { app, items } = mountList(200, true);
		try {
			await flush();
			items.value = [{ id: 'new' }, ...items.value];
			await flush();
			const row = scrollContainer.querySelector<HTMLElement>('[data-virtual-item="new"]')!;
			const entrance = animations.find(animation => animation.element === row);
			expect(entrance).toBeDefined();
			heights.set('new', 150);
			observers.at(-1)!.notify(row);
			await flush();
			expect(scrollContainer.querySelector('[data-virtual-item="new"]')).toBe(row);
			expect(entrance!.cancel).not.toHaveBeenCalled();
		} finally {
			app.unmount();
		}
	});

	test('does not animate a new row when animation is disabled', async () => {
		const { app, items } = mountList();
		try {
			await flush();
			items.value = [{ id: 'new' }, ...items.value];
			await flush();
			expect(renderedIds()).toContain('new');
			expect(animations).toHaveLength(0);
		} finally {
			app.unmount();
		}
	});

	test('cancels running animations when the animation preference is disabled', async () => {
		const { app, items, animate } = mountList(200, true);
		try {
			await flush();
			items.value = [{ id: 'new-1' }, ...items.value];
			await flush();
			const running = [...animations];
			expect(running.length).toBeGreaterThan(0);
			animate.value = false;
			await flush();
			expect(running.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
			const count = animations.length;
			items.value = [{ id: 'new-2' }, ...items.value];
			await flush();
			expect(animations).toHaveLength(count);
		} finally {
			app.unmount();
		}
	});

	test('does not animate older appended rows or rows mounted again after scrolling', async () => {
		const { app, items } = mountList(200, true);
		try {
			await flush();
			scrollContainer.scrollTop = 49900;
			scrollContainer.dispatchEvent(new Event('scroll'));
			await flush();
			items.value = [...items.value, { id: 'older' }];
			await flush();
			expect(renderedIds()).toContain('older');
			scrollContainer.scrollTop = 10100;
			scrollContainer.dispatchEvent(new Event('scroll'));
			await flush();
			expect(renderedIds()).toContain('note-100');
			scrollContainer.scrollTop = 0;
			scrollContainer.dispatchEvent(new Event('scroll'));
			await flush();
			expect(renderedIds()).toContain('note-0');
			expect(animations).toHaveLength(0);
		} finally {
			app.unmount();
		}
	});

	test('cancels active row animations on deactivation and unmount', async () => {
		const { app, items, visible } = mountList(200, true);
		let unmounted = false;
		try {
			await flush();
			items.value = [{ id: 'new-1' }, ...items.value];
			await flush();
			const beforeDeactivation = [...animations];
			expect(beforeDeactivation.length).toBeGreaterThan(0);
			visible.value = false;
			await flush();
			expect(beforeDeactivation.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
			visible.value = true;
			await flush();
			const count = animations.length;
			items.value = [{ id: 'new-2' }, ...items.value];
			await flush();
			const beforeUnmount = animations.slice(count);
			expect(beforeUnmount.length).toBeGreaterThan(0);
			app.unmount();
			unmounted = true;
			expect(beforeUnmount.every(animation => animation.cancel.mock.calls.length > 0)).toBe(true);
		} finally {
			if (!unmounted) app.unmount();
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

	test('does not push scrollTop back down when prepending items while scrolling to top', async () => {
		const { app, items } = mountList(200);
		try {
			scrollContainer.scrollTop = 500;
			scrollContainer.dispatchEvent(new Event('scroll'));
			await flush();
			items.value = [{ id: 'new-1' }, { id: 'new-2' }, ...items.value];
			scrollContainer.scrollTop = 0;
			await flush();
			expect(scrollContainer.scrollTop).toBe(0);
		} finally {
			app.unmount();
		}
	});

	test('ignores zero-sized measurements while hidden', async () => {
		const { app } = mountList(200);
		try {
			await flush();
			const beforeCount = renderedIds().length;
			const first = scrollContainer.querySelector<HTMLElement>('[data-virtual-item="note-0"]')!;
			const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
				x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}),
			} as DOMRect);
			observers.at(-1)!.notify(first);
			await flush();
			rectSpy.mockRestore();
			expect(renderedIds().length).toBe(beforeCount);
		} finally {
			app.unmount();
		}
	});

	test('skips slot re-rendering while scrolling within an unchanged visible range', async () => {
		let slotCalls = 0;
		const items = ref(Array.from({ length: 50 }, (_, i) => ({ id: `note-${i}` })));
		const app = createApp({
			render: () => h(MkVirtualList, { items: items.value, estimatedHeight: 100, overscan: 200 }, {
				default: ({ item }: { item: { id: string } }) => {
					slotCalls++;
					return h('button', item.id);
				},
			}),
		});
		app.mount(scrollContainer);
		try {
			await flush();
			const initialCalls = slotCalls;
			for (let px = 1; px <= 10; px++) {
				scrollContainer.scrollTop = px;
				scrollContainer.dispatchEvent(new Event('scroll'));
				await flush();
			}
			expect(slotCalls).toBe(initialCalls);
		} finally {
			app.unmount();
		}
	});

	test('updates layout when ResizeObserver reports borderBoxSize changes', async () => {
		const { app } = mountList(200);
		try {
			await flush();
			const root = scrollContainer.querySelector<HTMLElement>('[data-virtual-list]')!;
			const bottomSpacer = () => root.lastElementChild as HTMLElement;
			const beforeBottom = parseFloat(bottomSpacer().style.height);
			const first = scrollContainer.querySelector<HTMLElement>('[data-virtual-item="note-0"]')!;
			heights.set('note-0', 180);
			const observer = observers.at(-1)!;
			(observer as unknown as { callback: ResizeObserverCallback }).callback(
				[{ target: first, borderBoxSize: [{ inlineSize: 100, blockSize: 180 }] } as unknown as ResizeObserverEntry],
				observer as unknown as ResizeObserver,
			);
			await flush();
			expect(parseFloat(bottomSpacer().style.height)).toBe(beforeBottom + 100);
		} finally {
			app.unmount();
		}
	});

	test('reversed mode keeps reading anchor on older prepend and bottom append while staying pinned at bottom', async () => {
		const items = ref(Array.from({ length: 100 }, (_, i) => ({ id: `msg-${i}` })));
		const reversedContainer = document.createElement('div');
		reversedContainer.style.overflowY = 'auto';
		Object.defineProperty(reversedContainer, 'clientHeight', { value: 300 });
		document.body.append(reversedContainer);
		const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
			if (this === reversedContainer) {
				return { x: 0, y: 20, top: 20, bottom: 320, left: 0, right: 100, width: 100, height: 300, toJSON: () => ({}) } as DOMRect;
			}
			if (this.hasAttribute('data-virtual-list')) {
				let totalHeight = 0;
				for (const child of Array.from(this.children)) {
					const el = child as HTMLElement;
					totalHeight += el.hasAttribute('data-virtual-item') ? 100 : parseFloat(el.style.height) || 0;
				}
				const top = 320 - totalHeight - reversedContainer.scrollTop;
				return { x: 0, y: top, top, bottom: top + totalHeight, left: 0, right: 100, width: 100, height: totalHeight, toJSON: () => ({}) } as DOMRect;
			}
			return { x: 0, y: 0, top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100, toJSON: () => ({}) } as DOMRect;
		});
		const app = createApp({
			render: () => h(MkVirtualList, { items: items.value, estimatedHeight: 100, overscan: 200, reversed: true }, {
				default: ({ item }: { item: { id: string } }) => h('div', item.id),
			}),
		});
		app.mount(reversedContainer);
		const ids = () => Array.from(reversedContainer.querySelectorAll<HTMLElement>('[data-virtual-item]'), el => el.dataset.virtualItem!);
		try {
			await flush();
			expect(ids()).toContain('msg-99');
			expect(ids()).not.toContain('msg-0');

			items.value = [...items.value, { id: 'msg-100' }];
			await flush();
			expect(reversedContainer.scrollTop).toBe(0);
			expect(ids()).toContain('msg-100');

			reversedContainer.scrollTop = -5000;
			reversedContainer.dispatchEvent(new Event('scroll'));
			await flush();
			expect(ids()).toContain('msg-48');

			items.value = [
				...Array.from({ length: 10 }, (_, i) => ({ id: `older-${i}` })),
				...items.value,
			];
			await flush();
			expect(reversedContainer.scrollTop).toBe(-5000);
			expect(ids()).toContain('msg-48');

			items.value = [...items.value, { id: 'msg-101' }];
			await flush();
			expect(reversedContainer.scrollTop).toBe(-5100);
		} finally {
			app.unmount();
			rectSpy.mockRestore();
			reversedContainer.remove();
		}
	});
});
