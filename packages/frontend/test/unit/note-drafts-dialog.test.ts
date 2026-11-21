/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/vue';
import MkNoteDraftsDialog from '@/components/MkNoteDraftsDialog.vue';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';

vi.mock('@/utility/misskey-api.js', () => ({ misskeyApi: vi.fn() }));
vi.mock('@/os.js', () => ({ confirm: vi.fn(), apiWithDialog: vi.fn() }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(os.confirm).mockResolvedValue({ canceled: false });
	vi.mocked(os.apiWithDialog).mockResolvedValue(undefined);
});
afterEach(cleanup);

test.each([false, true])('uses the selected account to list and manage drafts (scheduled=%s)', async scheduled => {
	const draft = { id: 'draft-b', text: 'Bob text', visibility: 'public', scheduledAt: scheduled ? Date.now() : null, isActuallyScheduled: scheduled };
	vi.mocked(misskeyApi).mockImplementation(endpoint => Promise.resolve(endpoint === 'notes/drafts/count' ? 1 : [draft]) as never);
	const result = render(MkNoteDraftsDialog, {
		props: { token: 'bob-token', draftLimit: 25, scheduled },
		global: {
			directives: { tooltip: {}, panel: {} },
			stubs: {
				MkModalWindow: { template: '<div><slot name="header"/><slot/></div>', methods: { close: vi.fn() } },
				MkStickyContainer: { template: '<div><slot/></div>' },
				MkPagination: { props: ['paginator'], mounted() { this.paginator.init(); }, template: '<slot :items="paginator.items.value"/>' },
				MkButton: { template: '<button><slot/></button>' },
				MkTime: true, I18n: true, Mfm: true, MkResult: true, MkAcct: true,
			},
		},
	});
	await waitFor(() => expect(result.container.querySelector('.ti-trash')).toBeTruthy());
	expect(result.container.textContent).toContain('(1/25)');
	expect(misskeyApi).toHaveBeenCalledWith('notes/drafts/count', {}, 'bob-token');
	expect(misskeyApi).toHaveBeenCalledWith('notes/drafts/list', expect.objectContaining({ scheduled }), 'bob-token', expect.any(AbortSignal));
	if (scheduled) {
		await fireEvent.click(result.getByText(i18n.ts._drafts.cancelSchedule));
		expect(os.apiWithDialog).toHaveBeenCalledWith('notes/drafts/update', { draftId: 'draft-b', isActuallyScheduled: false, scheduledAt: null }, 'bob-token');
	} else {
		await fireEvent.click(result.getByText(i18n.ts._drafts.restore));
		expect(result.emitted().restore).toEqual([[draft]]);
	}
	await waitFor(() => expect(result.container.querySelector('.ti-trash')).toBeTruthy());
	await fireEvent.click(result.container.querySelector('.ti-trash')!.closest('button')!);
	expect(os.apiWithDialog).toHaveBeenCalledWith('notes/drafts/delete', { draftId: 'draft-b' }, 'bob-token');
});
