/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { EntityConverter } from '../src/entities.js';
import { applyFilters, conversationFromNote, conversationRootId, registerFeatures } from '../src/features.js';
import { NativeClient, NativeError } from '../src/native-client.js';
import { Routes } from '../src/routes.js';
import { CompatStore } from '../src/store.js';
import type { Json } from '../src/types.js';

function nativeUser(id: string): Json { return { id, username: id, name: id, host: null, createdAt: '2026-01-01T00:00:00Z', avatarUrl: null, description: '', pinnedNoteIds: [] }; }
function nativeNote(id: string, userId = 'bob', extra: Json = {}): Json {
	return { id, userId, user: nativeUser(userId), text: 'A direct message', visibility: 'specified', visibleUserIds: ['alice'], createdAt: '2026-01-01T00:00:00Z', files: [], reactions: {}, ...extra };
}

async function fixture(t: TestContext) {
	const app = Fastify();
	const store = new CompatStore(':memory:');
	const calls: Array<{ endpoint: string; body: Json; token?: string }> = [];
	const notes: Json[] = [];
	const announcements: Json[] = [{ id: 'announcement1', title: 'News', text: 'Read **this**', createdAt: '2026-01-01T00:00:00Z', isRead: false }];
	let revoked = false;
	const native = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.test', transport: async request => {
		const endpoint = new URL(request.url).pathname.replace('/api/', '');
		const body: Json = JSON.parse(String(request.body));
		calls.push({ endpoint, body, token: request.headers.authorization });
		const response = (data: unknown, status = 200) => ({ status, body: JSON.stringify(data) });
		if (revoked) return response({ error: { code: 'AUTHENTICATION_FAILED', message: 'Revoked' } }, 401);
		if (endpoint === 'ping') return response({ pong: 1 });
		if (endpoint === 'i') return response({ ...nativeUser('alice'), alwaysMarkNsfw: true, lang: 'ja' });
		if (endpoint === 'users/show') return response(nativeUser(body.userId));
		if (endpoint === 'notes/show') {
			const note = notes.find(item => item.id === body.noteId);
			return note ? response(note) : response({ error: { code: 'NO_SUCH_NOTE', message: 'Missing' } }, 404);
		}
		if (endpoint === 'notes/state') {
			return notes.some(note => note.id === body.noteId) ? response({ isFavorited: false, isMutedThread: false }) : response({ error: { code: 'NO_SUCH_NOTE', message: 'Missing' } }, 404);
		}
		if (endpoint === 'notes/mentions' || endpoint === 'users/notes') {
			return response(notes.filter(note => endpoint === 'notes/mentions' ? note.visibility === 'specified' && note.visibleUserIds.includes('alice') : note.userId === body.userId)
				.filter(note => !body.untilId || note.id < body.untilId).sort((a, b) => b.id.localeCompare(a.id)).slice(0, body.limit));
		}
		if (endpoint === 'announcements') return response(announcements);
		if (endpoint === 'i/read-announcement') {
			const announcement = announcements.find(item => item.id === body.announcementId);
			if (announcement) announcement.isRead = true;
			return response({});
		}
		return response({ error: { code: 'UNEXPECTED_ENDPOINT', message: endpoint } }, 404);
	} });
	const entities = new EntityConverter('https://social.test');
	const routes = new Routes(app, { store, native, entities, publicUrl: 'https://social.test' });
	registerFeatures(routes);
	app.setErrorHandler((error, _request, reply) => reply.code(error instanceof NativeError ? error.status : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : String(error) }));
	const { client } = await store.createClient({ name: 'Tests', redirectUris: ['test://callback'], scopes: ['read', 'write', 'push'] });
	const token = async (userId = 'alice', scopes = ['read', 'write', 'push']) => (await store.createGrant({ clientId: client.id, kind: 'user', scopes, userId, nativeToken: 'native-app-token' })).token;
	const bearer = await token();
	const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Json, accessToken = bearer) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${accessToken}` } });
	t.after(async () => { await app.close(); await store.close(); });
	return { app, store, calls, notes, announcements, native, entities, token, request, revokeNative: () => { revoked = true; } };
}

test('v2 filters and keywords persist, validate ownership, and interoperate with v1 keyword identities', async t => {
	const f = await fixture(t);
	const created = await f.request('POST', '/api/v2/filters', { title: 'Spoilers', context: ['home', 'public'], filter_action: 'blur', keywords_attributes: [{ keyword: 'spoiler', whole_word: true }, { keyword: 'reveal', whole_word: false }] });
	assert.equal(created.statusCode, 200);
	const filter = created.json();
	assert.equal(filter.keywords.length, 2);
	const v1 = (await f.request('GET', '/api/v1/filters')).json();
	assert.equal(v1.length, 2);
	assert.equal(v1[0].id, filter.keywords[0].id);
	assert.equal(v1[0].phrase, 'spoiler');
	assert.equal((await f.request('GET', `/api/v2/filters/${filter.id}`, undefined, await f.token('bob'))).statusCode, 404);
	assert.equal((await f.request('PUT', `/api/v1/filters/${filter.keywords[0].id}`, { context: ['thread'] })).statusCode, 422);
	const updated = await f.request('PUT', `/api/v2/filters/${filter.id}`, { keywords_attributes: [{ id: filter.keywords[0].id, keyword: 'ending' }, { id: filter.keywords[1].id, _destroy: true }] });
	assert.equal(updated.statusCode, 200);
	assert.deepEqual(updated.json().keywords.map((item: Json) => item.keyword), ['ending']);
	const added = await f.request('POST', `/api/v2/filters/${filter.id}/keywords`, { keyword: 'plot', whole_word: false });
	const keywordId = added.json().id;
	assert.equal((await f.request('GET', `/api/v2/filters/keywords/${keywordId}`)).json().keyword, 'plot');
	assert.equal((await f.request('PUT', `/api/v2/filters/keywords/${keywordId}`, { keyword: 'secret', whole_word: true })).json().whole_word, true);
	assert.equal((await f.request('DELETE', `/api/v2/filters/keywords/${keywordId}`)).statusCode, 200);
	assert.equal((await f.request('GET', `/api/v2/filters/keywords/${keywordId}`)).statusCode, 404);
	assert.ok(await f.store.get('filter-revision', 'alice', 'current'));
	assert.equal((await f.request('DELETE', `/api/v2/filters/${filter.id}`)).statusCode, 200);
	assert.deepEqual((await f.request('GET', '/api/v2/filters')).json(), []);
});

test('v1 mutations share v2 storage and preserve unrelated fields', async t => {
	const f = await fixture(t);
	const created = await f.request('POST', '/api/v1/filters', { phrase: 'quiet', context: ['home'], irreversible: true, whole_word: true });
	assert.equal(created.statusCode, 200);
	const legacy = created.json();
	const groups = (await f.request('GET', '/api/v2/filters')).json();
	assert.equal(groups[0].filter_action, 'hide');
	assert.equal(groups[0].keywords[0].id, legacy.id);
	assert.equal((await f.request('PUT', `/api/v1/filters/${legacy.id}`, { phrase: 'calm' })).json().irreversible, true);
	assert.equal((await f.request('GET', `/api/v2/filters/${groups[0].id}`)).json().title, 'calm');
	assert.equal((await f.request('DELETE', `/api/v1/filters/${legacy.id}`)).statusCode, 200);
	assert.deepEqual((await f.request('GET', '/api/v1/filters')).json(), []);
});

test('filter matching handles words, escaped text, reblogs, contexts, expiry and explicit statuses without discarding hide', async t => {
	const f = await fixture(t);
	const first = (await f.request('POST', '/api/v2/filters', { title: 'Words', context: ['home'], filter_action: 'hide', keywords_attributes: [{ keyword: 'cat', whole_word: true }, { keyword: '<secret>', whole_word: false }] })).json();
	const second = (await f.request('POST', '/api/v2/filters', { title: 'Exact status', context: ['public'], filter_action: 'warn' })).json();
	f.notes.push(nativeNote('target', 'bob', { visibility: 'public' }));
	const added = await f.request('POST', `/api/v2/filters/${second.id}/statuses`, { status_id: 'target' });
	assert.equal(added.statusCode, 200);
	assert.equal((await f.request('GET', `/api/v2/filters/statuses/${added.json().id}`)).json().status_id, 'target');
	const status: Json = { id: 'target', content: '<p>A cat &lt;secret&gt; appears</p>', spoiler_text: '', filtered: [] };
	const matched = await applyFilters(f.store, 'alice', status, 'home');
	assert.equal(matched.id, 'target');
	assert.equal(matched.filtered[0].filter.id, first.id);
	assert.deepEqual(matched.filtered[0].keyword_matches, ['cat', '<secret>']);
	assert.deepEqual(status.filtered, []);
	assert.equal((await applyFilters(f.store, 'alice', { ...status, content: 'concatenate' }, 'home')).filtered.length, 0);
	assert.deepEqual((await applyFilters(f.store, 'alice', status, 'public')).filtered[0].status_matches, ['target']);
	assert.equal((await applyFilters(f.store, 'bob', status)).filtered.length, 0);
	const reblog = await applyFilters(f.store, 'alice', { id: 'boost', content: '', reblog: status });
	assert.equal(reblog.filtered.length, 2);
	assert.equal(reblog.reblog.filtered.length, 2);
	await f.request('PUT', `/api/v2/filters/${first.id}`, { expires_in: 0 });
	assert.equal((await applyFilters(f.store, 'alice', status, 'home', Date.now() + 1)).filtered.length, 0);
	assert.equal((await f.request('DELETE', `/api/v2/filters/statuses/${added.json().id}`)).statusCode, 200);
	assert.equal((await applyFilters(f.store, 'alice', status, 'public')).filtered.length, 0);
});

test('invalid filter edits are atomic, and revoked native grants cannot access stored features', async t => {
	const f = await fixture(t);
	const write = await f.token('alice', ['write:filters']);
	const read = await f.token('alice', ['read:filters']);
	const created = await f.request('POST', '/api/v2/filters', { title: 'One', context: ['home'], keywords_attributes: [{ keyword: 'word' }] }, write);
	assert.equal(created.statusCode, 200);
	assert.equal((await f.request('GET', '/api/v2/filters', undefined, write)).statusCode, 403);
	assert.equal((await f.request('GET', '/api/v2/filters', undefined, read)).statusCode, 200);
	const id = created.json().id;
	assert.equal((await f.request('PUT', `/api/v2/filters/${id}`, { title: 'Changed', keywords_attributes: [{ id: 'foreign', keyword: 'bad' }] })).statusCode, 404);
	assert.equal((await f.request('GET', `/api/v2/filters/${id}`)).json().title, 'One');
	assert.equal((await f.request('POST', '/api/v2/filters', { title: 'Invalid', context: ['bogus'] })).statusCode, 422);
	assert.ok(f.calls.every(call => call.token === 'Bearer native-app-token'));
	f.revokeNative();
	assert.equal((await f.request('GET', '/api/v2/filters', undefined, read)).statusCode, 401);
	assert.equal((await f.request('PUT', `/api/v2/filters/${id}`, { title: 'After revoke' }, write)).statusCode, 401);
	assert.equal((await f.store.get<Json>('filter', 'alice', id))?.title, 'One');
});

test('preferences and announcements use native state and native dismissal', async t => {
	const f = await fixture(t);
	const preferences = (await f.request('GET', '/api/v1/preferences')).json();
	assert.equal(preferences['posting:default:sensitive'], true);
	assert.equal(preferences['posting:default:language'], 'ja');
	const first = (await f.request('GET', '/api/v1/announcements')).json();
	assert.equal(first.length, 1);
	assert.match(first[0].content, /Read <strong>this<\/strong>/u);
	assert.equal((await f.request('POST', '/api/v1/announcements/announcement1/dismiss')).statusCode, 200);
	assert.deepEqual((await f.request('GET', '/api/v1/announcements')).json(), []);
	assert.equal((await f.request('GET', '/api/v1/announcements?with_dismissed=true')).json()[0].read, true);
	assert.ok(f.calls.some(call => call.endpoint === 'i/read-announcement' && call.body.announcementId === 'announcement1'));
});

test('conversations group incoming and sent direct notes by root and share read/hide state with streaming', async t => {
	const f = await fixture(t);
	const root = nativeNote('100');
	const sent = nativeNote('200', 'alice', { visibleUserIds: ['bob'], replyId: '100' });
	const received = nativeNote('300', 'bob', { replyId: '200' });
	f.notes.push(root, sent, received, nativeNote('400', 'carol'));
	const first = await f.request('GET', '/api/v1/conversations');
	assert.equal(first.statusCode, 200);
	assert.deepEqual(first.json().map((item: Json) => item.id), ['400', '100']);
	assert.equal(first.json()[1].last_status.id, '300');
	assert.deepEqual(first.json()[1].accounts.map((item: Json) => item.id), ['bob']);
	assert.equal(first.json()[1].unread, true);
	const read = await f.request('POST', '/api/v1/conversations/100/read');
	assert.equal(read.json().unread, false);
	const call = <T = Json>(endpoint: string, body?: Json) => f.native.call<T>(endpoint, body, 'native-app-token');
	assert.equal((await conversationFromNote(f.store, 'alice', received, call, f.entities))?.unread, false);
	assert.equal((await f.request('DELETE', '/api/v1/conversations/100')).statusCode, 200);
	assert.equal(await conversationFromNote(f.store, 'alice', received, call, f.entities), null);
	assert.deepEqual((await f.request('GET', '/api/v1/conversations')).json().map((item: Json) => item.id), ['400']);
	const next = nativeNote('500', 'bob', { replyId: '300' });
	f.notes.push(next);
	const event = await conversationFromNote(f.store, 'alice', next, call, f.entities);
	assert.equal(event?.id, '100');
	assert.equal(event?.unread, true);
	assert.equal((await f.request('GET', '/api/v1/conversations')).json().find((item: Json) => item.id === '100').last_status.id, '500');
	assert.equal(f.calls.some(item => ['notes/delete', 'notifications/mark-all-as-read'].includes(item.endpoint)), false);
});

test('sent direct conversations are discovered after a full page of public posts and pagination uses root IDs', async t => {
	const f = await fixture(t);
	for (let index = 0; index < 105; index++) f.notes.push(nativeNote(String(1000 + index), 'alice', { visibility: 'public' }));
	f.notes.push(nativeNote('0900', 'alice', { visibleUserIds: ['bob'] }), nativeNote('0800', 'carol'));
	const result = await f.request('GET', '/api/v1/conversations?limit=10');
	assert.equal(result.statusCode, 200);
	assert.deepEqual(result.json().map((item: Json) => item.id), ['0900', '0800']);
	assert.ok(f.calls.filter(item => item.endpoint === 'users/notes').length >= 2);
	const page = await f.request('GET', '/api/v1/conversations?max_id=0900');
	assert.deepEqual(page.json().map((item: Json) => item.id), ['0800']);
});

test('conversation root traversal stops at inaccessible or public parents and handles cycles', async () => {
	const call = async <T = Json>(): Promise<T> => { throw new NativeError(404, 'NO_SUCH_NOTE', 'Missing'); };
	assert.equal(await conversationRootId(nativeNote('200', 'bob', { replyId: '100' }), call), '200');
	const publicParent = nativeNote('100', 'bob', { visibility: 'public' });
	assert.equal(await conversationRootId(nativeNote('200', 'bob', { replyId: '100', reply: publicParent }), call), '200');
	const cycle = nativeNote('100', 'bob', { replyId: '100' });
	assert.equal(await conversationRootId(cycle, call), '100');
});

test('unavailable tag following, scheduled writes and push delivery do not claim success', async t => {
	const f = await fixture(t);
	assert.equal((await f.request('GET', '/api/v1/followed_tags')).statusCode, 501);
	assert.equal((await f.request('POST', '/api/v1/tags/cats/follow')).statusCode, 501);
	assert.deepEqual((await f.request('GET', '/api/v1/scheduled_statuses')).json(), []);
	assert.equal((await f.request('PUT', '/api/v1/scheduled_statuses/123', { scheduled_at: '2027-01-01T00:00:00Z' })).statusCode, 422);
	assert.equal((await f.request('GET', '/api/v1/push/subscription')).statusCode, 404);
	assert.equal((await f.request('POST', '/api/v1/push/subscription', { subscription: {} })).statusCode, 501);
});


test('concurrent keyword edits keep both changes and commit a visible filter revision', async t => {
	const f = await fixture(t);
	const created = (await f.request('POST', '/api/v2/filters', { title: 'Concurrent', context: ['home'] })).json();
	const before = await f.store.get('filter-revision', 'alice', 'current');
	const responses = await Promise.all(['first', 'second'].map(keyword => f.request('POST', `/api/v2/filters/${created.id}/keywords`, { keyword })));
	assert.ok(responses.every(response => response.statusCode === 200));
	const updated = (await f.request('GET', `/api/v2/filters/${created.id}`)).json();
	assert.deepEqual(updated.keywords.map((item: Json) => item.keyword).sort(), ['first', 'second']);
	assert.notEqual(await f.store.get('filter-revision', 'alice', 'current'), before);
	assert.equal((await applyFilters(f.store, 'alice', { id: 'new', content: 'first second' }, 'home')).filtered[0].keyword_matches.length, 2);
});


test('conversation refresh replaces a removed latest note without losing its read state', async t => {
	const f = await fixture(t);
	const root = nativeNote('100');
	const received = nativeNote('200', 'bob', { replyId: '100' });
	f.notes.push(root, received);
	await f.store.put('conversation', 'alice', '100', { latestId: '300', readThrough: '200' });
	const call = <T = Json>(endpoint: string, body?: Json) => f.native.call<T>(endpoint, body, 'native-app-token');
	const conversation = await conversationFromNote(f.store, 'alice', received, call, f.entities);
	assert.equal(conversation?.last_status.id, '200');
	assert.equal(conversation?.unread, false);
	assert.deepEqual(await f.store.get('conversation', 'alice', '100'), { latestId: '200', readThrough: '200' });
});
