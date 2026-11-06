/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import { note } from '../../.storybook/fakes.js';
import Component from './MkNote.body.vue';

export const Default = {
	render(args) {
		return {
			components: { Component },
			setup() { return { args }; },
			template: '<Component v-bind="args"/>',
		};
	},
	args: { note: note(), mock: true },
} satisfies StoryObj<typeof Component>;
