/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { BASE_URL } from './utils.js';

async function pushFixture(page: Page) {
	const context = page.context();
	await context.grantPermissions(['notifications'], { origin: BASE_URL });
	await page.goto(BASE_URL);
	await page.evaluate(async () => {
		await navigator.serviceWorker.register('/sw.js');
		await navigator.serviceWorker.ready;
	});
	await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
	const worker = context.serviceWorkers()[0];
	const cdp = await context.newCDPSession(page);
	let registrationId: string | undefined;
	cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
		registrationId = registrations.find(r => r.scopeURL === BASE_URL + '/' && !r.isDeleted)?.registrationId;
	});
	await cdp.send('ServiceWorker.enable');
	await expect.poll(() => registrationId).toBeDefined();

	const log = await worker.evaluateHandle(() => {
		const scope = globalThis as unknown as {
			registration: ServiceWorkerRegistration;
			ExtendableEvent: { prototype: { waitUntil(promise: Promise<unknown>): void } };
		};
		const log = { completed: 0, shown: [] as { title: string; tag?: string; body?: string; data?: unknown }[] };
		const show = scope.registration.showNotification.bind(scope.registration);
		scope.registration.showNotification = async (title, options) => {
			await show(title, options);
			log.shown.push({ title, tag: options?.tag, body: options?.body, data: options?.data });
		};
		const proto = scope.ExtendableEvent.prototype;
		const waitUntil = proto.waitUntil;
		proto.waitUntil = function (promise) {
			waitUntil.call(this, promise.finally(() => { log.completed++; }));
		};
		return log;
	});
	return {
		worker,
		deliver: async (userId: string, text: string, type = 'newChatMessage') => {
			const completed = await log.evaluate(state => state.completed);
			await cdp.send('ServiceWorker.deliverPushMessage', {
				origin: BASE_URL, registrationId: registrationId!,
				data: JSON.stringify({ userId, type, dateTime: Date.now(), body: { fromUserId: 'sender', fromUser: { username: 'sender' }, text } }),
			});
			await expect.poll(() => log.evaluate(state => state.completed)).toBeGreaterThan(completed);
		},
		shown: () => log.evaluate(state => state.shown),
	};
}

async function setAccounts(page: Page, accountTokens: Record<string, string>) {
	await page.evaluate(async accountTokens => {
		await new Promise<void>((resolve, reject) => {
			const open = indexedDB.open('keyval-store');
			open.onsuccess = () => {
				const db = open.result;
				const tx = db.transaction('keyval', 'readwrite');
				tx.objectStore('keyval').put({ accountHost: 'local.test', accountTokens }, 'pizzax::base');
				tx.oncomplete = () => { db.close(); resolve(); };
				tx.onabort = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});
	}, accountTokens);
}

test('pushes from one sender replace only the same recipient, including after a temporary database error', async ({ page }) => {
	const f = await pushFixture(page);
	await setAccounts(page, { 'local.test/a': 'a', 'local.test/b': 'b' });
	await f.worker.evaluate(() => {
		const transaction = IDBDatabase.prototype.transaction;
		IDBDatabase.prototype.transaction = function () {
			IDBDatabase.prototype.transaction = transaction;
			throw new DOMException('temporary read error', 'AbortError');
		};
	});
	await f.deliver('a', 'first A');
	await f.deliver('b', 'first B');
	await f.deliver('a', 'updated A');
	const [first, other, updated] = await f.shown();
	expect(first.title).toBe('sender: first A');
	expect(other.title).toBe('sender: first B');
	expect(updated.title).toBe('sender: updated A');
	expect(first.tag).toBeTruthy();
	expect(other.tag).not.toBe(first.tag);
	expect(updated.tag).toBe(first.tag);
});

test('an explicitly empty account store suppresses late pushes with no open client', async ({ page }) => {
	const f = await pushFixture(page);
	await setAccounts(page, {});
	await f.worker.evaluate(() => {
		const scope = globalThis as unknown as { clients: { matchAll: () => Promise<unknown[]> } };
		scope.clients.matchAll = async () => [];
	});
	await f.deliver('removed', 'private message');
	expect(await f.shown()).toEqual([]);
});

test('localStorage accounts can receive pushes and an offline worker without a window hides their content', async ({ page }) => {
	await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
	const f = await pushFixture(page);
	await expect.poll(() => page.evaluate(() => caches.has('mk-local-account-storage'))).toBe(true);
	await page.evaluate(() => {
		localStorage.setItem('idbfallback::pizzax::base', JSON.stringify({ accountHost: 'local.test', accountTokens: { 'local.test/a': 'a' } }));
	});
	await f.deliver('a', 'confirmed');
	expect(await f.shown()).toMatchObject([{ title: 'sender: confirmed' }]);
	await page.evaluate(() => localStorage.setItem('idbfallback::pizzax::base', JSON.stringify({ accountTokens: {} })));
	await f.deliver('a', 'removed');
	expect(await f.shown()).toHaveLength(1);
	await f.worker.evaluate(() => {
		// CDP needs a live network transport to deliver the push. The offline worker has no clients or fetch.
		const scope = globalThis as unknown as { clients: { matchAll: () => Promise<unknown[]> } };
		scope.clients.matchAll = async () => [];
		globalThis.fetch = async () => { throw new TypeError('offline'); };
	});
	await f.deliver('a', 'private message');
	const [, generic] = await f.shown();
	expect(generic.title).toBe(new URL(BASE_URL).host);
	expect(generic.body).toBeUndefined();
	expect(generic.data).toBeUndefined();
});
