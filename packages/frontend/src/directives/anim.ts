/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Directive } from 'vue';

export const animDirective = {
	mounted(src) {
		src.animate([{
			offset: 0,
			opacity: 0,
			transform: 'scale(0.9)',
		}], {
			duration: 500,
			easing: 'cubic-bezier(0,.5,.5,1)',
		});
	},
} as Directive<HTMLElement>;
