/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { action } from 'storybook/actions';
import type { StoryObj } from '@storybook/vue3';
import MkDrive_file from './MkDrive.file.vue';
import { file } from '../../.storybook/fakes.js';
export const Default = {
	render(args) {
		return {
			components: {
				MkDrive_file,
			},
			setup() {
				return {
					args,
				};
			},
			computed: {
				props() {
					return {
						...this.args,
					};
				},
				events() {
					return {
						chosen: action('chosen'),
						dragstart: action('dragstart'),
						dragend: action('dragend'),
					};
				},
			},
			template: '<MkDrive_file v-bind="props" v-on="events" />',
		};
	},
	args: {
		file: file(),
	},
	parameters: {
		chromatic: {
			delay: 3000,
		},
		layout: 'centered',
	},
} satisfies StoryObj<typeof MkDrive_file>;
