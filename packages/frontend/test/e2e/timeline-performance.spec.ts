/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { api, registerUser, resetState } from './shared.js';

async function scrollList(page: Page, bottom: boolean) {
	await page.locator('[data-virtual-list]').first().evaluate((list, toBottom) => {
		let container = list.parentElement;
		while (container && !['auto', 'scroll'].includes(getComputedStyle(container).overflowY)) container = container.parentElement;
		if (container) container.scrollTop = toBottom ? container.scrollHeight : 0;
		else window.scrollTo(0, toBottom ? document.documentElement.scrollHeight : 0);
	}, bottom);
}

test('keeps three Deck timelines independent with 500 loaded notes each', async ({ page, baseURL }, testInfo) => {
	const url = baseURL!;
	await page.setViewportSize({ width: 1600, height: 900 });
	await resetState(url);
	await registerUser(url, 'admin', 'password', true);
	const user = await registerUser(url, 'deckreader', 'password');
	const account = await api(url, 'i', { i: user.token });
	await api(url, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
	const { createdNote: seed } = await api(url, 'notes/create', { i: user.token, text: 'Deck seed' });
	const notes = Array.from({ length: 500 }, (_, i) => ({ ...seed, id: `deck${String(500 - i).padStart(6, '0')}`, createdAt: '2020-01-01T00:00:00Z', text: `Deck fixture ${i}` }));
	await page.addInitScript(({ data, server }) => {
		localStorage.setItem('account', JSON.stringify(data));
		localStorage.setItem('lang', 'en-US');
		localStorage.setItem('ui', 'deck');
		const columns = ['one', 'two', 'three'].map(id => ({ id, type: 'tl', tl: 'home', name: id, width: 400 }));
		const profile = { name: 'Performance', columns, layout: columns.map(column => [column.id]) };
		const scope = { server, account: data.id };
		localStorage.setItem('preferences', JSON.stringify({
			id: 'performance', type: 'main', version: '2026.10.1-pari.2', modifiedAt: Date.now(), name: 'Performance',
			preferences: { 'deck.profile': [[scope, profile.name, {}]], 'deck.profiles': [[scope, [profile], {}]] },
		}));
	}, { data: { ...account, token: user.token }, server: new URL(url).host });
	await page.route(/\/api\/notes\/timeline(?:\?|$)/, route => {
		const data = route.request().postDataJSON() ?? {};
		return route.fulfill({ json: data.sinceId || data.untilId ? [] : notes });
	});
	await page.goto(url);
	const lists = page.locator('[data-virtual-list]');
	await expect(lists).toHaveCount(3);
	for (let i = 0; i < 3; i++) await expect(lists.nth(i)).toHaveAttribute('data-total-items', '500');
	await lists.first().evaluate(list => {
		let container = list.parentElement;
		while (container && !['auto', 'scroll'].includes(getComputedStyle(container).overflowY)) container = container.parentElement;
		container!.scrollTop = 5000;
	});
	await expect(lists.first().locator(`[data-virtual-item="${notes[0].id}"]`)).toHaveCount(0);
	for (let i = 1; i < 3; i++) await expect(lists.nth(i).locator(`[data-virtual-item="${notes[0].id}"]`)).toBeVisible();
	const mounted = await lists.evaluateAll(elements => elements.map(el => el.querySelectorAll('[data-virtual-item]').length));
	for (const count of mounted) expect(count).toBeLessThan(40);
	await testInfo.attach('deck-metrics', { body: JSON.stringify({ loadedPerColumn: 500, mounted }, null, 2), contentType: 'application/json' });
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
	test(`bounds mounted notes and retains state at ${viewport.width}px`, async ({ page, baseURL }, testInfo) => {
		const url = baseURL!;
		await page.setViewportSize(viewport);
		await resetState(url);
		await registerUser(url, 'admin', 'password', true);
		const user = await registerUser(url, 'reader', 'password');
		const account = await api(url, 'i', { i: user.token });
		await api(url, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
		const { createdNote: seed } = await api(url, 'notes/create', { i: user.token, text: 'Performance seed' });
		const notes = Array.from({ length: 500 }, (_, i) => ({
			...seed,
			id: `performance${String(500 - i).padStart(6, '0')}`,
			createdAt: new Date(Date.UTC(2020, 0, 1, 12) - i * 60000).toISOString(),
			cw: i === 0 ? 'Performance content warning' : null,
			text: i === 0 ? '$[sparkle Performance hidden content]' : `Performance fixture ${i}\n${'Variable height content. '.repeat(1 + i % 12)}`,
		}));
		await page.addInitScript(data => {
			localStorage.setItem('account', JSON.stringify(data));
			localStorage.setItem('lang', 'en-US');
		}, { ...account, token: user.token });
		let loaded = 0;
		await page.route(/\/api\/notes\/timeline(?:\?|$)/, async route => {
			const data = route.request().postDataJSON() ?? {};
			if (data.sinceId) {
				await route.fulfill({ json: [] });
				return;
			}
			const start = data.untilId ? notes.findIndex(note => note.id === data.untilId) + 1 : 0;
			const end = Math.min(notes.length, start + (data.limit ?? 15));
			loaded = Math.max(loaded, end);
			await route.fulfill({ json: notes.slice(start, end) });
		});
		await page.route(/\/api\/notes\/show(?:\?|$)/, async route => {
			const data = route.request().postDataJSON();
			const note = notes.find(item => item.id === data.noteId);
			if (note) await route.fulfill({ json: note });
			else await route.continue();
		});
		await page.route(/\/api\/notes\/(children|conversation|renotes|reactions|clips)(?:\?|$)/, route => route.fulfill({ json: [] }));

		const errors: string[] = [];
		const rejections: unknown[] = [];
		await page.exposeFunction('recordPerformanceRejection', (reason: unknown) => rejections.push(reason));
		await page.addInitScript(() => {
			window.addEventListener('unhandledrejection', event => {
				const reason = event.reason;
				(window as unknown as { recordPerformanceRejection: (reason: unknown) => void }).recordPerformanceRejection({ code: reason?.code, message: reason?.message, id: reason?.id });
			});
		});
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(url);
		const first = page.locator(`[data-virtual-item="${notes[0].id}"]`);
		await expect(first).toBeVisible();
		await expect(first.getByText('Performance hidden content', { exact: true })).toHaveCount(0);
		await first.getByRole('button', { name: /^Show content/ }).click();
		await expect(first.getByText('Performance hidden content', { exact: true })).toBeVisible();
		const reactionStarted = Promise.withResolvers<void>();
		const reactionFinished = Promise.withResolvers<void>();
		await page.route(/\/api\/notes\/reactions\/create(?:\?|$)/, async route => {
			reactionStarted.resolve();
			await reactionFinished.promise;
			await route.fulfill({ status: 204 });
		});
		await first.locator('footer button:has(.ti-heart)').first().click();
		await reactionStarted.promise;
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

		let maximumMounted = 0;
		for (let pass = 0; loaded < notes.length && pass < 30; pass++) {
			const previous = loaded;
			await scrollList(page, true);
			await expect.poll(() => loaded).toBeGreaterThan(previous);
			await expect.poll(async () => Number(await page.locator('[data-virtual-list]').first().getAttribute('data-total-items')) === loaded).toBe(true);
			await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			maximumMounted = Math.max(maximumMounted, await page.locator('[data-virtual-item]').count());
		}
		expect(loaded).toBe(500);
		await expect(first).toHaveCount(0);
		// The reaction completes after its row was unmounted, and must reach retained note data.
		reactionFinished.resolve();
		expect(maximumMounted).toBeLessThan(40);
		await scrollList(page, false);
		await expect(first).toBeVisible();
		await expect(first.getByText('Performance hidden content', { exact: true })).toBeVisible();
		await expect(first.locator('button span').filter({ hasText: /^1$/ })).toBeVisible();

		// A resize above the visible anchor must not move the content being read.
		await page.locator('[data-virtual-list]').first().evaluate(list => {
			let container = list.parentElement;
			while (container && !['auto', 'scroll'].includes(getComputedStyle(container).overflowY)) container = container.parentElement;
			if (container) container.scrollTop = 2000;
			else window.scrollTo(0, 2000);
		});
		await expect.poll(() => first.count()).toBe(0);
		const anchor = await page.locator('[data-virtual-item]').evaluateAll(rows => {
			const row = rows.find(el => el.getBoundingClientRect().top > 180)!;
			return { id: (row as HTMLElement).dataset.virtualItem!, top: row.getBoundingClientRect().top };
		});
		await page.locator(`[data-virtual-item="${anchor.id}"]`).evaluate(row => {
			const previous = Array.from(row.parentElement!.querySelectorAll<HTMLElement>('[data-virtual-item]')).findLast(item => item.getBoundingClientRect().bottom <= 0)!;
			previous.style.height = `${previous.getBoundingClientRect().height + 120}px`;
		});
		await expect.poll(async () => Math.abs((await page.locator(`[data-virtual-item="${anchor.id}"]`).boundingBox())!.y - anchor.top)).toBeLessThan(3);
		await page.locator(`[data-virtual-item="${anchor.id}"] a[href="/notes/${anchor.id}"]`).first().click();
		await expect(page).toHaveURL(new RegExp(`/notes/${anchor.id}$`));
		await page.goBack();
		await expect.poll(async () => Math.abs((await page.locator(`[data-virtual-item="${anchor.id}"]`).boundingBox())!.y - anchor.top)).toBeLessThan(5);

		await scrollList(page, false);
		await page.locator('[data-testid="open-post-form"]:visible').first().click();
		await expect(page.getByTestId('post-form-text').last()).toBeFocused();
		await page.getByTestId('post-form-text').last().fill('Performance composer regression');
		await page.locator('button:has(.ti-mood-happy):visible').last().click();
		const picker = page.locator('.omfetrab:visible');
		await expect(picker).toBeVisible();
		const emoji = picker.locator('button[data-emoji]:visible').first();
		const selectedEmoji = await emoji.getAttribute('data-emoji');
		await emoji.click();
		await expect.poll(async () => (await page.getByTestId('post-form-text').last().inputValue()).includes(selectedEmoji!)).toBe(true);
		await picker.locator('input[type="search"]').press('Escape');
		await expect(picker).toHaveCount(0);
		const image = await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			canvas.width = 64;
			canvas.height = 32;
			canvas.getContext('2d')!.fillRect(0, 0, 64, 32);
			return canvas.toDataURL('image/png').split(',')[1];
		});
		const choosing = page.waitForEvent('filechooser');
		await page.locator('button:has(.ti-photo-plus):visible').last().click();
		const uploaded = page.waitForResponse(response => response.url().endsWith('/api/drive/files/create') && response.ok());
		await (await choosing).setFiles({ name: 'performance.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
		const posted = page.waitForResponse(response => response.url().endsWith('/api/notes/create') && response.ok());
		await page.getByTestId('post-form-submit').last().click();
		await uploaded;
		expect((await (await posted).json()).createdNote.files).toHaveLength(1);
		await expect(page.getByTestId('post-form-text')).toHaveCount(0);
		expect(errors, JSON.stringify(rejections)).toEqual([]);
		await testInfo.attach('timeline-metrics', { body: JSON.stringify({ viewport, loaded, maximumMounted, errors }, null, 2), contentType: 'application/json' });
	});
}
