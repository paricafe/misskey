/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* eslint-disable @typescript-eslint/explicit-function-return-type */
import type { StoryObj } from '@storybook/vue3';
import type { Component } from 'vue';
import MkVirtualList from './MkVirtualList.vue';

export const Default = {
	render() {
		return {
			components: { MkVirtualList: MkVirtualList as Component },
			setup() {
				return { items: Array.from({ length: 500 }, (_, i) => ({ id: String(i), height: 80 + (i % 5) * 40 })) };
			},
			template: '<div style="height: 500px; overflow-y: auto"><MkVirtualList :items="items"><template #default="{ item }"><div :style="{ height: `${item.height}px` }">{{ item.id }}</div></template></MkVirtualList></div>',
		};
	},
} satisfies StoryObj;
