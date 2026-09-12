/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { EntityConverter } from '../src/entities.js';
import { NativeClient, NativeError } from '../src/native-client.js';
import { registerNotifications } from '../src/notifications-v2.js';
import { parameters } from '../src/parameters.js';
import { Routes } from '../src/routes.js';
import { CompatStore } from '../src/store.js';
import type { Json } from '../src/types.js';

const alice = { id: 'alice', username: 'alice', createdAt: '2026-01-01T00:00:00Z' };
const bob = { id: 'bob', username: 'bob', createdAt: '2026-01-01T00:00:00Z' };
const status = { id: 'opaque-note', userId: 'alice', user: alice, visibility: 'public', createdAt: '2026-01-01T00:00:00Z', text: 'A post', files: [] };
const event = (index: number, extra: Json = {}): Json => ({ id: `notification-${String(index).padStart(4, '0')}`, type: 'follow', user: bob, createdAt: '2026-01-02T00:00:00Z', ...extra });
const ids = (response: { json: () => Json }) => response.json().notification_groups.map((group: Json) => group.most_recent_notification_id);

async function fixture(t: TestContext, events: Json[]) {
	const app = Fastify();
	app.addHook('preValidation', async request => { request.query = parameters(request.query); request.body = parameters(request.body); });
	app.setErrorHandler((error, _request, reply) => reply.code(error instanceof NativeError ? error.status : (error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }));
	const store = new CompatStore(':memory:');
	const { client } = await store.createClient({ name: 'Notifications', scopes: ['read', 'write'], redirectUris: ['client://callback'] });
	const token = async (userId = 'alice', scopes = ['read', 'write']) => (await store.createGrant({ clientId: client.id, kind: 'user', userId, scopes, nativeToken: `native-${userId}` })).token;
	const calls: Array<{ endpoint: string; body: Json }> = [];
	let markedRead = 0;
	const native = new NativeClient({ baseUrl: 'http://native.example', publicUrl: 'https://social.example', transport: async request => {
		const endpoint = new URL(request.url).pathname.slice(5);
		if (endpoint === 'ping') return { status: 200, body: '{"pong":0}' };
		const body = JSON.parse(String(request.body));
		calls.push({ endpoint, body });
		if (endpoint === 'notifications/mark-all-as-read') { markedRead++; return { status: 204, body: '' }; }
		if (endpoint === 'notes/state') return { status: 200, body: '{"isFavorited":false,"isMutedThread":false}' };
		if (endpoint === 'users/show') return { status: 200, body: JSON.stringify({ ...(body.userId === 'alice' ? alice : bob), pinnedNoteIds: [] }) };
		assert.equal(endpoint, 'i/notifications');
		assert.equal(body.markAsRead, false, 'Listing must not mark native notifications as read');
		assert.ok(body.limit >= 1 && body.limit <= 100);
		const ascending = body.sinceId && !body.untilId;
		const rows = events.filter(item => (!body.sinceId || item.id > body.sinceId) && (!body.untilId || item.id < body.untilId))
			.sort((a, b) => (ascending ? 1 : -1) * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, body.limit);
		return { status: 200, body: JSON.stringify(rows) };
	} });
	registerNotifications(new Routes(app, { store, native, entities: new EntityConverter('https://social.example'), publicUrl: 'https://social.example' }));
	t.after(async () => { await app.close(); await store.close(); });
	return { app, store, events, calls, token, authorization: `Bearer ${await token()}`, markedRead: () => markedRead };
}

test('returns stable singleton groups with deduplicated accounts and statuses and string IDs', async t => {
	const f = await fixture(t, [event(1, { type: 'reaction', reaction: '❤', note: status }), event(2, { type: 'reaction', reaction: '❤️', note: status }), event(3)]);
	const response = await f.app.inject({ url: '/api/v2/notifications?expand_accounts=partial_avatars&grouped_types[]=favourite', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	const body = response.json();
	assert.equal(body.notification_groups.length, 3);
	assert.equal(body.accounts.length, 1);
	assert.equal(body.statuses.length, 1);
	assert.deepEqual(body.partial_accounts, []);
	assert.deepEqual(body.notification_groups.map((group: Json) => group.group_key), ['ungrouped-notification-0003', 'ungrouped-notification-0002', 'ungrouped-notification-0001']);
	for (const group of body.notification_groups) {
		assert.equal(group.notifications_count, 1);
		assert.equal(typeof group.most_recent_notification_id, 'string');
		assert.equal(group.page_min_id, group.most_recent_notification_id);
		assert.equal(group.page_max_id, group.most_recent_notification_id);
		assert.deepEqual(group.sample_account_ids, ['bob']);
	}
	assert.equal(body.notification_groups[0].status_id, undefined);
	assert.equal(f.markedRead(), 0);
});

test('distinguishes newest since_id pages from immediately newer min_id pages and emits descending links', async t => {
	const f = await fixture(t, Array.from({ length: 20 }, (_, index) => event(index + 1)));
	const request = (query: string) => f.app.inject({ url: `/api/v2/notifications?limit=3&${query}`, headers: { authorization: f.authorization } });
	assert.deepEqual(ids(await request('since_id=notification-0005')), ['notification-0020', 'notification-0019', 'notification-0018']);
	const min = await request('min_id=notification-0005');
	assert.deepEqual(ids(min), ['notification-0008', 'notification-0007', 'notification-0006']);
	assert.match(String(min.headers.link), /max_id=notification-0006[^>]*>; rel="next"/u);
	assert.match(String(min.headers.link), /min_id=notification-0008[^>]*>; rel="prev"/u);
	assert.deepEqual(ids(await request('min_id=notification-0005&max_id=notification-0008')), ['notification-0007', 'notification-0006']);
	assert.deepEqual(ids(await request('since_id=notification-0005&max_id=notification-0010')), ['notification-0009', 'notification-0008', 'notification-0007']);
});

test('fills a page after non-heart reactions, dismissed entries and hidden statuses are removed', async t => {
	const f = await fixture(t, [event(1), event(2), event(3), event(4, { type: 'reaction', reaction: '😀', note: status }), event(5, { type: 'mention', note: { ...status, isHidden: true } }), event(6, { user: alice })]);
	await f.store.put('dismissed-notification', 'alice', 'notification-0003', true);
	const response = await f.app.inject({ url: '/api/v2/notifications?limit=2&types[]=follow&account_id=bob', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(ids(response), ['notification-0002', 'notification-0001']);
	assert.ok(f.calls.length > 1);
	assert.equal(response.json().statuses.length, 0);
});

test('individual groups and account lists remain accessible beyond the latest hundred notifications', async t => {
	const f = await fixture(t, Array.from({ length: 125 }, (_, index) => event(index + 1)));
	const response = await f.app.inject({ url: '/api/v2/notifications/ungrouped-notification-0002', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(ids(response), ['notification-0002']);
	assert.equal(response.json().notification_groups[0].page_min_id, undefined);
	assert.equal(response.headers.link, undefined);
	assert.equal(f.calls.length, 2);
	const accounts = await f.app.inject({ url: '/api/v2/notifications/ungrouped-notification-0002/accounts', headers: { authorization: f.authorization } });
	assert.equal(accounts.statusCode, 200, accounts.body);
	assert.equal(accounts.json()[0].id, 'bob');
});

test('missing, malformed, hidden and unsupported individual groups return 404', async t => {
	const f = await fixture(t, [event(1, { type: 'reaction', reaction: '😀', note: status }), event(2, { type: 'mention', note: { ...status, isHidden: true } })]);
	for (const key of ['ungrouped-', 'favourite-other-1', 'ungrouped-notification-9999', 'ungrouped-notification-0001', 'ungrouped-notification-0002']) {
		const response = await f.app.inject({ url: `/api/v2/notifications/${key}`, headers: { authorization: f.authorization } });
		assert.equal(response.statusCode, 404, response.body);
	}
});

test('dismiss uses the same owner-isolated key as v1 and is idempotent', async t => {
	const f = await fixture(t, [event(1)]);
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await f.app.inject({ method: 'POST', url: '/api/v2/notifications/ungrouped-notification-0001/dismiss', headers: { authorization: f.authorization } });
		assert.equal(response.statusCode, 200, response.body);
	}
	assert.equal(await f.store.get('dismissed-notification', 'alice', 'notification-0001'), true);
	assert.equal(await f.store.get('dismissed-notification', 'bob', 'notification-0001'), undefined);
	assert.deepEqual(ids(await f.app.inject({ url: '/api/v2/notifications', headers: { authorization: f.authorization } })), []);
	assert.deepEqual(ids(await f.app.inject({ url: '/api/v2/notifications', headers: { authorization: `Bearer ${await f.token('bob')}` } })), ['notification-0001']);
	assert.equal(f.markedRead(), 0);
});

test('clear delegates native read state and hides the shared cleared boundary without hiding later arrivals', async t => {
	const f = await fixture(t, [event(1), event(2)]);
	const response = await f.app.inject({ method: 'POST', url: '/api/v2/notifications/clear', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(f.markedRead(), 1);
	assert.equal(await f.store.get('notifications', 'alice', 'cleared'), 'notification-0002');
	f.events.push(event(3));
	assert.deepEqual(ids(await f.app.inject({ url: '/api/v2/notifications', headers: { authorization: f.authorization } })), ['notification-0003']);
	assert.equal((await f.app.inject({ url: '/api/v2/notifications/ungrouped-notification-0002', headers: { authorization: f.authorization } })).statusCode, 404);
});

test('unread count respects the notification marker, dismissal, filters and count cap', async t => {
	const f = await fixture(t, [event(1), event(2), event(3), event(4), event(5), event(6, { type: 'reaction', reaction: '❤', note: status })]);
	await f.store.put('marker', 'alice', 'notifications', { last_read_id: 'notification-0002', version: 1, updated_at: '2026-01-03T00:00:00Z' });
	await f.store.put('dismissed-notification', 'alice', 'notification-0004', true);
	const get = (query = '') => f.app.inject({ url: `/api/v2/notifications/unread_count${query}`, headers: { authorization: f.authorization } });
	assert.deepEqual((await get()).json(), { count: 3 });
	assert.deepEqual((await get('?exclude_types[]=favourite')).json(), { count: 2 });
	assert.deepEqual((await get('?types[]=favourite')).json(), { count: 1 });
	assert.deepEqual((await get('?account_id=alice')).json(), { count: 0 });
	assert.deepEqual((await get('?limit=1')).json(), { count: 1 });
	assert.equal(f.markedRead(), 0);
	assert.equal((await f.store.get<Json>('marker', 'alice', 'notifications'))?.last_read_id, 'notification-0002');
});

test('unread_count supports its documented larger cap independently of the native page maximum', async t => {
	const f = await fixture(t, Array.from({ length: 150 }, (_, index) => event(index + 1)));
	const response = await f.app.inject({ url: '/api/v2/notifications/unread_count?limit=125', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(response.json(), { count: 125 });
	assert.deepEqual(f.calls.map(call => call.body.limit), [100, 25]);
	assert.equal((await f.app.inject({ url: '/api/v2/notifications/unread_count?limit=1001', headers: { authorization: f.authorization } })).statusCode, 422);
});

test('read and write notification scopes are enforced separately for every route family', async t => {
	const f = await fixture(t, [event(1)]);
	const read = `Bearer ${await f.token('alice', ['read:notifications'])}`;
	const write = `Bearer ${await f.token('alice', ['write:notifications'])}`;
	for (const url of ['/api/v2/notifications', '/api/v2/notifications/unread_count', '/api/v2/notifications/ungrouped-notification-0001', '/api/v2/notifications/ungrouped-notification-0001/accounts']) {
		assert.equal((await f.app.inject({ url, headers: { authorization: read } })).statusCode, 200);
		assert.equal((await f.app.inject({ url, headers: { authorization: write } })).statusCode, 403);
		assert.equal((await f.app.inject({ url })).statusCode, 401);
	}
	assert.equal((await f.app.inject({ method: 'POST', url: '/api/v2/notifications/ungrouped-notification-0001/dismiss', headers: { authorization: read } })).statusCode, 403);
	assert.equal((await f.app.inject({ method: 'POST', url: '/api/v2/notifications/ungrouped-notification-0001/dismiss', headers: { authorization: write } })).statusCode, 200);
});

test('v1 finds an older notification across native pages and shares dismissal with v2', async t => {
	const f = await fixture(t, Array.from({ length: 125 }, (_, index) => event(index + 1)));
	const response = await f.app.inject({ url: '/api/v1/notifications/notification-0002', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(response.json().id, 'notification-0002');
	assert.equal(response.json().type, 'follow');
	assert.equal(response.json().account.id, 'bob');
	assert.equal(response.headers.link, undefined);
	assert.equal(f.calls.length, 2);
	const page = await f.app.inject({ url: '/api/v1/notifications?limit=2&min_id=notification-0001', headers: { authorization: f.authorization } });
	assert.equal(page.statusCode, 200, page.body);
	assert.deepEqual(page.json().map((item: Json) => item.id), ['notification-0003', 'notification-0002']);
	assert.match(String(page.headers.link), /max_id=notification-0002[^>]*>; rel="next"/u);
	assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/notifications/notification-0002/dismiss', headers: { authorization: f.authorization } })).statusCode, 200);
	assert.equal((await f.app.inject({ url: '/api/v2/notifications/ungrouped-notification-0002', headers: { authorization: f.authorization } })).statusCode, 404);
	assert.equal(f.markedRead(), 0);
});

test('v1 unread count scans past one page and counts only visible notifications after the marker', async t => {
	const f = await fixture(t, Array.from({ length: 150 }, (_, index) => event(index + 1, index === 49 ? { type: 'reaction', reaction: '😀', note: status } : {})));
	await f.store.put('marker', 'alice', 'notifications', { last_read_id: 'notification-0020', version: 1, updated_at: '2026-01-03T00:00:00Z' });
	await f.store.put('dismissed-notification', 'alice', 'notification-0040', true);
	const response = await f.app.inject({ url: '/api/v1/notifications/unread_count?limit=200', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(response.json(), { count: 128 });
	assert.ok(f.calls.length > 1);
	assert.equal(response.headers.link, undefined);
	const capped = await f.app.inject({ url: '/api/v1/notifications/unread_count?limit=5', headers: { authorization: f.authorization } });
	assert.equal(capped.statusCode, 200, capped.body);
	assert.deepEqual(capped.json(), { count: 5 });
	assert.equal((await f.store.get<Json>('marker', 'alice', 'notifications'))?.last_read_id, 'notification-0020');
	assert.equal(f.markedRead(), 0);
});
