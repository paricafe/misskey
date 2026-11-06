<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="rootEl" data-virtual-list :data-total-items="items.length" :class="$style.root">
	<template v-for="{ item, index, gapBefore } in visibleItems" :key="item.id">
		<div v-if="gapBefore > 0" aria-hidden="true" :style="{ height: `${gapBefore}px` }"></div>
		<div
		:ref="el => setItemElement(item.id, el)"
		:data-virtual-item="item.id"
		:data-scroll-anchor="item.id"
		:class="$style.item"
		:style="{ paddingBottom: `${gap}px` }"
		@focusin="focusedId = item.id"
		@focusout="onFocusOut"
	>
		<slot :item="item" :index="index"></slot>
		</div>
	</template>
	<div aria-hidden="true" :style="{ height: `${bottom}px` }"></div>
</div>
</template>

<script lang="ts" setup generic="T extends { id: string }">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { getScrollContainer } from '@@/js/scroll.js';
import { VirtualListLayout } from '@/utility/virtual-list.js';

const props = withDefaults(defineProps<{
	items: T[];
	estimatedHeight?: number;
	overscan?: number;
	gap?: number;
}>(), {
	estimatedHeight: 200,
	overscan: 600,
	gap: 0,
});

defineSlots<{ default?: (props: { item: T; index: number }) => void }>();

const rootEl = useTemplateRef('rootEl');
const layout = new VirtualListLayout(props.estimatedHeight + props.gap);
const revision = ref(0);
const viewport = shallowRef({ top: 0, height: 800 });
const range = computed(() => {
	revision.value;
	return layout.range(viewport.value.top, viewport.value.height, props.overscan);
});
const focusedId = ref<string | null>(null);
const visibleItems = computed(() => {
	const indices = new Set(Array.from({ length: range.value.end - range.value.start }, (_, i) => range.value.start + i));
	if (focusedId.value != null) {
		const index = props.items.findIndex(item => item.id === focusedId.value);
		if (index >= 0) indices.add(index);
	}
	let previousEnd = 0;
	return [...indices].sort((a, b) => a - b).map(index => {
		const gapBefore = layout.offset(index) - previousEnd;
		previousEnd = layout.offset(index + 1);
		return { item: props.items[index], index, gapBefore };
	});
});
const bottom = computed(() => layout.totalHeight - layout.offset((visibleItems.value.at(-1)?.index ?? -1) + 1));

// Keep keyboard focus without retaining intervening rows.
function onFocusOut(event: FocusEvent) {
	if (event.relatedTarget instanceof Node && (event.currentTarget as HTMLElement).contains(event.relatedTarget)) return;
	focusedId.value = null;
}

const elements = new Map<string, HTMLElement>();
let scrollContainer: HTMLElement | null = null;
let observer: ResizeObserver | null = null;
let frame: number | null = null;
let active = false;

function updateViewport() {
	if (!rootEl.value || !active) return;
	const top = rootEl.value.getBoundingClientRect().top;
	const containerTop = scrollContainer ? scrollContainer.getBoundingClientRect().top + scrollContainer.clientTop : 0;
	viewport.value = { top: containerTop - top, height: scrollContainer?.clientHeight ?? window.innerHeight };
}

function scheduleViewport() {
	if (frame != null || !active) return;
	frame = window.requestAnimationFrame(() => {
		frame = null;
		updateViewport();
	});
}

function changeLayout(change: () => boolean | void) {
	const top = viewport.value.top;
	const anchor = top > 0 ? layout.anchor(top) : null;
	if (change() === false) return;
	revision.value++;
	const position = anchor && layout.position(anchor);
	const delta = position == null ? 0 : position - top;
	if (delta !== 0) {
		viewport.value = { ...viewport.value, top: top + delta };
		nextTick(() => {
			if (!active) return;
			if (scrollContainer) scrollContainer.scrollTop += delta;
			else window.scrollBy(0, delta);
			updateViewport();
		});
	}
}

watch(() => props.items, items => changeLayout(() => layout.update(items.map(item => item.id))), { immediate: true });

function setItemElement(id: string, el: Element | ComponentPublicInstance | null) {
	const previous = elements.get(id);
	if (previous === el) return;
	if (previous) observer?.unobserve(previous);
	if (el instanceof HTMLElement) {
		elements.set(id, el);
		if (active) observer?.observe(el);
	} else {
		elements.delete(id);
	}
}

function start() {
	if (active || !rootEl.value) return;
	active = true;
	scrollContainer = getScrollContainer(rootEl.value.parentElement);
	observer = new ResizeObserver(entries => {
		changeLayout(() => {
			let changed = false;
			for (const entry of entries) {
				const el = entry.target as HTMLElement;
				const id = el.dataset.virtualItem;
				if (id) changed = layout.measure(id, el.getBoundingClientRect().height) || changed;
			}
			return changed;
		});
		updateViewport();
	});
	for (const el of elements.values()) observer.observe(el);
	observer.observe(rootEl.value);
	(scrollContainer ?? window).addEventListener('scroll', scheduleViewport, { passive: true });
	window.addEventListener('resize', scheduleViewport, { passive: true });
	updateViewport();
}

function stop() {
	active = false;
	observer?.disconnect();
	observer = null;
	(scrollContainer ?? window).removeEventListener('scroll', scheduleViewport);
	window.removeEventListener('resize', scheduleViewport);
	if (frame != null) window.cancelAnimationFrame(frame);
	frame = null;
}

onMounted(start);
onActivated(() => nextTick(start));
onDeactivated(stop);
onBeforeUnmount(stop);
</script>

<style lang="scss" module>
.root {
	overflow-anchor: none;
}

.item {
	display: flow-root;
	box-sizing: border-box;
}
</style>
