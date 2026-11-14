/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { throttle } from 'throttle-debounce';
import { nextTick, onActivated, onDeactivated, watch } from 'vue';
import type { Ref } from 'vue';

export function useScrollPositionKeeper(scrollContainerRef: Ref<HTMLElement | null | undefined>): void {
	let anchorId: string | null = null;
	let anchorContainerLocalY = 0;
	let savedScrollTop = 0;
	let ready = true;

	watch(scrollContainerRef, (el) => {
		if (!el) return;

		const captureAnchor = () => {
			if (!el) return;
			if (!ready) return;

			if (el.scrollTop < 100) {
				anchorId = null;
				return;
			}

			const scrollContainerRect = el.getBoundingClientRect();
			const viewPosition = scrollContainerRect.top + scrollContainerRect.height / 2;

			const anchorEls = el.querySelectorAll<HTMLElement>('[data-scroll-anchor]');
			for (let i = anchorEls.length - 1; i > -1; i--) {
				const anchorEl = anchorEls[i];
				const anchorTop = anchorEl.getBoundingClientRect().top;
				if (anchorTop <= viewPosition) {
					anchorId = anchorEl.getAttribute('data-scroll-anchor');
					anchorContainerLocalY = anchorTop - scrollContainerRect.top;
					break;
				}
			}
		};

		el.addEventListener('scroll', throttle(1000, captureAnchor), { passive: true });
		el.addEventListener('pointerdown', captureAnchor, { passive: true });
	}, {
		immediate: true,
	});

	const restore = () => {
		if (!anchorId) return;
		const scrollContainer = scrollContainerRef.value;
		if (!scrollContainer) return;
		const scrollAnchorEl = scrollContainer.querySelector<HTMLElement>(`[data-scroll-anchor="${CSS.escape(anchorId)}"]`);
		if (!scrollAnchorEl) return;
		const anchorRect = scrollAnchorEl.getBoundingClientRect();
		const anchorContentY = scrollContainer.scrollTop + anchorRect.top - scrollContainer.getBoundingClientRect().top;
		scrollContainer.scrollTop = anchorContentY - anchorContainerLocalY;
	};

	onDeactivated(() => {
		const el = scrollContainerRef.value;
		if (el) savedScrollTop = el.scrollTop;
		ready = false;
	});

	onActivated(() => {
		restore();
		nextTick(() => {
			restore();
			window.setTimeout(() => {
				restore();

				const el = scrollContainerRef.value;
				if (el && el.scrollTop === 0 && savedScrollTop > 0) {
					el.scrollTop = savedScrollTop;
				}

				ready = true;
			}, 100);
		});
	});
}
