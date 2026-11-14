/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function createVisibilityAwareInterval(fn: () => void, interval: number, options: {
	immediate?: boolean;
} = {}): () => void {
	let intervalId: number | null = null;
	let lastCalledAt: number | null = null;

	const tick = () => {
		lastCalledAt = Date.now();
		fn();
	};

	const start = () => {
		if (intervalId != null) return;
		if (lastCalledAt == null) {
			if (options.immediate) {
				tick();
			} else {
				lastCalledAt = Date.now();
			}
		} else if (Date.now() - lastCalledAt >= interval) {
			tick();
		}
		intervalId = window.setInterval(tick, interval);
	};

	const stop = () => {
		if (intervalId != null) {
			window.clearInterval(intervalId);
			intervalId = null;
		}
	};

	const onVisibilityChange = () => {
		if (window.document.visibilityState === 'visible') {
			start();
		} else {
			stop();
		}
	};

	window.document.addEventListener('visibilitychange', onVisibilityChange);

	if (window.document.visibilityState === 'visible') {
		start();
	}

	return () => {
		window.document.removeEventListener('visibilitychange', onVisibilityChange);
		stop();
	};
}
