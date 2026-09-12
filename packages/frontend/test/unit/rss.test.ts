/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, expect, test, vi } from 'vitest';
import { createApp, nextTick, reactive } from 'vue';
import WidgetRss from '@/widgets/WidgetRss.vue';
import WidgetRssTicker from '@/widgets/WidgetRssTicker.vue';

const settings = reactive({ url: 'https://example.com/feed', refreshIntervalSec: 60, maxEntries: 15 });

vi.mock('@/widgets/widget.js', () => ({
	useWidgetPropsManager: () => ({ widgetProps: settings, configure: vi.fn() }),
}));
vi.mock('@/components/MkContainer.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('@/components/MkMarqueeText.vue', () => ({ default: { template: '<div><slot /></div>' } }));

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

test.each([WidgetRss, WidgetRssTicker])('continues polling after changing the RSS interval', async (component) => {
	vi.useFakeTimers();
	vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
	const fetch = vi.spyOn(window, 'fetch').mockResolvedValue({ json: async () => ({ items: [] }) } as Response);
	fetch.mockClear();
	settings.refreshIntervalSec = 60;
	const app = createApp(component);
	app.component('MkLoading', { template: '<span />' });
	app.component('MkResult', { template: '<span />' });
	app.component('MkEllipsis', { template: '<span />' });
	app.mount(document.createElement('div'));
	try {
		expect(fetch).toHaveBeenCalledTimes(1);
		settings.refreshIntervalSec = 120;
		await nextTick();
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(119999);
		expect(fetch).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetch).toHaveBeenCalledTimes(3);
	} finally {
		app.unmount();
	}
	await vi.advanceTimersByTimeAsync(120000);
	expect(fetch).toHaveBeenCalledTimes(3);
});
