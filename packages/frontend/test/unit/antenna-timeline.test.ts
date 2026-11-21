/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { expect, test, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/vue';
import AntennaTimeline from '@/pages/antenna-timeline.vue';
import { i18n } from '@/i18n.js';

const { push, popupMenu } = vi.hoisted(() => ({ push: vi.fn(), popupMenu: vi.fn() }));
vi.mock('@/router.js', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/page.js', () => ({ definePage: vi.fn() }));
vi.mock('@/os.js', () => ({ popupMenu }));
vi.mock('@/cache.js', () => ({ antennasCache: { fetch: async () => [{ id: 'first', name: 'Existing' }] } }));
vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: async () => ({ id: 'first', name: 'Existing' }) }));
vi.mock('@/components/MkStreamingNotesTimeline.vue', () => ({ default: { template: '<div />' } }));

test('the antenna switcher opens the creation page directly', async () => {
	const page = render(AntennaTimeline, {
		props: { antennaId: 'first' },
		global: { stubs: {
			PageWithHeader: { props: ['actions'], template: '<button v-for="action in actions" @click="action.handler($event)">{{ action.text }}</button>' },
		} },
	});
	await fireEvent.click(await page.findByText(i18n.ts.selectAntenna));
	const menu = popupMenu.mock.lastCall![0] as { text?: string; action?: () => void }[];
	menu.find(item => item.text === i18n.ts.createNew)!.action!();
	expect(push).toHaveBeenCalledWith('/my/antennas/create');
});
