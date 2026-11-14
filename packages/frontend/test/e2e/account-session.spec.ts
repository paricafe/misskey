/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { BASE_URL, closeUserSetupDialog, registerUser, resetState, signIn } from './utils.js';
import type { RegisteredUser } from './utils.js';

type DeviceState = {
	accountTokens?: Record<string, string>;
	enablePreferencesAutoCloudBackup?: boolean;
};

async function deviceState(page: Page, patch?: DeviceState): Promise<DeviceState> {
	return page.evaluate((update) => new Promise<DeviceState>((resolve, reject) => {
		const open = indexedDB.open('keyval-store');
		open.onerror = () => reject(open.error);
		open.onsuccess = () => {
			const db = open.result;
			const transaction = db.transaction('keyval', update ? 'readwrite' : 'readonly');
			const store = transaction.objectStore('keyval');
			const read = store.get('pizzax::base');
			let state: DeviceState;
			read.onsuccess = () => {
				state = { ...read.result, ...update };
				if (update) store.put(state, 'pizzax::base');
			};
			transaction.oncomplete = () => {
				db.close();
				resolve(state);
			};
			transaction.onabort = () => {
				db.close();
				reject(transaction.error);
			};
		};
	}), patch);
}

async function canonicalHost(page: Page): Promise<string> {
	return page.evaluate(() => new URL(document.querySelector<HTMLMetaElement>('meta[property="instance_url"]')?.content || location.href).host);
}

async function signedInAccount(page: Page): Promise<{ id: string; token: string } | null> {
	return page.evaluate(() => JSON.parse(localStorage.getItem('account') ?? 'null'));
}

test.describe('account session persistence', () => {
	let alice: RegisteredUser;

	test.beforeEach(async () => {
		await resetState();
		await registerUser('admin', 'pass', true);
		alice = await registerUser('alice', 'alice1234');
	});

	test('unknown loginId on a fresh browser still mounts the sign-in UI', async ({ page }) => {
		await page.goto(`${BASE_URL}/?loginId=unknown-account`);
		await expect(page.getByTestId('signin')).toBeVisible();
		await expect(page).toHaveURL(`${BASE_URL}/`);
		expect(await signedInAccount(page)).toBeNull();
	});

	test('loginId switches accounts using credentials persisted in IndexedDB', async ({ page }) => {
		const bob = await registerUser('bob', 'bob1234');
		await signIn(page, 'alice', 'alice1234');
		await closeUserSetupDialog(page);
		const host = await canonicalHost(page);
		const state = await deviceState(page);
		await deviceState(page, { accountTokens: { ...state.accountTokens, [host + '/' + bob.id]: bob.token } });

		await page.goto(`${BASE_URL}/?loginId=${bob.id}`);
		await expect(page).toHaveURL(`${BASE_URL}/`);
		await closeUserSetupDialog(page);
		await expect(page.getByTestId('open-post-form')).toBeVisible();
		expect(await signedInAccount(page)).toMatchObject({ id: bob.id, token: bob.token });
		expect((await deviceState(page)).accountTokens?.[host + '/' + alice.id]).toBe(alice.token);
	});

	test('reauthentication replaces an existing stale saved token', async ({ page }) => {
		await signIn(page, 'alice', 'alice1234');
		await closeUserSetupDialog(page);
		const key = await canonicalHost(page) + '/' + alice.id;
		const state = await deviceState(page);
		await deviceState(page, { accountTokens: { ...state.accountTokens, [key]: 'revoked-session-token' } });
		await page.evaluate(() => localStorage.removeItem('account'));

		await signIn(page, 'alice', 'alice1234');
		await expect(page.getByTestId('open-post-form')).toBeVisible();
		const current = await signedInAccount(page);
		expect(current).toMatchObject({ id: alice.id, token: alice.token });
		expect((await deviceState(page)).accountTokens?.[key]).toBe(current?.token);
	});

	test('failed cloud backup does not prevent UI sign-out from clearing credentials', async ({ page }) => {
		await signIn(page, 'alice', 'alice1234');
		await closeUserSetupDialog(page);
		await deviceState(page, { enablePreferencesAutoCloudBackup: true });
		await page.evaluate(() => {
			const profile = JSON.parse(localStorage.getItem('preferences')!);
			profile.name = 'account-session-regression';
			localStorage.setItem('preferences', JSON.stringify(profile));
		});
		await page.route('**/api/i/registry/set', async route => {
			const body = route.request().postDataJSON();
			if (body.scope?.includes('backups')) {
				await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BACKUP_UNAVAILABLE' } }) });
			} else {
				await route.continue();
			}
		});
		await page.goto(`${BASE_URL}/settings`);
		await page.getByRole('button', { name: /Sign Out$/ }).click();
		const failedBackup = page.waitForResponse(response => response.url().endsWith('/api/i/registry/set') && response.status() === 503);
		await page.getByTestId('modal-dialog-ok').click();
		await failedBackup;

		await expect(page.getByTestId('signin')).toBeVisible({ timeout: 20_000 });
		expect(await signedInAccount(page)).toBeNull();
		expect((await deviceState(page)).accountTokens ?? {}).toEqual({});
	});
});
