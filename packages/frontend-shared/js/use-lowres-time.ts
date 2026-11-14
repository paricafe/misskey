/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref, readonly, computed } from 'vue';
import { createVisibilityAwareInterval } from './interval.js';

const time = ref(Date.now());

export const TIME_UPDATE_INTERVAL = 10000;

export const lowresTime = readonly(time);

export function useLowresTime() {
	const now = Date.now();
	return computed(() => Math.max(time.value, now));
}

createVisibilityAwareInterval(() => {
	time.value = Date.now();
}, TIME_UPDATE_INTERVAL);
