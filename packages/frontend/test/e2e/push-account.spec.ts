/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { BASE_URL, completeAccountSetup, registerUser, resetState, signIn } from './utils.js';

test.use({ channel: 'chromium' });

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
		const log = { completed: 0, shown: [] as { title: string; tag?: string; body?: string; data?: unknown; actions?: string[] }[] };
		const show = scope.registration.showNotification.bind(scope.registration);
		scope.registration.showNotification = async (title, options) => {
			await show(title, options);
			const actions = (options as { actions?: { action: string }[] } | undefined)?.actions;
			log.shown.push({ title, tag: options?.tag, body: options?.body, data: options?.data, ...(actions && { actions: actions.map(a => a.action) }) });
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
		deliver: async (userId: string | undefined, text: string, type = 'newChatMessage', dateTime = Date.now(), body: object = { fromUserId: 'sender', fromUser: { username: 'sender' }, text }) => {
			const completed = await log.evaluate(state => state.completed);
			await cdp.send('ServiceWorker.deliverPushMessage', {
				origin: BASE_URL, registrationId: registrationId!,
				data: JSON.stringify({ userId, type, dateTime, body }),
			});
			await expect.poll(() => log.evaluate(state => state.completed)).toBeGreaterThan(completed);
		},
		shown: () => log.evaluate(state => state.shown),
	};
}

async function setAccounts(page: Page, accountTokens: Record<string, string>, accountHost = 'local.test') {
	await page.evaluate(async ({ accountTokens, accountHost }) => {
		await new Promise<void>((resolve, reject) => {
			const open = indexedDB.open('keyval-store');
			open.onsuccess = () => {
				const db = open.result;
				const tx = db.transaction('keyval', 'readwrite');
				tx.objectStore('keyval').put({ accountHost, accountTokens }, 'pizzax::base');
				tx.oncomplete = () => { db.close(); resolve(); };
				tx.onabort = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});
	}, { accountTokens, accountHost });
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

const generic = { title: new URL(BASE_URL).host, tag: 'misskey-activity', body: undefined, data: undefined };
const followRequest = { type: 'receiveFollowRequest', userId: 'sender', user: { username: 'sender', host: null } };

test('a late push and a click on an old notification respect a removed recipient after storage recovery', async ({ page }) => {
	await resetState();
	const bob = await registerUser('bob', 'pass', true);
	await completeAccountSetup(bob.token);
	await signIn(page, 'bob', 'pass');
	await expect(page.getByTestId('open-post-form')).toBeVisible();
	const f = await pushFixture(page);
	const host = new URL(BASE_URL).host;
	await setAccounts(page, { [host + '/' + bob.id]: bob.token, [host + '/removed']: 'old' }, host);
	const reply = { type: 'reply', user: { username: 'sender', host: null }, note: { id: 'old-note', text: 'old reply' } };
	await f.deliver('removed', '', 'notification', Date.now(), reply);
	expect((await f.shown())[0].actions).toEqual(['reply']);
	await page.evaluate(host => {
		localStorage.setItem('idbfallback::pizzax::base', JSON.stringify({
			partialAccountState: true,
			removedAccountTokens: { [host + '/removed']: null },
		}));
	}, host);
	await page.goto(BASE_URL + '/settings');
	await expect(page.getByRole('button', { name: /Sign Out$/ })).toBeVisible();
	await f.deliver('removed', 'late private reply');
	expect((await f.shown())[1]).toEqual(generic);
	await f.worker.evaluate(async () => {
		const scope = globalThis as unknown as {
			registration: ServiceWorkerRegistration;
			NotificationEvent: new (type: string, init: { notification: Notification; action: string }) => Event;
			WindowClient: { prototype: { focus(): Promise<unknown> } };
		};
		const notifications = await scope.registration.getNotifications();
		const notification = notifications.find(n => n.data?.userId === 'removed');
		if (!notification) throw new Error('Earlier notification not found');
		// A synthetic click does not grant Chromium permission to focus the OS window.
		scope.WindowClient.prototype.focus = async function () { return this; };
		await new Promise<void>((resolve, reject) => {
			const event = new scope.NotificationEvent('notificationclick', { notification, action: 'reply' });
			Object.defineProperty(event, 'waitUntil', { value: (work: Promise<void>) => work.then(resolve, reject) });
			globalThis.dispatchEvent(event);
		});
	});
	await expect(page).toHaveURL(BASE_URL + '/');
	await expect(page.getByTestId('post-form-text')).toHaveCount(0);
	await f.deliver(bob.id, 'still signed in');
	expect((await f.shown())[2].title).toBe('sender: still signed in');
});

test('a worker with a saved credential offers follow request approval', async ({ page }) => {
	const f = await pushFixture(page);
	await setAccounts(page, { 'local.test/a': 'a' });
	await expect.poll(() => page.evaluate(() => caches.has('mk-indexeddb-account-storage'))).toBe(true);
	await f.deliver('a', '', 'notification', Date.now(), followRequest);
	expect((await f.shown())[0].actions).toEqual(['accept', 'reject']);
});

test('an explicitly empty account store shows a content-free alert for late pushes', async ({ page }) => {
	const f = await pushFixture(page);
	await setAccounts(page, {});
	await f.worker.evaluate(() => {
		const scope = globalThis as unknown as { clients: { matchAll: () => Promise<unknown[]> } };
		scope.clients.matchAll = async () => [];
	});
	await f.deliver('removed', 'private message');
	expect(await f.shown()).toEqual([generic]);
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
	await f.deliver('a', '', 'notification', Date.now(), followRequest);
	expect((await f.shown())[1].actions).toEqual(['showFollowRequests']);
	await page.evaluate(() => localStorage.setItem('idbfallback::pizzax::base', JSON.stringify({ accountTokens: {} })));
	await f.deliver('a', 'removed');
	expect((await f.shown())[2]).toEqual(generic);
	await f.worker.evaluate(() => {
		// CDP needs a live network transport to deliver the push. The offline worker has no clients or fetch.
		const scope = globalThis as unknown as { clients: { matchAll: () => Promise<unknown[]> } };
		scope.clients.matchAll = async () => [];
		globalThis.fetch = async () => { throw new TypeError('offline'); };
	});
	await f.deliver('a', 'private message');
	expect((await f.shown())[3]).toEqual(generic);
});

test('read receipts only clear notifications belonging to the confirmed account', async ({ page }) => {
	await resetState();
	const alice = await registerUser('alice', 'pass', true);
	await completeAccountSetup(alice.token);
	await signIn(page, 'alice', 'pass');
	await expect(page.getByTestId('open-post-form')).toBeVisible();
	const f = await pushFixture(page);
	const recipients = () => page.evaluate(async () => {
		const notifications = await (await navigator.serviceWorker.ready).getNotifications();
		return notifications.map(n => n.data?.userId).filter(Boolean);
	});
	await f.deliver('removed', 'private');
	expect(await f.shown()).toEqual([generic]);
	await f.deliver(alice.id, 'hello');
	await expect.poll(recipients).toEqual([alice.id]);
	await f.deliver('removed', '', 'readAllNotifications');
	expect(await recipients()).toEqual([alice.id]);
	await f.deliver(alice.id, '', 'readAllNotifications');
	await expect.poll(recipients).toEqual([]);
});

test('unattributed and unknown pushes show generic alerts and stale content is omitted', async ({ page }) => {
	const f = await pushFixture(page);
	await setAccounts(page, { 'local.test/a': 'a' });
	await f.deliver(undefined, 'no recipient');
	await f.deliver('a', 'unknown event', 'futureType');
	await f.deliver('unknown', 'read', 'readAllNotifications');
	await f.deliver('a', 'stale message', 'newChatMessage', Date.now() - 86_400_001);
	const shown = await f.shown();
	expect(shown.slice(0, 3)).toEqual([generic, generic, generic]);
	expect(shown[3]).toMatchObject({ title: generic.title, tag: 'read_notification', data: {} });
	expect(shown[3].body).not.toContain('stale message');
});
