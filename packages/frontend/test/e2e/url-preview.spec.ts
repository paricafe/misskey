/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { test, expect } from './fixtures.js';
import { api } from './shared.js';
import { BASE_URL, completeAccountSetup, registerUser, resetState, signIn } from './utils.js';

test('automatically expands ordinary players and waits for a click on sensitive previews', async ({ page }) => {
	await resetState();
	const admin = await registerUser('admin', 'pass', true);
	const { createdNote } = await api(BASE_URL, 'notes/create', {
		i: admin.token,
		text: 'https://preview.example.invalid/ordinary https://preview.example.invalid/sensitive',
	});
	await completeAccountSetup(admin.token);
	await signIn(page, 'admin', 'pass');
	await expect(page.getByTestId('open-post-form')).toBeVisible();
	await page.evaluate(() => {
		const profile = JSON.parse(localStorage.getItem('preferences')!);
		profile.preferences.expandUrlPreviewAutomatically = [[{}, true, {}]];
		localStorage.setItem('preferences', JSON.stringify(profile));
	});
	await page.route('**/url?*', async route => {
		const url = new URL(route.request().url()).searchParams.get('url')!;
		const path = new URL(url).pathname;
		await route.fulfill({ json: {
			url,
			title: path,
			sensitive: path === '/sensitive',
			player: { url: BASE_URL + '/fixture-player' + path, width: 400, height: 200 },
		} });
	});
	await page.route('**/fixture-player/**', route => route.fulfill({ contentType: 'text/html', body: '' }));
	await page.goto(`${BASE_URL}/notes/${createdNote.id}`);
	await expect(page.locator('iframe[src*="fixture-player/ordinary"]')).toBeVisible();
	const openPlayer = page.getByRole('button', { name: 'Open video player' });
	await expect(openPlayer).toBeVisible();
	await expect(page.locator('iframe[src*="fixture-player/sensitive"]')).toHaveCount(0);
	await openPlayer.click();
	await expect(page.locator('iframe[src*="fixture-player/sensitive"]')).toBeVisible();
});
