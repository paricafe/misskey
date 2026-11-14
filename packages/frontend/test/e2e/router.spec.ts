/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { test } from './fixtures.js';
import {
	BASE_URL,
	resetState, registerUser,
	signIn, closeUserSetupDialogIfVisible,
} from './utils.js';

test.describe('Router transition', () => {
	test.beforeAll(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		await registerUser('alice', 'alice1234');
	});

	test.beforeEach(async ({ page }) => {
		await signIn(page, 'alice', 'alice1234');

		await page.waitForTimeout(1000);

		await closeUserSetupDialogIfVisible(page);
	});

	test.describe('Redirect', () => {
		test('redirect to user profile', async ({ page }) => {
			await page.goto(`${BASE_URL}/redirect-test`);
			await page.waitForURL('**/@alice');
		});
	});
});
