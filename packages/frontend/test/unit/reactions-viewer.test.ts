/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue';
import MkReactionsViewer from '@/components/MkReactionsViewer.vue';

vi.mock('@/components/MkReactionsViewer.reaction.vue', () => ({
	default: defineComponent({
		props: ['reaction', 'count'],
		setup: props => () => h('span', { 'data-reaction': props.reaction }, String(props.count)),
	}),
}));
vi.mock('@/custom-emojis.js', () => ({ customEmojisMap: new Map() }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/preferences.js', () => ({ prefer: { s: { animation: false, showAvailableReactionsFirstInNote: false } } }));

const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => {
	for (const app of apps.splice(0)) app.unmount();
});

function mountViewer(initial: Record<string, number>, options: { myReaction?: string; maxNumber?: number } = {}) {
	const reactions = shallowRef(initial);
	const root = document.createElement('div');
	const app = createApp({
		render: () => h(MkReactionsViewer, { noteId: 'note', reactions: reactions.value, reactionEmojis: {}, myReaction: options.myReaction ?? null, maxNumber: options.maxNumber }),
	});
	app.mount(root);
	apps.push(app);
	const shown = () => [...root.querySelectorAll('[data-reaction]')].map(el => `${el.getAttribute('data-reaction')}:${el.textContent}`);
	return { reactions, shown };
}

describe('MkReactionsViewer order', () => {
	test('keeps shown reactions in place and appends new ones', async () => {
		const { reactions, shown } = mountViewer({ '👍': 1, '🎉': 2 });
		expect(shown()).toEqual(['🎉:2', '👍:1']);

		reactions.value = { '👍': 3, '🎉': 2 };
		await nextTick();
		expect(shown()).toEqual(['🎉:2', '👍:3']);

		reactions.value = { '👍': 3, '🎉': 2, '❤': 5 };
		await nextTick();
		expect(shown()).toEqual(['🎉:2', '👍:3', '❤:5']);

		reactions.value = { '👍': 0, '🎉': 2, '❤': 5 };
		await nextTick();
		expect(shown()).toEqual(['🎉:2', '❤:5']);
	});

	test('adds the viewer reaction beyond the limit only while it has a count', async () => {
		const { reactions, shown } = mountViewer({ '👍': 2, '🎉': 1 }, { myReaction: '🎉', maxNumber: 1 });
		expect(shown()).toEqual(['👍:2', '🎉:1']);

		reactions.value = { '👍': 2, '🎉': 0 };
		await nextTick();
		expect(shown()).toEqual(['👍:2']);
	});
});
