/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import { describe, beforeAll, test } from 'vitest';
import { api, signup } from '../utils.js';
import type * as misskey from 'misskey-js';

describe('following/list', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;
	let carol: misskey.entities.SignupResponse;

	beforeAll(async () => {
		alice = await signup({ username: 'alice' });
		bob = await signup({ username: 'bob' });
		carol = await signup({ username: 'carol' });
	}, 1000 * 60 * 2);

	test('通知設定なしのフォローのみの場合、空配列が返る', async () => {
		await api('following/create', { userId: bob.id }, alice);

		const res1 = await api('following/list', { notification: true }, alice);
		const res2 = await api('following/list', {}, alice);

		assert.strictEqual(res1.status, 200);
		assert.strictEqual(Array.isArray(res1.body), true);
		assert.strictEqual(res1.body.length, 0);

		assert.strictEqual(res2.status, 200);
		assert.strictEqual(Array.isArray(res2.body), true);
		assert.strictEqual(res2.body.length, 1);
		assert.strictEqual(res2.body[0].followeeId, bob.id);
	});

	test('通知設定ありのフォローがある場合、そのユーザーが返る', async () => {
		await api('following/create', { userId: carol.id, withReplies: false }, alice);
		await api('following/update', { userId: carol.id, notify: 'normal' }, alice);

		const res = await api('following/list', { notification: true }, alice);

		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.length, 1);
		assert.strictEqual(res.body[0].followeeId, carol.id);
	});

	test('複数ユーザーで通知設定ありの場合、全員返る', async () => {
		await api('following/update', { userId: bob.id, notify: 'normal' }, alice);

		const res = await api('following/list', { notification: true }, alice);

		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.length, 2);

		const ids = res.body.map((u) => u.followeeId).sort();
		assert.deepStrictEqual(ids, [bob.id, carol.id].sort());
	});

	test('通知設定をOFF（none）にすると notification: true な一覧から外れる', async () => {
		await api('following/update', { userId: bob.id, notify: 'none' }, alice);

		const res1 = await api('following/list', { notification: true }, alice);
		const res2 = await api('following/list', {}, alice);

		assert.strictEqual(res1.status, 200);
		assert.strictEqual(res1.body.length, 1);
		assert.strictEqual(res1.body[0].followeeId, carol.id);

		assert.strictEqual(res2.status, 200);
		assert.strictEqual(res2.body.length, 2);
		const ids = res2.body.map((u) => u.followeeId).sort();
		assert.deepStrictEqual(ids, [bob.id, carol.id].sort());
	});

	test('他のユーザーの通知対象は見えない', async () => {
		await api('following/create', { userId: carol.id }, bob);
		await api('following/update', { userId: carol.id, notify: 'normal' }, bob);

		const aliceRes = await api('following/list', { notification: true }, alice);
		const aliceIds = aliceRes.body.map((u) => u.followeeId);
		assert.strictEqual(aliceIds.includes(bob.id), false);

		const bobRes = await api('following/list', { notification: true }, bob);
		assert.strictEqual(bobRes.body.length, 1);
		assert.strictEqual(bobRes.body[0].followeeId, carol.id);

		await api('following/delete', { userId: carol.id }, bob);
	});

	test('normal通知設定時、投稿で通知が届く', async () => {
		await api('following/update', { userId: bob.id, notify: 'normal' }, alice);

		await api('notifications/mark-all-as-read', {}, alice);
		const textOnlyRes = await api('notes/create', {
			text: 'ファイルなしの投稿',
		}, bob);
		assert.strictEqual(textOnlyRes.status, 200);
		await setTimeout(100);

		const beforeRes = await api('i/notifications', {}, alice);
		assert.strictEqual(beforeRes.status, 200);
		const noteNotif = beforeRes.body.filter((n: { type: string; note?: { id: string } }) =>
			n.type === 'note' && n.note?.id === textOnlyRes.body.createdNote.id,
		);

		assert.strictEqual(noteNotif.length, 1, '投稿の通知が届かなかった');

		await api('following/update', { userId: bob.id, notify: 'none' }, alice);
		await api('notifications/mark-all-as-read', {}, alice);
	});

	test('limit パラメータが効く', async () => {
		await api('following/update', { userId: bob.id, notify: 'normal' }, alice);

		const allRes = await api('following/list', { notification: true }, alice);
		assert.strictEqual(allRes.status, 200);
		assert.strictEqual(allRes.body.length, 2);

		const res = await api('following/list', { notification: true, limit: 1 }, alice);
		assert.strictEqual(res.status, 200);
		assert.strictEqual(res.body.length, 1);
	});

	test('未認証の場合はエラー', async () => {
		const res = await api('following/list', {});
		assert.strictEqual(res.status, 401);
	});
});
