/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { test, expect } from './fixtures.js';
import { api } from './shared.js';
import { BASE_URL, completeAccountSetup, registerUser, resetState, signIn } from './utils.js';

test('test email accepts the saved default SMTP host and blocks unsaved edits', async ({ page }) => {
	await resetState();
	const admin = await registerUser('admin', 'pass', true);
	await api(BASE_URL, 'admin/update-meta', { i: admin.token, enableEmail: true, smtpHost: '' });
	await completeAccountSetup(admin.token);
	await signIn(page, 'admin', 'pass');
	await expect(page.getByTestId('open-post-form')).toBeVisible();
	await page.goto(`${BASE_URL}/admin/email-settings`);
	const send = page.getByRole('button', { name: 'Test email delivery' });
	await expect(send).toBeEnabled();
	const sender = page.locator('input[type=email]');
	const original = await sender.inputValue();
	await sender.fill('changed@example.invalid');
	await expect(send).toBeDisabled();
	await sender.fill(original);
	await expect(send).toBeEnabled();
	await send.click();
	await expect(page.getByPlaceholder('test@example.com')).toBeVisible();
});
