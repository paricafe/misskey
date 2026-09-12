/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onActivated, onDeactivated, onMounted, onUnmounted, toValue, watch } from 'vue';
import type { MaybeRefOrGetter } from 'vue';
import { createVisibilityAwareInterval } from './interval.js';

export function useInterval(fn: () => void, interval: MaybeRefOrGetter<number>, options: {
	immediate: boolean;
	afterMounted: boolean;
	keepRunningWhenHidden?: boolean;
}): (() => void) | undefined {
	let disposer: (() => void) | null = null;
	let active = !options.afterMounted;

	const start = () => {
		const intervalMs = toValue(interval);
		if (!active || disposer || Number.isNaN(intervalMs)) return;

		if (options.keepRunningWhenHidden) {
			if (options.immediate) fn();
			const intervalId = window.setInterval(fn, intervalMs);
			disposer = () => {
				window.clearInterval(intervalId);
			};
		} else {
			disposer = createVisibilityAwareInterval(fn, intervalMs, { immediate: options.immediate });
		}
	};

	const clear = () => {
		if (disposer) {
			disposer();
			disposer = null;
		}
	};

	if (options.afterMounted) {
		onMounted(() => {
			active = true;
			start();
		});
	} else {
		start();
	}

	onActivated(() => {
		active = true;
		start();
	});

	onDeactivated(() => {
		active = false;
		clear();
	});

	onUnmounted(() => {
		active = false;
		clear();
	});

	if (typeof interval !== 'number') {
		watch(() => toValue(interval), () => {
			clear();
			start();
		});
	}

	return () => {
		active = false;
		clear();
	};
}
