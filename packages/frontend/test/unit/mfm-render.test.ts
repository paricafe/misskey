/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/vue';
import type * as Misskey from 'misskey-js';
import Mfm from '@/components/global/MkMfm.js';

const probes = vi.hoisted(() => {
	const state = {
		nextId: 0,
		mounted: [] as string[],
		unmounted: [] as string[],
	};
	return {
		state,
		preferences: { advancedMfm: true, animatedMfm: true, emojiStyle: 'twemoji' },
		customEmojisMap: new Map<string, { url: string }>(),
		async component(name: string) {
			const { defineComponent, h, onUnmounted } = await import('vue');
			return {
				default: defineComponent({
					inheritAttrs: false,
					setup(_, { attrs, slots }) {
						const instanceId = ++state.nextId;
						// Model children that capture their initial props during setup.
						const initialProps = JSON.stringify(attrs);
						state.mounted.push(name);
						onUnmounted(() => state.unmounted.push(name));
						return () => h('span', {
							'data-component': name,
							'data-instance': instanceId,
							'data-props': initialProps,
						}, slots.default?.());
					},
				}),
			};
		},
	};
});

vi.mock('@/components/global/MkUrl.vue', () => probes.component('url'));
vi.mock('@/components/global/MkTime.vue', () => probes.component('time'));
vi.mock('@/components/MkLink.vue', () => probes.component('link'));
vi.mock('@/components/MkMention.vue', () => probes.component('mention'));
vi.mock('@/components/global/MkEmoji.vue', () => probes.component('emoji'));
vi.mock('@/components/global/MkCustomEmoji.vue', () => probes.component('customEmoji'));
vi.mock('@/components/MkCode.vue', () => probes.component('code'));
vi.mock('@/components/MkCodeInline.vue', () => probes.component('inlineCode'));
vi.mock('@/components/MkGoogle.vue', () => probes.component('search'));
vi.mock('@/components/MkSparkle.vue', () => probes.component('sparkle'));
vi.mock('@/components/global/MkA.vue', () => probes.component('hashtag'));
vi.mock('@/preferences.js', () => ({ prefer: { s: probes.preferences } }));
vi.mock('@/custom-emojis.js', () => ({ customEmojisMap: probes.customEmojisMap }));

function instances(container: Element, component?: string) {
	const selector = component ? `[data-component="${component}"]` : '[data-component]';
	return Array.from(container.querySelectorAll(selector), el => el.getAttribute('data-instance'));
}

function initialProps(container: Element, component: string) {
	return JSON.parse(container.querySelector(`[data-component="${component}"]`)!.getAttribute('data-props')!);
}

describe('MFM component identity', () => {
	beforeEach(() => {
		probes.state.nextId = 0;
		probes.state.mounted.length = 0;
		probes.state.unmounted.length = 0;
		probes.preferences.animatedMfm = true;
		probes.preferences.emojiStyle = 'twemoji';
		probes.customEmojisMap.clear();
	});

	afterEach(cleanup);

	test('preserves existing rich text components when appending ordinary text', async () => {
		const text = '😀 :sample: https://example.com/a [link](https://example.com/b) @alice #topic `inline`\n```js\nconst x = 1;\n```\n$[unixtime 1700000000]\nquery 検索\ntrailing';
		const result = render(Mfm, { props: { text } });
		const before = instances(result.container);
		expect(probes.state.mounted).toEqual(['emoji', 'customEmoji', 'url', 'link', 'mention', 'hashtag', 'inlineCode', 'code', 'time', 'search']);

		await result.rerender({ text: `${text}!` });

		expect(instances(result.container)).toEqual(before);
		expect(probes.state.mounted).toHaveLength(before.length);
		expect(probes.state.unmounted).toEqual([]);
	});

	test.each([true, false])('preserves repeated and nested emoji when animations are %s', async animatedMfm => {
		probes.preferences.animatedMfm = animatedMfm;
		const text = '$[sparkle 😀] $[sparkle 😀] **😀 😀** [😀](https://example.com) trailing';
		const result = render(Mfm, { props: { text } });
		const before = instances(result.container);
		expect(instances(result.container, 'emoji')).toHaveLength(5);
		expect(instances(result.container, 'sparkle')).toHaveLength(animatedMfm ? 2 : 0);

		await result.rerender({ text: `${text}!` });

		expect(instances(result.container)).toEqual(before);
		expect(probes.state.mounted).toHaveLength(before.length);
		expect(probes.state.unmounted).toEqual([]);

		const emojiBefore = instances(result.container, 'emoji');
		await result.rerender({ text: '$[sparkle 😀] $[sparkle 😁] **😀 😀** [😀](https://example.com) trailing!' });
		const emojiAfter = instances(result.container, 'emoji');
		expect(emojiAfter[1]).not.toEqual(emojiBefore[1]);
		expect(emojiAfter.filter((_, index) => index !== 1)).toEqual(emojiBefore.filter((_, index) => index !== 1));
		expect(probes.state.unmounted).toEqual(['emoji']);
	});

	test.each([
		['emoji', '😀', '😁', { emoji: '😁' }],
		['customEmoji', ':first:', ':second:', { name: 'second' }],
		['url', 'https://example.com/first', 'https://example.com/second', { url: 'https://example.com/second' }],
		['link', '[label](https://example.com/first)', '[label](https://example.com/second)', { url: 'https://example.com/second' }],
		['mention', '@alice', '@bob', { username: 'bob' }],
		['mention', '@alice@first.example', '@alice@second.example', { host: 'second.example' }],
		['hashtag', '#first', '#second', { to: '/tags/second' }],
		['inlineCode', '`first`', '`second`', { code: 'second' }],
		['code', '```js\nfirst\n```', '```js\nsecond\n```', { code: 'second', lang: 'js' }],
		['code', '```js\ncode\n```', '```ts\ncode\n```', { code: 'code', lang: 'ts' }],
		['time', '$[unixtime 1700000000]', '$[unixtime 1800000000]', { time: 1800000000000 }],
		['search', 'first 検索', 'second 検索', { q: 'second' }],
	] as const)('refreshes setup state in %s when %s becomes %s', async (component, text, nextText, expectedProps) => {
		const result = render(Mfm, { props: { text } });
		const before = instances(result.container, component);
		expect(before).toHaveLength(1);

		await result.rerender({ text: nextText });

		expect(instances(result.container, component)).not.toEqual(before);
		expect(initialProps(result.container, component)).toMatchObject(expectedProps);
		expect(probes.state.unmounted).toEqual([component]);
	});

	test('replaces the component when a token changes type', async () => {
		const result = render(Mfm, { props: { text: '😀' } });

		await result.rerender({ text: ':sample:' });

		expect(instances(result.container, 'emoji')).toEqual([]);
		expect(initialProps(result.container, 'customEmoji')).toMatchObject({ name: 'sample' });
		expect(probes.state.unmounted).toEqual(['emoji']);
	});

	test('refreshes emoji and mention identity when the author host changes', async () => {
		const author = { username: 'alice', host: 'first.example' } as Misskey.entities.UserLite;
		const result = render(Mfm, { props: { text: ':sample: @alice', author } });
		const before = instances(result.container);

		await result.rerender({ author: { ...author, host: 'second.example' } });

		expect(instances(result.container)).not.toEqual(before);
		expect(initialProps(result.container, 'customEmoji')).toMatchObject({ host: 'second.example' });
		expect(initialProps(result.container, 'mention')).toMatchObject({ host: 'second.example' });
		expect(probes.state.unmounted).toHaveLength(2);
	});

	test('refreshes a remote emoji when it starts resolving to a local emoji', async () => {
		const author = { username: 'alice', host: 'remote.example' } as Misskey.entities.UserLite;
		const result = render(Mfm, { props: { text: ':sample: trailing', author } });
		expect(initialProps(result.container, 'customEmoji')).toMatchObject({ host: 'remote.example' });
		probes.customEmojisMap.set('sample', { url: 'https://example.com/sample.png' });

		await result.rerender({ text: ':sample: trailing!' });

		expect(initialProps(result.container, 'customEmoji')).toMatchObject({ host: null });
		expect(probes.state.unmounted).toEqual(['customEmoji']);
	});

	test('keeps a link and its unchanged emoji when only its label changes', async () => {
		const result = render(Mfm, { props: { text: '[😀 first](https://example.com)' } });
		const before = instances(result.container);

		await result.rerender({ text: '[😀 second](https://example.com)' });

		expect(instances(result.container)).toEqual(before);
		expect(result.container.textContent).toContain('second');
		expect(probes.state.unmounted).toEqual([]);
	});
});
