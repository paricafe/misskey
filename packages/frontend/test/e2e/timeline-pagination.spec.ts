/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Locator } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { api, registerUser, resetState } from './shared.js';

async function scrollList(list: Locator, bottom: boolean) {
	await list.evaluate((element, toBottom) => {
		let container = element.parentElement;
		while (container && !['auto', 'scroll'].includes(getComputedStyle(container).overflowY)) container = container.parentElement;
		if (container) container.scrollTop = toBottom ? container.scrollHeight : 0;
		else window.scrollTo(0, toBottom ? document.documentElement.scrollHeight : 0);
	}, bottom);
}

for (const scenario of [
	{ name: 'desktop', width: 1280, height: 900, ui: 'universal', profile: false },
	{ name: 'mobile', width: 390, height: 844, ui: 'universal', profile: false },
	{ name: 'Deck', width: 1600, height: 900, ui: 'deck', profile: false },
	{ name: 'profile', width: 1280, height: 900, ui: 'universal', profile: true },
]) {
	test(`keeps the reading position after one automatic page in ${scenario.name}`, async ({ page, baseURL }, testInfo) => {
		const url = baseURL!;
		await page.setViewportSize(scenario);
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await resetState(url);
		await registerUser(url, 'admin', 'password', true);
		const user = await registerUser(url, 'paginationreader', 'password');
		const account = await api(url, 'i', { i: user.token });
		const metadata = await api(url, 'meta', {});
		await api(url, 'i/registry/set', { i: user.token, scope: ['client', 'base'], key: 'accountSetupWizard', value: -1 });
		const { createdNote: seed } = await api(url, 'notes/create', { i: user.token, text: 'Pagination seed' });
		const notes = Array.from({ length: 500 }, (_, i) => ({
			...seed,
			id: `pagination${String(500 - i).padStart(6, '0')}`,
			createdAt: new Date(Date.UTC(2020, 0, 1, 12) - i * 60000).toISOString(),
			text: `Pagination fixture ${i}\n${'Variable-height pagination content. '.repeat(1 + i % 12)}`,
		}));
		await page.addInitScript(({ data, server, ui }) => {
			const animationIds: string[] = [];
			Object.assign(window, { timelineAnimationIds: animationIds });
			const animate = HTMLElement.prototype.animate;
			HTMLElement.prototype.animate = function (this: HTMLElement, keyframes, options) {
				if (this.dataset.virtualItem) animationIds.push(this.dataset.virtualItem);
				return animate.call(this, keyframes, options);
			};
			localStorage.setItem('account', JSON.stringify(data));
			localStorage.setItem('lang', 'en-US');
			localStorage.setItem('ui', ui);
			if (ui === 'deck') {
				const profile = { name: 'Pagination', columns: [{ id: 'one', type: 'tl', tl: 'home', name: 'one', width: 500 }], layout: [['one']] };
				const scope = { server, account: data.id };
				localStorage.setItem('preferences', JSON.stringify({
					id: 'pagination', type: 'main', version: '2026.10.1-pari.3', modifiedAt: Date.now(), name: 'Pagination',
					preferences: { 'deck.profile': [[scope, profile.name, {}]], 'deck.profiles': [[scope, [profile], {}]] },
				}));
			}
		}, { data: { ...account, token: user.token }, server: new URL(metadata.uri).host, ui: scenario.ui });

		const release = Promise.withResolvers<void>();
		let olderRequests = 0;
		let loaded = 0;
		await page.route(scenario.profile ? /\/api\/users\/notes(?:\?|$)/ : /\/api\/notes\/timeline(?:\?|$)/, async route => {
			const data = route.request().postDataJSON() ?? {};
			if (data.sinceId || data.withFiles) return route.fulfill({ json: [] });
			if (data.untilId) {
				olderRequests++;
				if (olderRequests === 1) {
					await release.promise;
				}
			}
			const start = data.untilId ? notes.findIndex(note => note.id === data.untilId) + 1 : 0;
			const end = Math.min(notes.length, start + (data.limit ?? 15));
			loaded = Math.max(loaded, end);
			return route.fulfill({ json: notes.slice(start, end) });
		});
		await page.route(/\/api\/notes\/(children|conversation|renotes|reactions|clips)(?:\?|$)/, route => route.fulfill({ json: [] }));
		await page.goto(scenario.profile ? `${url}/@paginationreader/notes` : url);
		const list = page.locator('[data-virtual-list]').first();
		const initialCount = scenario.profile ? 10 : 15;
		await expect(list).toHaveAttribute('data-total-items', String(initialCount));
		await expect.poll(async () => {
			if (olderRequests === 0) await scrollList(list, true);
			return olderRequests;
		}).toBe(1);
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		const anchor = await list.evaluate(element => {
			let container = element.parentElement;
			while (container && !['auto', 'scroll'].includes(getComputedStyle(container).overflowY)) container = container.parentElement;
			const viewportTop = container?.getBoundingClientRect().top ?? 0;
			const row = Array.from(element.querySelectorAll<HTMLElement>('[data-virtual-item]')).find(item => item.getBoundingClientRect().bottom > viewportTop + 120)!;
			return { id: row.dataset.virtualItem!, top: row.getBoundingClientRect().top, scrollTop: container?.scrollTop ?? window.scrollY };
		});
		release.resolve();
		await expect.poll(() => loaded).toBeGreaterThan(initialCount);
		await page.waitForTimeout(1000);
		const after = await list.evaluate((element, id) => {
			let container = element.parentElement;
			while (container && !['auto', 'scroll'].includes(getComputedStyle(container).overflowY)) container = container.parentElement;
			return {
				anchorTop: element.querySelector<HTMLElement>(`[data-virtual-item="${id}"]`)?.getBoundingClientRect().top ?? null,
				scrollTop: container?.scrollTop ?? window.scrollY,
				mounted: element.querySelectorAll('[data-virtual-item]').length,
			};
		}, anchor.id);
		await testInfo.attach('pagination-position', { body: JSON.stringify({ scenario: scenario.name, olderRequests, loaded, anchor, after }, null, 2), contentType: 'application/json' });
		expect(olderRequests).toBe(1);
		expect(loaded).toBe(initialCount + 30);
		expect(after.anchorTop).not.toBeNull();
		expect(Math.abs(after.anchorTop! - anchor.top)).toBeLessThan(3);
		expect(after.mounted).toBeLessThan(40);

		await expect.poll(async () => {
			if (olderRequests === 1) await scrollList(list, true);
			return olderRequests;
		}).toBe(2);
		await expect(list).toHaveAttribute('data-total-items', String(initialCount + 60));
		await page.waitForTimeout(1000);
		expect(olderRequests).toBe(2);
		expect(await page.evaluate(() => (window as unknown as { timelineAnimationIds: string[] }).timelineAnimationIds)).toEqual([]);
		if (scenario.profile) return;

		await scrollList(list, false);
		await expect(list.locator(`[data-virtual-item="${notes[0].id}"]`)).toBeVisible();
		const { createdNote } = await api(url, 'notes/create', { i: user.token, text: 'Live note entrance regression' });
		const incoming = list.locator(`[data-virtual-item="${createdNote.id}"]`);
		await expect(incoming).toBeVisible();
		await expect.poll(() => page.evaluate(() => (window as unknown as { timelineAnimationIds: string[] }).timelineAnimationIds)).toContain(createdNote.id);
		await page.waitForTimeout(100);
		expect(await incoming.evaluate(element => element.getAnimations().some(animation => animation.playState === 'running'))).toBe(true);
	});
}
