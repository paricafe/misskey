/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { api } from './shared.js';
import { BASE_URL, closeUserSetupDialog, completeAccountSetup, registerUser, resetState, signIn } from './utils.js';
import type { RegisteredUser } from './utils.js';

type DeviceState = {
	accountTokens?: Record<string, string>;
	accountInfos?: Record<string, { id: string }>;
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

async function regenerateToken(page: Page, password: string, offline = false) {
	await page.getByRole('button', { name: 'Regenerate login token' }).click();
	await page.getByPlaceholder('Password').fill(password);
	if (offline) await page.context().setOffline(true);
	await page.getByRole('button', { name: 'Continue' }).click();
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

	for (const action of ['remove fallback', 'sign in to Carol'] as const) {
		test(`a delayed fallback respects another tab's action: ${action}`, async ({ page, context }) => {
			const bob = await registerUser('bob', 'bob1234');
			await completeAccountSetup(alice.token);
			await signIn(page, 'alice', 'alice1234');
			await expect(page.getByTestId('open-post-form')).toBeVisible();
			const host = await canonicalHost(page);
			const key = host + '/' + bob.id;
			const state = await deviceState(page);
			await deviceState(page, { accountTokens: { ...state.accountTokens, [key]: bob.token } });
			const other = await context.newPage();
			await other.goto(BASE_URL + '/favicon.ico');
			await page.goto(BASE_URL + '/settings/security');
			await page.evaluate(token => {
				const fetch = window.fetch;
				window.fetch = async function(input, init) {
					const response = await fetch(input, init);
					if (String(input).endsWith('/api/i') && JSON.parse(String(init?.body)).i === token) {
						document.documentElement.dataset.fallbackPending = 'true';
						await new Promise(resolve => window.addEventListener('resume-fallback', resolve, { once: true }));
					}
					return response;
				};
			}, bob.token);
			await regenerateToken(page, 'alice1234');
			await expect(page.locator('html')).toHaveAttribute('data-fallback-pending', 'true');
			if (action === 'remove fallback') {
				const saved = await deviceState(other);
				delete saved.accountTokens![key];
				await deviceState(other, { accountTokens: saved.accountTokens });
				await page.evaluate(() => window.dispatchEvent(new Event('resume-fallback')));
				await expect(page.getByTestId('signin')).toBeVisible();
				expect(await signedInAccount(other)).toBeNull();
				expect((await deviceState(other)).accountTokens).toEqual({});
			} else {
				const carol = await registerUser('carol', 'carol1234');
				await completeAccountSetup(carol.token);
				// Delay the reload broadcast until the pending fallback has completed.
				await other.addInitScript(() => {
					const postMessage = BroadcastChannel.prototype.postMessage;
					BroadcastChannel.prototype.postMessage = function(value) {
						if (this.name !== 'native:reload') postMessage.call(this, value);
					};
				});
				await signIn(other, 'carol', 'carol1234');
				await expect(other.getByTestId('open-post-form')).toBeVisible();
				expect(await signedInAccount(page)).toMatchObject({ id: carol.id });
				await page.evaluate(() => window.dispatchEvent(new Event('resume-fallback')));
				await expect(page.locator('html')).not.toHaveAttribute('data-fallback-pending');
				expect(await signedInAccount(page)).toMatchObject({ id: carol.id, token: carol.token });
				expect((await deviceState(other)).accountTokens).toEqual({ [key]: bob.token, [host + '/' + carol.id]: carol.token });
			}
		});
	}

	for (const failure of ['localStorage', 'IndexedDB'] as const) {
		test(`a failed ${failure} login write leaves the guest able to sign in again`, async ({ page }) => {
			await completeAccountSetup(alice.token);
			await page.addInitScript(failure => {
				if (sessionStorage.getItem('storage-failed')) return;
				if (failure === 'localStorage') {
					const setItem = Storage.prototype.setItem;
					Storage.prototype.setItem = function(key, value) {
						if (this === localStorage && key === 'account') {
							Storage.prototype.setItem = setItem;
							sessionStorage.setItem('storage-failed', 'yes');
							throw new DOMException('Device storage full', 'QuotaExceededError');
						}
						return setItem.call(this, key, value);
					};
				} else {
					const put = IDBObjectStore.prototype.put;
					IDBObjectStore.prototype.put = function(value, key) {
						if (key === 'pizzax::base' && Object.keys(value.accountTokens ?? {}).length > 0) {
							IDBObjectStore.prototype.put = put;
							sessionStorage.setItem('storage-failed', 'yes');
							this.transaction.abort();
						}
						return put.call(this, value, key);
					};
				}
			}, failure);
			await signIn(page, 'alice', 'alice1234');
			await page.getByTestId('modal-dialog-ok').click();
			expect(await signedInAccount(page)).toBeNull();
			const state = await deviceState(page);
			expect(state.accountTokens ?? {}).toEqual({});
			expect(state.accountInfos ?? {}).toEqual({});
			await signIn(page, 'alice', 'alice1234');
			await expect(page.getByTestId('open-post-form')).toBeVisible();
			expect(await signedInAccount(page)).toMatchObject({ id: alice.id });
		});
	}

	for (const hasBackup of [true, false]) {
		test(`regenerating a token preserves device data (backup account: ${hasBackup})`, async ({ page }) => {
			const bob = hasBackup ? await registerUser('bob', 'bob1234') : null;
			await completeAccountSetup(alice.token);
			if (bob) await completeAccountSetup(bob.token);
			await signIn(page, bob ? 'bob' : 'alice', bob ? 'bob1234' : 'alice1234');
			await expect(page.getByTestId('open-post-form')).toBeVisible();
			const host = await canonicalHost(page);
			if (bob) {
				await page.getByTestId('open-post-form').click();
				await page.getByTestId('post-form-text').fill('A draft saved by Bob');
				await expect.poll(() => page.evaluate(() => localStorage.getItem('drafts'))).toContain('A draft saved by Bob');
				const state = await deviceState(page);
				await deviceState(page, { accountTokens: { ...state.accountTokens, [host + '/' + alice.id]: alice.token } });
				await page.goto(`${BASE_URL}/?loginId=${alice.id}`);
				await expect.poll(() => signedInAccount(page)).toMatchObject({ id: alice.id });
				await expect(page.getByTestId('open-post-form')).toBeVisible();
			}
			await page.evaluate(() => localStorage.setItem('scratchpad', 'local unsaved text'));
			await page.goto(`${BASE_URL}/settings/security`);
			await regenerateToken(page, 'alice1234');
			if (bob) {
				await expect.poll(() => signedInAccount(page)).toMatchObject({ id: bob.id, token: bob.token });
				expect((await deviceState(page)).accountTokens?.[host + '/' + bob.id]).toBe(bob.token);
				await page.reload();
				await page.getByTestId('open-post-form').click();
				await expect(page.getByTestId('post-form-text')).toHaveValue('A draft saved by Bob');
			} else {
				await expect(page.getByTestId('signin')).toBeVisible();
				expect(await signedInAccount(page)).toBeNull();
			}
			expect((await deviceState(page)).accountTokens?.[host + '/' + alice.id]).toBeUndefined();
			expect(await page.evaluate(() => localStorage.getItem('scratchpad'))).toBe('local unsaved text');
		});
	}

	test('token reset removes only this account and device subscription after verifying the password', async ({ page }) => {
		const bob = await registerUser('bob', 'bob1234');
		const endpoint = 'https://localhost/push/this-device';
		const otherDevice = 'https://localhost/push/other-device';
		const registration = { endpoint, auth: 'AQ==', publickey: 'Ag==' };
		const subscribed = (token: string, url = endpoint) => api(BASE_URL, 'sw/show-registration', { i: token, endpoint: url });
		await api(BASE_URL, 'sw/register', { ...registration, i: alice.token });
		await api(BASE_URL, 'sw/register', { ...registration, i: bob.token });
		await api(BASE_URL, 'sw/register', { ...registration, i: alice.token, endpoint: otherDevice });
		await completeAccountSetup(alice.token);
		await signIn(page, 'alice', 'alice1234');
		await expect(page.getByTestId('open-post-form')).toBeVisible();
		await page.goto(`${BASE_URL}/settings/security`);
		await page.evaluate(async endpoint => {
			await navigator.serviceWorker.register('/sw.js');
			await navigator.serviceWorker.ready;
			Object.defineProperty(PushManager.prototype, 'getSubscription', {
				value: async () => ({ endpoint, getKey: (name: string) => Uint8Array.of(name === 'auth' ? 1 : 2).buffer }),
			});
		}, endpoint);

		await regenerateToken(page, 'wrong-password');
		await page.getByTestId('modal-dialog-ok').click();
		expect(await subscribed(alice.token)).toMatchObject({ userId: alice.id });
		await expect(page.getByPlaceholder('Password')).toHaveCount(0);
		await regenerateToken(page, 'alice1234');
		await expect(page.getByTestId('signin')).toBeVisible();
		await signIn(page, 'alice', 'alice1234');
		await expect(page.getByTestId('open-post-form')).toBeVisible();
		const current = (await signedInAccount(page))!;
		expect(current.token).not.toBe(alice.token);
		expect(await subscribed(current.token)).toBeNull();
		expect(await subscribed(current.token, otherDevice)).toMatchObject({ userId: alice.id });
		expect(await subscribed(bob.token)).toMatchObject({ userId: bob.id });
	});

	test('a stalled push subscription lookup still allows the token to be reset', async ({ page }) => {
		await completeAccountSetup(alice.token);
		await signIn(page, 'alice', 'alice1234');
		await expect(page.getByTestId('open-post-form')).toBeVisible();
		await page.goto(`${BASE_URL}/settings/security`);
		await page.evaluate(async () => {
			await navigator.serviceWorker.register('/sw.js');
			await navigator.serviceWorker.ready;
			Object.defineProperty(PushManager.prototype, 'getSubscription', { value: () => new Promise(() => {}) });
		});
		const reset = page.waitForResponse(res => res.url().endsWith('/api/i/regenerate-token'));
		await regenerateToken(page, 'alice1234');
		const response = await reset;
		expect(response.status()).toBe(204);
		expect(response.request().postDataJSON()).not.toHaveProperty('pushSubscription');
		await expect(page.getByTestId('signin')).toBeVisible();
	});

	for (const failure of ['bad password', 'network'] as const) {
		test(`regenerating a token recovers from ${failure}`, async ({ page }) => {
			await completeAccountSetup(alice.token);
			await signIn(page, 'alice', 'alice1234');
			await expect(page.getByTestId('open-post-form')).toBeVisible();
			await page.goto(`${BASE_URL}/settings/security`);
			await regenerateToken(page, failure === 'bad password' ? 'incorrect' : 'alice1234', failure === 'network');
			await expect(page.getByTestId('modal-dialog-ok')).toBeVisible();
			if (failure === 'network') await page.context().setOffline(false);
			await page.getByTestId('modal-dialog-ok').click();
			await expect(page.locator('body')).not.toHaveAttribute('inert');
			await page.getByRole('button', { name: 'Regenerate login token' }).click();
			await expect(page.getByPlaceholder('Password')).toBeVisible();
			expect(await signedInAccount(page)).toMatchObject({ id: alice.id, token: alice.token });
		});
	}

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
