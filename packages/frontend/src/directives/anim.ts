/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Directive } from 'vue';

export const animDirective = {
	beforeMount(src) {
		src.style.opacity = '0';
		src.style.transform = 'scale(0.9)';
		src.classList.add('_zoom');
	},

	mounted(src) {
		window.setTimeout(() => {
			src.style.opacity = '1';
			src.style.transform = 'none';
		}, 1);
	},
} as Directive<HTMLElement>;
