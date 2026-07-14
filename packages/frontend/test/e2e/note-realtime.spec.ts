/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { BASE_URL, registerUser, resetState, signIn } from './utils.js';
import type { RegisteredUser } from './utils.js';

async function api(request: APIRequestContext, user: RegisteredUser, endpoint: string, data: Record<string, unknown>) {
	const response = await request.post(`${BASE_URL}/api/${endpoint}`, {
		data: { i: user.token, ...data },
	});
	expect(response.ok()).toBeTruthy();
	return response.status() === 204 ? null : await response.json();
}

async function closeSetupDialog(page: Page): Promise<void> {
	await page.locator('[data-testid="user-setup-dialog"] [data-testid="modal-window-close"]').click({ timeout: 30_000 });
	await page.getByTestId('modal-dialog-ok').click();
}

function counterButton(page: Page, noteText: string, iconClass: string) {
	const article = page.locator('article').filter({ hasText: noteText }).first();
	return article.locator(`footer button:has(i.${iconClass})`).first();
}

test.describe('realtime note counters and replies', () => {
	let alice: RegisteredUser;
	let bob: RegisteredUser;

	test.beforeEach(async ({ page }) => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
		bob = await registerUser('bob', 'bob1234');
		await signIn(page, 'alice', 'alice1234');
		await closeSetupDialog(page);
	});

	test('MkNote updates reply and renote counters in both directions', async ({ page, request }) => {
		const { createdNote: target } = await api(request, alice, 'notes/create', { text: 'timeline target' });
		await page.goto(BASE_URL);
		await page.getByText('timeline target', { exact: true }).waitFor();
		const replyButton = counterButton(page, 'timeline target', 'ti-arrow-back-up');
		const renoteButton = counterButton(page, 'timeline target', 'ti-repeat');

		const { createdNote: reply } = await api(request, bob, 'notes/create', {
			text: 'timeline reply',
			replyId: target.id,
		});
		await expect(replyButton.locator('p')).toHaveText('1');
		await api(request, bob, 'notes/delete', { noteId: reply.id });
		await expect(replyButton.locator('p')).toHaveCount(0);

		const { createdNote: renote } = await api(request, bob, 'notes/create', { renoteId: target.id });
		await expect(renoteButton.locator('p')).toHaveText('1');
		await api(request, bob, 'notes/delete', { noteId: renote.id });
		await expect(renoteButton.locator('p')).toHaveCount(0);
	});

	test('MkNoteDetailed refreshes visible replies and quotes', async ({ page, request }) => {
		const { createdNote: target } = await api(request, alice, 'notes/create', { text: 'detail target' });
		await page.goto(`${BASE_URL}/notes/${target.id}`);
		await page.getByText('detail target', { exact: true }).waitFor();
		const replyButton = counterButton(page, 'detail target', 'ti-arrow-back-up');
		const renoteButton = counterButton(page, 'detail target', 'ti-repeat');

		const { createdNote: reply } = await api(request, bob, 'notes/create', {
			text: 'visible live reply',
			replyId: target.id,
		});
		await expect(replyButton.locator('p')).toHaveText('1');
		await expect(page.getByText('visible live reply', { exact: true })).toBeVisible();
		await api(request, bob, 'notes/delete', { noteId: reply.id });
		await expect(replyButton.locator('p')).toHaveCount(0);
		await expect(page.getByText('visible live reply', { exact: true })).toHaveCount(0);

		const { createdNote: quote } = await api(request, bob, 'notes/create', {
			text: 'visible live quote',
			renoteId: target.id,
		});
		await expect(renoteButton.locator('p')).toHaveText('1');
		await expect(page.getByText('visible live quote', { exact: true })).toBeVisible();
		await api(request, bob, 'notes/delete', { noteId: quote.id });
		await expect(renoteButton.locator('p')).toHaveCount(0);
		await expect(page.getByText('visible live quote', { exact: true })).toHaveCount(0);
	});
});
