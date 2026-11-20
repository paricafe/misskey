/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile } from 'node:fs/promises';
import { locales } from 'i18n';
import { test, expect } from './fixtures.js';
import { completeAccountSetup, registerUser, resetState, signIn } from './utils.js';

test('exports only legacy reply and quote drafts after confirmation', async ({ page }) => {
	const locale = locales['en-US'];
	await resetState();
	const admin = await registerUser('admin', 'pass', true);
	await completeAccountSetup(admin.token);
	await signIn(page, 'admin', 'pass');
	await expect(page.getByTestId('open-post-form')).toBeVisible();

	const legacy = {
		'reply:first': { data: { text: 'old private reply' } },
		'channel:secondrenote:third': { data: { text: 'old private quote' } },
	};
	const shared = { ...legacy, 'note:other': { data: { text: 'ordinary draft' } }, 'channel:secondnote:other': {} };
	await page.evaluate(data => {
		localStorage.setItem('drafts', JSON.stringify(data));
		localStorage.setItem('drafts:other', JSON.stringify({ 'reply:first': { data: { text: 'modern draft' } } }));
	}, shared);

	await page.getByTestId('open-post-form').click();
	await page.getByRole('button', { name: locale.account, exact: true }).last().click();
	await page.getByText(locale._drafts.listDrafts, { exact: true }).click();
	const button = page.getByRole('button', { name: locale._drafts.exportLegacy });
	await expect(button).toBeVisible();
	await expect(page.getByText('old private reply')).toHaveCount(0);
	await button.click();
	await expect(page.getByText(locale._drafts.exportLegacyConfirm)).toBeVisible();
	await page.getByRole('button', { name: locale.cancel, exact: true }).last().click();
	await button.click();
	const downloading = page.waitForEvent('download');
	await page.getByRole('button', { name: locale.ok, exact: true }).last().click();
	const download = await downloading;
	expect(download.suggestedFilename()).toBe('misskey-legacy-drafts.json');
	expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(legacy);
	expect(await page.evaluate(() => JSON.parse(localStorage.getItem('drafts')!))).toEqual(shared);
});
