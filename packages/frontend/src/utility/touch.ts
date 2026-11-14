/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ref } from 'vue';
import { deviceKind } from '@/utility/device-kind.js';

const isTouchSupported = 'maxTouchPoints' in navigator && navigator.maxTouchPoints > 0;

export let isTouchUsing = deviceKind === 'tablet' || deviceKind === 'smartphone';

if (isTouchSupported && !isTouchUsing) {
	window.addEventListener('touchstart', () => {
		isTouchUsing = true;
	}, { passive: true });
}

export const isHorizontalSwipeSwiping = ref(false);
