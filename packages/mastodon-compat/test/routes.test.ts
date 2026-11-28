/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Fastify from 'fastify';
import { EntityConverter } from '../src/entities.js';
import { NativeClient, NativeError } from '../src/native-client.js';
import { compareIds } from '../src/parameters.js';
import { registerRoutes } from '../src/routes.js';
import { registerNotifications } from '../src/notifications-v2.js';
import { toNativePermissions } from '../src/scopes.js';
import { CompatStore } from '../src/store.js';
import type { Json, NativeTransportResponse } from '../src/types.js';

function user(id: string, extra: Json = {}): Json { return { id, username: id, name: id, host: null, createdAt: '2026-01-01T00:00:00Z', ...extra }; }
function note(id: string, extra: Json = {}): Json { return { id, userId: 'alice', user: user('alice'), text: 'Text', visibility: 'public', createdAt: '2026-01-01T00:00:00Z', files: [], reactions: {}, ...extra }; }
const response = (body: unknown, status = 200): NativeTransportResponse => ({ status, body: JSON.stringify(body) });

async function fixture(t: TestContext, options: { store?: CompatStore; handler?: (endpoint: string, body: Json) => Promise<NativeTransportResponse | undefined> } = {}) {

	const store = options.store ?? new CompatStore(':memory:');
	const app = Fastify();
	const calls: Array<{ endpoint: string; body: Json }> = [];
	const notes: Json[] = [], followers: Json[] = [], notifications: Json[] = [];
	const pinned = new Set<string>(), bookmarks = new Set<string>(), muted = new Set<string>();
	const permissions = new Map<string, string[]>();
	let sequence = 1000;
	const nativePage = (rows: Json[], body: Json) => rows.filter(row => (!body.sinceId || compareIds(row.id, body.sinceId) > 0) && (!body.untilId || compareIds(row.id, body.untilId) < 0))
		.sort((a, b) => compareIds(a.id, b.id) * (body.sinceId && !body.untilId ? 1 : -1)).slice(0, body.limit ?? 20);
	const native = new NativeClient({ baseUrl: 'http://native.test', publicUrl: 'https://social.test', transport: async request => {
		const endpoint = new URL(request.url).pathname.replace('/api/', '');
		const body: Json = JSON.parse(String(request.body));
		calls.push({ endpoint, body });
		const permission = ({ 'notes/state': 'read:account', 'notes/thread-muting/create': 'write:account', 'notes/thread-muting/delete': 'write:account', 'i/notifications': 'read:notifications', 'notifications/mark-all-as-read': 'write:account' } as Record<string, string>)[endpoint];
		if (permission && !permissions.get(request.headers.authorization)?.includes(permission)) return response({ error: { code: 'PERMISSION_DENIED', message: permission } }, 403);
		const handled = await options.handler?.(endpoint, body);
		if (handled) return handled;
		if (endpoint === 'ping') return response({ pong: 1 });
		if (endpoint === 'users/show') {
			const author = (id: string) => user(id, { pinnedNotes: notes.filter(item => pinned.has(item.id) && item.userId === id) });
			return response(Array.isArray(body.userIds) ? body.userIds.map(author) : author(body.userId ?? body.username));
		}
		if (endpoint === 'notes/state') return response({ isFavorited: bookmarks.has(body.noteId), isMutedThread: muted.has(body.noteId) });
		if (endpoint === 'notes/show') {
			const found = notes.find(item => item.id === body.noteId);
			return found ? response(found) : response({ error: { code: 'NO_SUCH_NOTE', message: 'Missing' } }, 404);
		}
		if (endpoint === 'notes/create') {
			const created = note(String(++sequence), { ...(body.renoteId && body.text === undefined ? { text: null } : {}), ...body, ...(body.renoteId ? { renote: notes.find(item => item.id === body.renoteId) } : {}), files: (body.fileIds ?? []).map((id: string) => ({ id, type: 'image/png' })) });
			notes.push(created);
			return response({ createdNote: created });
		}
		if (endpoint === 'notes/update') { Object.assign(notes.find(item => item.id === body.noteId)!, body); return response({}); }
		if (endpoint === 'notes/unrenote') { for (let index = notes.length - 1; index >= 0; index--) if (notes[index].renoteId === body.noteId && notes[index].text == null && notes[index].cw == null && !notes[index].files?.length && !notes[index].poll && notes[index].replyId == null) notes.splice(index, 1); return response({}); }
		if (endpoint === 'notes/thread-muting/create') { muted.add(body.noteId); return response({}); }
		if (endpoint === 'notes/thread-muting/delete') { muted.delete(body.noteId); return response({}); }
		if (endpoint === 'notifications/mark-all-as-read') return response({});
		if (endpoint === 'i/notifications') return response(nativePage(notifications, body));
		if (endpoint === 'users/followers') return response(nativePage(followers, body));
		if (endpoint === 'notes/conversation') return response([]);
		if (endpoint === 'notes/children') return response(nativePage(notes.filter(item => item.replyId === body.noteId || item.renoteId === body.noteId), body));
		if (endpoint === 'notes/timeline' || endpoint === 'notes/global-timeline' || endpoint === 'users/notes') {
			if (body.withReplies && body.withFiles) return response({ error: { code: 'INVALID_PARAM', message: 'withReplies and withFiles conflict' } }, 400);
			return response(nativePage(notes.filter(item => endpoint !== 'users/notes' || item.userId === body.userId), body));
		}
		return response({ error: { code: 'UNEXPECTED_ENDPOINT', message: endpoint } }, 404);
	} });
	registerNotifications(registerRoutes(app, { store, native, entities: new EntityConverter('https://social.test'), publicUrl: 'https://social.test' }));
	app.setErrorHandler((error, _request, reply) => reply.code(error instanceof NativeError ? error.status : (error as { statusCode?: number }).statusCode ?? 500).send({ error: error instanceof Error ? error.message : String(error) }));
	const { client } = await store.createClient({ name: 'Tests', redirectUris: ['test://callback'], scopes: ['read', 'write'] });
	const token = async (scopes = ['read', 'write']) => {
		const nativeToken = `native-${permissions.size}`;
		permissions.set(`Bearer ${nativeToken}`, toNativePermissions(scopes));
		return (await store.createGrant({ clientId: client.id, kind: 'user', scopes, userId: 'alice', nativeToken })).token;
	};
	const bearer = await token();
	const request = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: Json, accessToken = bearer, key?: string) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${accessToken}`, ...(key ? { 'idempotency-key': key } : {}) } });
	t.after(async () => { await app.close(); if (!options.store) await store.close(); });
	return { app, store, calls, notes, followers, notifications, pinned, bookmarks, muted, token, request };
}

test('both instance endpoints vary the version by the NeoDB user agent', async t => {
	const { app } = await fixture(t, { handler: async endpoint => {
		if (endpoint === 'meta') return response({ version: '2026.11.0-pari.0' });
		if (endpoint === 'stats') return response({});
	} });
	for (const version of [1, 2]) {
		for (const [userAgent, expected] of [
			['NeoDB/1.0 (+https://books.test)', '4.3.0+misskey.2026.11.0-pari.0'],
			['neodb/1.0', '4.3.0+misskey.2026.11.0-pari.0'],
			['ExampleClient/1.0', '4.3.0 (compatible; Misskey 2026.11.0-pari.0)'],
			['ExampleClient NeoDB/1.0', '4.3.0 (compatible; Misskey 2026.11.0-pari.0)'],
		]) {
			const result = await app.inject({ method: 'GET', url: `/api/v${version}/instance`, headers: { 'user-agent': userAgent } });
			assert.equal(result.statusCode, 200, result.body);
			assert.equal(result.json().version, expected);
			assert.match(String(result.headers.vary), /(?:^|,\s*)User-Agent(?:,|$)/i);
		}
	}
});

test('timeline pages batch metadata and authors with bounded state reads and fresh request state', async t => {
	let active = 0, peak = 0;
	const f = await fixture(t, { handler: async endpoint => {
		if (endpoint !== 'notes/state') return;
		peak = Math.max(peak, ++active);
		await nextTurn();
		active--;
	} });
	for (let i = 0; i < 20; i++) f.notes.push(note(String(1000 + i), { userId: `author${i}`, user: user(`author${i}`) }));
	await f.store.put('status', 'author19', '1019', { language: 'ja' });
	const batch = t.mock.method(f.store, 'getMany');
	const single = t.mock.method(f.store, 'get');
	const lists = t.mock.method(f.store, 'list');
	const first = await f.request('GET', '/api/v1/timelines/home?limit=20');
	assert.equal(first.statusCode, 200, first.body);
	assert.deepEqual(first.json().map((item: Json) => item.id), f.notes.map(item => item.id).reverse());
	assert.equal(first.json()[0].language, 'ja');
	assert.equal(batch.mock.callCount(), 1);
	assert.equal(single.mock.callCount(), 0);
	assert.equal(lists.mock.callCount(), 1);
	assert.equal(f.calls.filter(call => call.endpoint === 'users/show').length, 1);
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/state').length, 20);
	assert.equal(f.calls.length, 23);
	assert.ok(peak > 1 && peak <= 4, `peak state concurrency: ${peak}`);

	await f.store.put('status', 'author19', '1019', { language: 'en' });
	f.bookmarks.add('1019');
	f.pinned.add('1019');
	const next = await f.request('GET', '/api/v1/timelines/home?limit=20');
	assert.equal(next.statusCode, 200, next.body);
	assert.equal(next.json()[0].language, 'en');
	assert.equal(next.json()[0].bookmarked, true);
	assert.equal(next.json()[0].pinned, true);
});

test('local hashtag timelines apply the native local filter before pagination', async t => {
	const rows = [note('102', { user: user('remote', { host: 'remote.example' }) }), note('101')];
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint !== 'notes/search-by-tag') return;
		return response(rows.filter(item => !body.localHostOnly || item.user.host == null).slice(0, body.limit));
	} });
	const result = await f.request('GET', '/api/v1/timelines/tag/test?local=true&limit=1');
	assert.equal(result.statusCode, 200, result.body);
	assert.deepEqual(result.json().map((item: Json) => item.id), ['101']);
	assert.equal(f.calls.find(call => call.endpoint === 'notes/search-by-tag')?.body.localHostOnly, true);
	const combined = await f.request('GET', '/api/v1/timelines/tag/test?limit=1');
	assert.deepEqual(combined.json().map((item: Json) => item.id), ['102']);
});

test('batch timeline reads preserve nested boost metadata and filters', async t => {
	const f = await fixture(t);
	const original = note('100', { files: [{ id: 'file', type: 'image/png', url: 'https://social.test/file.png' }] });
	f.notes.push(original, note('101', { text: null, renoteId: original.id, renote: original }));
	await f.store.put('status', 'alice', '100', { language: 'ja', sensitive: true });
	await f.store.put('media', 'alice', 'file', { focus: { x: 0.5, y: -0.5 } });
	await f.store.put('filter', 'alice', 'filter', { id: 'filter', title: 'Text', context: ['home'], expires_at: null, filter_action: 'warn', keywords: [{ id: 'keyword', keyword: 'Text', whole_word: false }], statuses: [] });
	const result = await f.request('GET', '/api/v1/timelines/home');
	assert.equal(result.statusCode, 200, result.body);
	const boost = result.json()[0];
	assert.equal(boost.reblog.id, '100');
	assert.equal(boost.reblog.language, 'ja');
	assert.equal(boost.reblog.sensitive, true);
	assert.deepEqual(boost.reblog.media_attachments[0].meta.focus, { x: 0.5, y: -0.5 });
	assert.equal(boost.reblog.filtered[0].filter.id, 'filter');
});

test('a fatal timeline read stops scheduling the remaining page', async t => {
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint !== 'notes/state') return;
		if (body.noteId === '1019') throw new NativeError(503, 'UNAVAILABLE', 'Unavailable');
		await nextTurn();
	} });
	for (let i = 0; i < 20; i++) f.notes.push(note(String(1000 + i)));
	const result = await f.request('GET', '/api/v1/timelines/home');
	assert.equal(result.statusCode, 503);
	await nextTurn();
	await nextTurn();
	assert.ok(f.calls.filter(call => call.endpoint === 'notes/state').length <= 4);
});

test('all compatibility status inputs validate before creation, editing, metadata writes or idempotency claims', async t => {
	const f = await fixture(t);
	f.notes.push(note('100'));
	const invalid = [
		{ sensitive: 'invalid' }, { language: {} }, { language: 'not a language' }, { status: {} }, { spoiler_text: 'x'.repeat(101) },
		{ poll: { options: ['One'], expires_in: 300 } }, { poll: { options: ['One', 'Two'], expires_in: 1 } },
		{ poll: { options: ['One', 'Two'], expires_in: 300, multiple: 'invalid' } }, { poll: { options: ['One', 'Two'], expires_in: 300, hide_totals: true } },
		{ poll: { options: ['One', 'Two'] } }, { media_ids: ['file', 'file'] }, { scheduled_at: '2027-01-01' }, { quote_id: {} }, { media_attributes: [{ id: 'file' }] },
	];
	for (const patch of invalid) {
		const result = await f.request('POST', '/api/v1/statuses', { status: 'Valid text', ...patch }, undefined, 'invalid');
		assert.equal(result.statusCode, 422, JSON.stringify(patch));
		assert.equal(await f.store.get('idempotency', 'alice', 'invalid'), undefined);
		assert.equal((await f.request('PUT', '/api/v1/statuses/100', { status: 'Changed', ...patch })).statusCode, 422, JSON.stringify(patch));
	}
	assert.equal(f.calls.some(call => ['notes/create', 'notes/update'].includes(call.endpoint)), false);
	assert.equal(f.notes[0].text, 'Text');
	assert.equal(await f.store.get('status', 'alice', '100'), undefined);
	assert.equal((await f.request('POST', '/api/v1/statuses', { status: 'Valid' }, undefined, 'invalid')).statusCode, 200);
});

test('an empty media_ids list creates a text-only note', async t => {
	const f = await fixture(t);
	const result = await f.request('POST', '/api/v1/statuses', { status: 'Text only', media_ids: [] });
	assert.equal(result.statusCode, 200, result.body);
	assert.equal('fileIds' in f.calls.find(call => call.endpoint === 'notes/create')!.body, false);
});

test('posting applies saved source defaults, supports explicit overrides and keeps omitted edit metadata', async t => {
	const f = await fixture(t);
	await f.store.put('account-source', 'alice', 'defaults', { privacy: 'private', sensitive: true, language: 'ja' });
	const first = await f.request('POST', '/api/v1/statuses', { status: 'Default post' });
	assert.equal(first.statusCode, 200);
	assert.equal(first.json().visibility, 'private');
	assert.equal(first.json().sensitive, true);
	assert.equal(first.json().language, 'ja');
	const updated = await f.request('PUT', `/api/v1/statuses/${first.json().id}`, { status: 'Edited' });
	assert.equal(updated.json().language, 'ja');
	assert.equal(updated.json().sensitive, true);
	const second = await f.request('POST', '/api/v1/statuses', { status: 'Override', visibility: 'public', sensitive: false, language: null });
	assert.equal(second.json().visibility, 'public');
	assert.equal(second.json().sensitive, false);
	assert.equal(second.json().language, null);
});

test('concurrent partial status edits retain both metadata updates', async t => {
	let updates = 0;
	let release!: () => void;
	const both = new Promise<void>(resolve => { release = resolve; });
	const f = await fixture(t, { handler: async endpoint => {
		if (endpoint === 'notes/update') { if (++updates === 2) release(); await both; }
		return undefined;
	} });
	f.notes.push(note('100'));
	const results = await Promise.all([
		f.request('PUT', '/api/v1/statuses/100', { language: 'ja' }),
		f.request('PUT', '/api/v1/statuses/100', { sensitive: true }),
	]);
	assert.ok(results.every(result => result.statusCode === 200));
	assert.deepEqual(await f.store.get('status', 'alice', '100'), { language: 'ja', sensitive: true });
});

test('ordinary status creation accepts the public quote policy sent by generic clients', async t => {
	const f = await fixture(t);
	const created = await f.request('POST', '/api/v1/statuses', { status: 'A normal post', quote_approval_policy: 'public' });
	assert.equal(created.statusCode, 200, created.body);
	assert.equal(created.json().content, '<p>A normal post</p>');
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/create').length, 1);
	assert.equal(f.calls.find(call => call.endpoint === 'notes/create')?.body.renoteId, undefined);
	const edited = await f.request('PUT', `/api/v1/statuses/${created.json().id}`, { status: 'Edited normal post', quote_approval_policy: 'public' });
	assert.equal(edited.statusCode, 200, edited.body);
});

test('direct status idempotency is claimed atomically across routes sharing a store after recipient lookup', async t => {
	const store = new CompatStore(':memory:');
	t.after(() => store.close());
	let lookups = 0, writes = 0;
	let release!: () => void;
	const both = new Promise<void>(resolve => { release = resolve; });
	const created = note('500', { text: '@bob Hi', visibility: 'specified', visibleUserIds: ['bob'] });
	const handler = async (endpoint: string, body: Json) => {
		if (endpoint === 'users/show' && body.username === 'bob') { if (++lookups === 2) release(); await both; return response(user('bob')); }
		if (endpoint === 'notes/create') { writes++; await new Promise<void>(resolve => setImmediate(resolve)); return response({ createdNote: created }); }
		if (endpoint === 'notes/show' && body.noteId === created.id) return response(created);
		return undefined;
	};
	const f = await fixture(t, { store, handler });
	const g = await fixture(t, { store, handler });
	const payload = { status: '@bob Hi', visibility: 'direct' };
	const results = await Promise.all([f.request('POST', '/api/v1/statuses', payload, undefined, 'same'), g.request('POST', '/api/v1/statuses', payload, undefined, 'same')]);
	assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
	assert.equal(writes, 1);
	const replay = await g.request('POST', '/api/v1/statuses', { visibility: 'direct', status: '@bob Hi' }, undefined, 'same');
	assert.equal(replay.statusCode, 200);
	assert.equal(replay.json().id, '500');
	assert.equal(writes, 1);
	const [stored] = await store.getMany([{ namespace: 'idempotency', owner: 'alice', key: 'same' }]);
	assert.equal(stored.expiresAt, (stored.value as Json).expiresAt);
	assert.ok(stored.expiresAt! > Date.now());
	assert.equal((await f.request('POST', '/api/v1/statuses', { ...payload, status: '@bob Different' }, undefined, 'same')).statusCode, 422);
});

test('an expired idempotency key can be reused', async t => {
	const f = await fixture(t);
	await f.store.putIdempotency('alice', 'expired', { id: 'old-note', digest: 'old-request', expiresAt: Date.now() - 1 });
	const result = await f.request('POST', '/api/v1/statuses', { status: 'New request' }, undefined, 'expired');
	assert.equal(result.statusCode, 200, result.body);
	const [stored] = await f.store.getMany([{ namespace: 'idempotency', owner: 'alice', key: 'expired' }]);
	assert.equal((stored.value as Json).id, result.json().id);
	assert.equal(stored.expiresAt, (stored.value as Json).expiresAt);
	assert.ok(stored.expiresAt! > Date.now());
	assert.equal((await f.request('POST', '/api/v1/statuses', { status: 'New request' }, undefined, 'expired')).json().id, result.json().id);
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/create').length, 1);
});

test('ambiguous native write failures retain the idempotency reservation', async t => {
	let writes = 0;
	const f = await fixture(t, { handler: async endpoint => { if (endpoint === 'notes/create') { writes++; throw new Error('Connection lost after commit'); } return undefined; } });
	assert.equal((await f.request('POST', '/api/v1/statuses', { status: 'Once' }, undefined, 'ambiguous')).statusCode, 502);
	const [claim] = await f.store.getMany([{ namespace: 'idempotency', owner: 'alice', key: 'ambiguous' }]);
	assert.ok(claim.expiresAt! > Date.now());
	assert.equal((claim.value as Json).id, undefined);
	await f.store.prune();
	assert.equal((await f.request('POST', '/api/v1/statuses', { status: 'Once' }, undefined, 'ambiguous')).statusCode, 409);
	assert.equal(writes, 1);
});

test('concurrent marker writes increment versions and invalid timelines roll back the whole update', async t => {
	const f = await fixture(t);
	const results = await Promise.all(Array.from({ length: 4 }, (_, index) => f.request('POST', '/api/v1/markers', { home: { last_read_id: String(index + 1) } })));
	assert.ok(results.every(result => result.statusCode === 200));
	assert.deepEqual(results.map(result => result.json().home.version).sort(), [1, 2, 3, 4]);
	const before = await f.store.get<Json>('marker', 'alice', 'home');
	const invalid = await f.request('POST', '/api/v1/markers', { home: { last_read_id: '999' }, notifications: { last_read_id: {} } });
	assert.equal(invalid.statusCode, 422);
	assert.deepEqual(await f.store.get('marker', 'alice', 'home'), before);
	assert.equal(await f.store.get('marker', 'alice', 'notifications'), undefined);
	const fetched = await f.request('GET', '/api/v1/markers?timeline=home');
	assert.deepEqual(fetched.json(), { home: before });
});

test('since_id returns the newest newer page, min_id returns the nearest newer page, and links use source IDs', async t => {
	const f = await fixture(t);
	for (let id = 1; id <= 120; id++) f.notes.push(note(String(id).padStart(3, '0')));
	const newest = await f.request('GET', '/api/v1/timelines/home?since_id=050&limit=3');
	assert.deepEqual(newest.json().map((item: Json) => item.id), ['120', '119', '118']);
	assert.deepEqual(f.calls.find(call => call.endpoint === 'notes/timeline')?.body, { limit: 3, withFiles: false });
	assert.deepEqual((await f.request('GET', '/api/v1/timelines/home?min_id=050&limit=3')).json().map((item: Json) => item.id), ['053', '052', '051']);
	assert.deepEqual((await f.request('GET', '/api/v1/timelines/home?max_id=070&since_id=050&limit=3')).json().map((item: Json) => item.id), ['069', '068', '067']);
	for (let id = 1; id <= 6; id++) f.followers.push({ id: `r${id}`, follower: user(`account${7 - id}`) });
	const followers = await f.request('GET', '/api/v1/accounts/alice/followers?min_id=r2&limit=2');
	assert.deepEqual(followers.json().map((item: Json) => item.id), ['account3', 'account4']);
	assert.match(String(followers.headers.link), /max_id=r3/u);
	assert.match(String(followers.headers.link), /min_id=r4/u);
});

test('native state overrides stale compatibility booleans and stale reblog hints are revalidated', async t => {
	const f = await fixture(t);
	f.notes.push(note('100'));
	for (const kind of ['bookmark', 'thread-mute', 'pin']) await f.store.put(kind, 'alice', '100', true);
	await f.store.put('reblog', 'alice', '100', 'deleted-renote');
	const clean = (await f.request('GET', '/api/v1/statuses/100')).json();
	assert.equal(clean.bookmarked, false);
	assert.equal(clean.muted, false);
	assert.equal(clean.pinned, false);
	assert.equal(clean.reblogged, undefined);
	assert.equal(await f.store.get('reblog', 'alice', '100'), undefined);
	f.bookmarks.add('100'); f.muted.add('100'); f.pinned.add('100');
	const changed = (await f.request('GET', '/api/v1/statuses/100')).json();
	assert.equal(changed.bookmarked, true);
	assert.equal(changed.muted, true);
	assert.equal(changed.pinned, true);
	await f.store.put('reblog', 'alice', '100', 'another-deleted-renote');
	const reblogged = await f.request('POST', '/api/v1/statuses/100/reblog', {});
	assert.equal(reblogged.statusCode, 200);
	assert.equal(reblogged.json().reblog?.id, '100');
	assert.equal(reblogged.json().reblog?.reblogged, true);
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/create').length, 1);
});

test('quote policies retain native visibility guarantees and reject unsupported restrictions before writing', async t => {
	const f = await fixture(t);
	for (const policy of [null, '', '  ', 'public']) {
		assert.equal((await f.request('POST', '/api/v1/statuses', { status: 'Default policy', quote_approval_policy: policy })).statusCode, 200);
	}
	for (const visibility of ['private', 'direct']) for (const policy of ['public', 'followers', 'nobody']) {
		const created = await f.request('POST', '/api/v1/statuses', { status: '@bob Restricted visibility', visibility, quote_approval_policy: policy });
		assert.equal(created.statusCode, 200, created.body);
		assert.equal(created.json().visibility, visibility);
		assert.equal((await f.request('PUT', `/api/v1/statuses/${created.json().id}`, { status: 'Edited', quote_approval_policy: policy })).statusCode, 200);
	}
	const writes = f.calls.filter(call => ['notes/create', 'notes/update'].includes(call.endpoint)).length;
	for (const visibility of ['public', 'unlisted']) for (const policy of ['followers', 'nobody', 'invalid', true, {}]) {
		assert.equal((await f.request('POST', '/api/v1/statuses', { status: 'Must not publish', visibility, quote_approval_policy: policy }, undefined, 'invalid-policy')).statusCode, 422);
	}
	assert.equal(f.calls.filter(call => ['notes/create', 'notes/update'].includes(call.endpoint)).length, writes);
	assert.equal(await f.store.get('idempotency', 'alice', 'invalid-policy'), undefined);
});

test('quotes map to native renotes, preserve empty-comment quotes and replay idempotently', async t => {
	const f = await fixture(t);
	f.notes.push(note('100', { userId: 'bob', user: user('bob'), text: 'Original' }));
	f.notes.push(note('101', { text: null, renoteId: '100', renote: f.notes[0] }));
	const payload = { status: 'Comment', quoted_status_id: '100', quote_approval_policy: 'public' };
	const quoted = await f.request('POST', '/api/v1/statuses', payload, undefined, 'quote-once');
	assert.equal(quoted.statusCode, 200, quoted.body);
	assert.equal(quoted.json().quote.state, 'accepted');
	assert.equal(quoted.json().quote.quoted_status.id, '100');
	assert.equal(quoted.json().reblog, null);
	assert.equal(f.calls.find(call => call.endpoint === 'notes/create')?.body.renoteId, '100');
	assert.equal((await f.request('POST', '/api/v1/statuses', payload, undefined, 'quote-once')).json().id, quoted.json().id);
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/create').length, 1);
	const bare = await f.request('POST', '/api/v1/statuses', { quoted_status_id: '100', quote_approval_policy: 'public' });
	assert.equal(bare.statusCode, 200, bare.body);
	assert.equal(bare.json().quote.quoted_status.id, '100');
	assert.equal(bare.json().reblog, null);
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/create').at(-1)?.body.text, 'https://social.test/notes/100');
	const boostedTarget = await f.request('POST', '/api/v1/statuses', { quoted_status_id: '101', quote_approval_policy: 'public' });
	assert.equal(boostedTarget.statusCode, 200, boostedTarget.body);
	assert.equal(boostedTarget.json().quote.quoted_status.id, '100');
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/create').at(-1)?.body.renoteId, '100');
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/create').at(-1)?.body.text, 'https://social.test/notes/100');
	assert.equal((await f.request('PUT', `/api/v1/statuses/${quoted.json().id}`, { status: 'Edited comment', quote_approval_policy: 'public' })).json().quote.quoted_status.id, '100');
	const cleared = await f.request('PUT', `/api/v1/statuses/${quoted.json().id}`, { status: '', quote_approval_policy: 'public' });
	assert.equal(cleared.statusCode, 200, cleared.body);
	assert.equal(cleared.json().quote.quoted_status.id, '100');
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/update').at(-1)?.body.text, 'https://social.test/notes/100');
	assert.equal((await f.request('PUT', `/api/v1/statuses/${quoted.json().id}`, { quoted_status_id: 'other' })).statusCode, 422);
});

test('quote_id aliases the native quote flow, including bare quotes and idempotent retries', async t => {
	const f = await fixture(t);
	f.notes.push(note('100', { userId: 'bob', user: user('bob'), text: 'Original' }));
	f.notes.push(note('101', { text: null, renoteId: '100', renote: f.notes[0] }));
	const payload = { status: 'Alias quote', quote_id: '100' };
	const first = await f.request('POST', '/api/v1/statuses', payload, undefined, 'quote-alias');
	assert.equal(first.statusCode, 200, first.body);
	assert.equal(first.json().quote.quoted_status.id, '100');
	assert.equal(first.json().reblog, null);
	assert.equal((await f.request('POST', '/api/v1/statuses', payload, undefined, 'quote-alias')).json().id, first.json().id);
	assert.equal(f.calls.filter(call => call.endpoint === 'notes/create').length, 1);
	assert.equal(f.notes.at(-1)?.text, 'Alias quote');
	assert.equal(f.notes.at(-1)?.renoteId, '100');
	for (const input of [{ quote_id: '101' }, { quote_id: '100', quoted_status_id: '100' }, { quote_id: '100', quoted_status_id: '' }, { quote_id: null, quoted_status_id: '100' }]) {
		const bare = await f.request('POST', '/api/v1/statuses', input);
		assert.equal(bare.statusCode, 200, bare.body);
		assert.equal(bare.json().quote.quoted_status.id, '100');
		assert.equal(bare.json().reblog, null);
		assert.equal(f.notes.at(-1)?.renoteId, '100');
		assert.equal(f.notes.at(-1)?.text, 'https://social.test/notes/100');
	}
	assert.equal((await f.request('PUT', `/api/v1/statuses/${first.json().id}`, { status: 'Cannot change target', quote_id: '101' })).statusCode, 422);
	assert.equal(f.calls.some(call => call.endpoint === 'notes/update'), false);
});

test('invalid or conflicting quote aliases fail before writing or claiming idempotency', async t => {
	const f = await fixture(t);
	f.notes.push(note('100'), note('101'));
	for (const input of [{ quote_id: {} }, { quote_id: ['100'] }, { quote_id: 100 }, { quote_id: '100', quoted_status_id: {} }, { quote_id: '100', quoted_status_id: '101' }]) {
		const result = await f.request('POST', '/api/v1/statuses', { status: 'Must not publish', ...input }, undefined, 'invalid-alias');
		assert.equal(result.statusCode, 422, result.body);
		assert.equal(await f.store.get('idempotency', 'alice', 'invalid-alias'), undefined);
	}
	assert.equal(f.calls.some(call => call.endpoint === 'notes/create'), false);
});

test('direct quotes require an explicit author mention, including when a reply supplies a recipient', async t => {
	const f = await fixture(t);
	f.notes.push(note('100', { userId: 'bob', user: user('bob') }), note('own'));
	for (const field of ['quoted_status_id', 'quote_id']) for (const input of [{ status: '@carol Comment' }, { status: '@carol Comment', in_reply_to_id: '100' }]) {
		const rejected = await f.request('POST', '/api/v1/statuses', { ...input, [field]: '100', visibility: 'direct', quote_approval_policy: 'nobody' });
		assert.equal(rejected.statusCode, 422, rejected.body);
	}
	assert.equal(f.calls.some(call => call.endpoint === 'notes/create'), false);
	for (const input of [{ status: '@bob Comment', quoted_status_id: '100' }, { status: '@carol My own quote', quoted_status_id: 'own' }]) {
		const created = await f.request('POST', '/api/v1/statuses', { ...input, visibility: 'direct', quote_approval_policy: 'nobody' });
		assert.equal(created.statusCode, 200, created.body);
		assert.equal(created.json().visibility, 'direct');
	}
});

test('hidden, missing and invalid quote targets are rejected before creating a native note', async t => {
	const f = await fixture(t);
	f.notes.push(note('hidden', { isHidden: true }));
	for (const field of ['quoted_status_id', 'quote_id']) for (const target of ['hidden', 'missing', {}]) {
		const result = await f.request('POST', '/api/v1/statuses', { status: 'Must not publish', [field]: target, quote_approval_policy: 'public' }, undefined, 'invalid-quote');
		assert.ok([404, 422].includes(result.statusCode), result.body);
	}
	assert.equal(f.calls.some(call => call.endpoint === 'notes/create'), false);
	assert.equal(await f.store.get('idempotency', 'alice', 'invalid-quote'), undefined);
});

test('narrow write grants cover native mutations without unauthorized viewer-state reads', async t => {
	const f = await fixture(t);
	f.notes.push(note('100'));
	const muted = await f.request('POST', '/api/v1/statuses/100/mute', {}, await f.token(['write:mutes']));
	assert.equal(muted.statusCode, 200);
	assert.equal(muted.json().muted, true);
	assert.equal(muted.json().bookmarked, undefined);
	assert.equal(f.calls.some(call => call.endpoint === 'notes/state'), false);
	assert.equal((await f.request('POST', '/api/v1/notifications/clear', {}, await f.token(['write:notifications']))).statusCode, 200);
	assert.ok(f.calls.some(call => call.endpoint === 'i/notifications'));
	assert.ok(f.calls.some(call => call.endpoint === 'notifications/mark-all-as-read'));
});

test('account only_media does not send conflicting native options, and context contains recursive replies without quotes', async t => {
	const f = await fixture(t);
	f.notes.push(note('100'), note('200', { replyId: '100', files: [{ id: 'file', type: 'image/png' }] }), note('300', { replyId: '200' }), note('400', { renoteId: '100', renote: note('100'), text: 'A quote' }));
	const media = await f.request('GET', '/api/v1/accounts/alice/statuses?only_media=true');
	assert.equal(media.statusCode, 200);
	assert.deepEqual(media.json().map((item: Json) => item.id), ['200']);
	const context = await f.request('GET', '/api/v1/statuses/100/context');
	assert.equal(context.statusCode, 200);
	assert.deepEqual(context.json().descendants.map((item: Json) => item.id), ['200', '300']);
});

test('reads overlap the native token check but never answer before it, while writes wait for it', async t => {
	let releasePing!: () => void;
	let pingGate = new Promise<void>(resolve => { releasePing = resolve; });
	let revoked = false;
	const f = await fixture(t, { handler: async endpoint => {
		if (endpoint !== 'ping') return;
		await pingGate;
		return revoked ? response({ error: { code: 'AUTHENTICATION_FAILED', message: 'Revoked' } }, 401) : undefined;
	} });
	f.notes.push(note('1000'));
	const settled = (promise: Promise<unknown>) => { let done = false; void promise.then(() => { done = true; }); return () => done; };

	const read = f.request('GET', '/api/v1/statuses/1000');
	const readDone = settled(read);
	for (let i = 0; i < 20 && !f.calls.some(call => call.endpoint === 'notes/show'); i++) await nextTurn();
	assert.ok(f.calls.some(call => call.endpoint === 'notes/show'), 'a read should start while the token is being confirmed');
	assert.equal(readDone(), false, 'a read must not answer before the token is confirmed');
	releasePing();
	assert.equal((await read).statusCode, 200);

	pingGate = new Promise<void>(resolve => { releasePing = resolve; });
	const write = f.request('POST', '/api/v1/statuses', { status: 'Hello' });
	for (let i = 0; i < 20; i++) await nextTurn();
	assert.equal(f.calls.some(call => call.endpoint === 'notes/create'), false, 'a write must wait for the token check');
	releasePing();
	assert.equal((await write).statusCode, 200);

	revoked = true;
	pingGate = Promise.resolve();
	assert.equal((await f.request('GET', '/api/v1/statuses/1000')).statusCode, 401);
});

test('direct status mentions preserve hyphenated usernames and normalize the local host', async t => {
	const lookups: { username: string; host: string | null }[] = [];
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint !== 'users/show' || typeof body.username !== 'string') return;
		lookups.push({ username: body.username, host: (body.host as string | null) ?? null });
		if (body.username === 'foo-bar' && body.host === 'remote.example') return response({ id: 'remote-foobar', username: 'foo-bar', host: 'remote.example' });
		if (body.username === 'bob' && body.host === null) return response({ id: 'local-bob', username: 'bob', host: null });
		if (body.username === 'foo' && body.host === null) return response({ id: 'local-foo', username: 'foo', host: null });
		return response({ error: { code: 'NO_SUCH_USER' } }, 404);
	} });
	const res = await f.request('POST', '/api/v1/statuses', {
		status: 'Hi @foo-bar@remote.example. and @bob@social.test',
		visibility: 'direct',
	});
	assert.equal(res.statusCode, 200);
	assert.deepEqual(lookups, [
		{ username: 'foo-bar', host: 'remote.example' },
		{ username: 'bob', host: null },
	]);
	const created = f.calls.find(call => call.endpoint === 'notes/create');
	assert.deepEqual(created?.body.visibleUserIds, ['remote-foobar', 'local-bob']);
});

test('timeline statuses batch-resolve native mentions without dropping implicit reply recipients', async t => {
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'users/show' && Array.isArray(body.userIds)) {
			const catalog: Record<string, Json> = {
				alice: user('alice', { pinnedNotes: [] }),
				bob: user('bob', { host: 'remote.example', url: 'https://remote.example/@bob', pinnedNotes: [] }),
				carol: user('carol', { pinnedNotes: [] }),
			};
			return response(body.userIds.flatMap((id: string) => catalog[id] ? [catalog[id]] : []));
		}
		return undefined;
	} });
	f.notes.push(note('100', { text: 'Reply to @bob and @nonexistent', mentions: ['bob', 'carol'], replyId: '99', reply: { id: '99', userId: 'carol', user: user('carol') } }));
	const res = await f.request('GET', '/api/v1/timelines/home');
	assert.equal(res.statusCode, 200, res.body);
	assert.deepEqual(res.json()[0].mentions, [
		{ id: 'bob', username: 'bob', acct: 'bob@remote.example', url: 'https://remote.example/@bob' },
		{ id: 'carol', username: 'carol', acct: 'carol', url: 'https://social.test/@carol' },
	]);
	assert.equal(f.calls.filter(call => call.endpoint === 'users/show').length, 1);
});

test('unreblog preserves quote posts of the same target status', async t => {
	const f = await fixture(t);
	const target = note('100', { userId: 'bob', user: user('bob'), text: 'Original' });
	f.notes.push(target);
	const quote = await f.request('POST', '/api/v1/statuses', { status: 'My quote', quoted_status_id: '100' });
	assert.equal(quote.statusCode, 200, quote.body);
	const boost = await f.request('POST', '/api/v1/statuses/100/reblog', {});
	assert.equal(boost.statusCode, 200, boost.body);
	const unboost = await f.request('POST', '/api/v1/statuses/100/unreblog', {});
	assert.equal(unboost.statusCode, 200, unboost.body);
	assert.equal(unboost.json().reblogged, false);
	const stillThere = await f.request('GET', `/api/v1/statuses/${quote.json().id}`);
	assert.equal(stillThere.statusCode, 200, stillThere.body);
	assert.equal(stillThere.json().quote.quoted_status.id, '100');
});

test('editing a media status accepts echoed and updated media_attributes with write:statuses only and keeps edits atomic', async t => {
	const files = new Map<string, Json>([
		['file-1', { id: 'file-1', userId: 'alice', type: 'image/png', url: 'https://social.test/file-1.png', comment: 'Initial alt' }],
	]);
	let failNextUpdate = false;
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'drive/files/show' || endpoint === 'drive/files/update') {
			return response({ error: { code: 'PERMISSION_DENIED', message: 'Drive scope not granted' } }, 403);
		}
		if (endpoint === 'notes/update') {
			if (failNextUpdate) {
				failNextUpdate = false;
				return response({ error: { code: 'NOTE_HISTORY_LIMIT_EXCEEDED', message: 'Limit' } }, 422);
			}
			if (Array.isArray(body.fileIds) && body.fileIds.includes('foreign-file')) {
				return response({ error: { code: 'NO_SUCH_FILE', message: 'Missing' } }, 400);
			}
			const target = f.notes.find(item => item.id === body.noteId)!;
			target.text = body.text;
			target.cw = body.cw;
			if (Array.isArray(body.fileComments)) {
				for (const entry of body.fileComments) {
					const file = files.get(entry.fileId);
					if (file) file.comment = entry.comment;
				}
			}
			return response({ updatedNote: target });
		}
		return undefined;
	} });
	f.notes.push(note('100', { files: [files.get('file-1')!] }));
	const statusOnlyAuth = `Bearer ${await f.token(['read:statuses', 'write:statuses'])}`;

	const updated = await f.app.inject({
		method: 'PUT',
		url: '/api/v1/statuses/100',
		headers: { authorization: statusOnlyAuth },
		payload: {
			status: 'Updated alt and focus',
			visibility: 'public',
			media_ids: ['file-1'],
			media_attributes: [{ id: 'file-1', description: 'Revised alt', focus: '0.25,-0.5' }],
		},
	});
	assert.equal(updated.statusCode, 200, updated.body);
	assert.equal(updated.json().media_attachments[0].description, 'Revised alt');
	assert.deepEqual(updated.json().media_attachments[0].meta.focus, { x: 0.25, y: -0.5 });
	assert.equal(f.calls.some(call => call.endpoint.startsWith('drive/files/')), false);

	failNextUpdate = true;
	const failed = await f.app.inject({
		method: 'PUT',
		url: '/api/v1/statuses/100',
		headers: { authorization: statusOnlyAuth },
		payload: {
			status: 'Should fail',
			media_ids: ['file-1'],
			media_attributes: [{ id: 'file-1', description: 'Must not persist' }],
		},
	});
	assert.equal(failed.statusCode, 422, failed.body);
	assert.equal(files.get('file-1')!.comment, 'Revised alt');

	const foreign = await f.request('PUT', '/api/v1/statuses/100', {
		status: 'Steal',
		media_ids: ['foreign-file'],
		media_attributes: [{ id: 'foreign-file', description: 'Hijack' }],
	});
	assert.equal(foreign.statusCode, 404, foreign.body);

	const changedVisibility = await f.request('PUT', '/api/v1/statuses/100', {
		status: 'Change visibility',
		visibility: 'private',
	});
	assert.equal(changedVisibility.statusCode, 422, changedVisibility.body);
});

test('directory maps order=new and order=active to descending native sort keys', async t => {
	const sorts: string[] = [];
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'users') { sorts.push(body.sort); return response([]); }
		return undefined;
	} });
	assert.equal((await f.request('GET', '/api/v1/directory?order=new')).statusCode, 200);
	assert.equal((await f.request('GET', '/api/v1/directory?order=active')).statusCode, 200);
	assert.deepEqual(sorts, ['+createdAt', '+updatedAt']);
});

test('account search forwards offset, searches combined origin by default, and resolves remote handles', async t => {
	const searchCalls: Json[] = [];
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'users/search') { searchCalls.push(body); return response([user('alice')]); }
		if (endpoint === 'users/show' && body.username === 'bob' && body.host === 'remote.example') return response(user('bob', { host: 'remote.example' }));
		return undefined;
	} });
	const paged = await f.request('GET', '/api/v1/accounts/search?q=alice&offset=40&limit=10');
	assert.equal(paged.statusCode, 200, paged.body);
	assert.equal(searchCalls[0].offset, 40);
	assert.equal(searchCalls[0].origin, 'combined');
	const resolved = await f.request('GET', '/api/v1/accounts/search?q=%40bob%40remote.example&resolve=true');
	assert.equal(resolved.statusCode, 200, resolved.body);
	assert.equal(resolved.json()[0].id, 'bob');
});

test('account statuses scans across pages for only_media without skipping items across max_id or min_id pagination', async t => {
	const f = await fixture(t);
	for (let i = 1; i <= 40; i++) {
		f.notes.push(note(String(1000 + i), { files: [{ id: `media-${i}`, type: 'image/png', url: `https://social.test/m${i}.png` }] }));
	}
	const first = await f.request('GET', '/api/v1/accounts/alice/statuses?only_media=true&limit=20');
	assert.equal(first.statusCode, 200, first.body);
	const firstIds = first.json().map((item: Json) => item.id);
	assert.equal(firstIds.length, 20);
	assert.equal(firstIds[0], '1040');
	assert.equal(firstIds.at(-1), '1021');
	assert.match(String(first.headers.link), /max_id=1021[^>]*>; rel="next"/u);

	const second = await f.request('GET', '/api/v1/accounts/alice/statuses?only_media=true&limit=20&max_id=1021');
	assert.equal(second.statusCode, 200, second.body);
	const secondIds = second.json().map((item: Json) => item.id);
	assert.equal(secondIds.length, 20);
	assert.equal(secondIds[0], '1020');
	assert.equal(secondIds.at(-1), '1001');

	const forward = await f.request('GET', '/api/v1/accounts/alice/statuses?only_media=true&limit=20&min_id=1000');
	assert.equal(forward.statusCode, 200, forward.body);
	const forwardIds = forward.json().map((item: Json) => item.id);
	assert.equal(forwardIds.length, 20);
	assert.equal(forwardIds[0], '1020');
	assert.equal(forwardIds.at(-1), '1001');
	assert.match(String(forward.headers.link), /min_id=1020[^>]*>; rel="prev"/u);
});

test('following a locked account with explicit notify skips following/update while pending', async t => {
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'following/create') return response({});
		if (endpoint === 'users/show' && body.userId === 'locked') return response(user('locked', { isFollowing: false, hasPendingFollowRequestFromYou: true }));
		if (endpoint === 'following/update') return response({ error: { code: 'NOT_FOLLOWING', message: 'Not following' } }, 400);
		return undefined;
	} });
	const res = await f.request('POST', '/api/v1/accounts/locked/follow', { notify: false });
	assert.equal(res.statusCode, 200, res.body);
	assert.equal(res.json().requested, true);
	assert.equal(f.calls.some(call => call.endpoint === 'following/update'), false);
});

test('list creation and update share policy validation for JSON and form strings', async t => {
	const f = await fixture(t, { handler: async endpoint => {
		if (endpoint === 'users/lists/create' || endpoint === 'users/lists/update') return response({ id: 'list-1', name: 'Friends' });
		return undefined;
	} });
	assert.equal((await f.request('POST', '/api/v1/lists', { title: 'Friends', exclusive: true })).statusCode, 422);
	assert.equal((await f.request('POST', '/api/v1/lists', { title: 'Friends', replies_policy: 'none' })).statusCode, 422);
	assert.equal((await f.request('PUT', '/api/v1/lists/list-1', { title: 'Friends', exclusive: 'true' })).statusCode, 422);
	assert.equal((await f.request('POST', '/api/v1/lists', { title: 'Friends', exclusive: false, replies_policy: 'list' })).statusCode, 200);
});

test('hashtag timeline requests publicOnly and excludes unlisted statuses', async t => {
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint !== 'notes/search-by-tag') return undefined;
		assert.equal(body.publicOnly, true);
		return response([note('102', { visibility: 'home' }), note('101', { visibility: 'public' })]);
	} });
	const res = await f.request('GET', '/api/v1/timelines/tag/news');
	assert.equal(res.statusCode, 200, res.body);
	assert.deepEqual(res.json().map((item: Json) => item.id), ['101']);
});

test('follow reblogs toggles native renote-mute only when state differs', async t => {
	let renoteMuted = false;
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'following/create') return response({});
		if (endpoint === 'renote-mute/create') { renoteMuted = true; return response({}); }
		if (endpoint === 'renote-mute/delete') { renoteMuted = false; return response({}); }
		if (endpoint === 'users/show' && body.userId === 'bob') return response(user('bob', { isFollowing: true, isRenoteMuted: renoteMuted }));
		return undefined;
	} });
	const hide = await f.request('POST', '/api/v1/accounts/bob/follow', { reblogs: false });
	assert.equal(hide.statusCode, 200, hide.body);
	assert.equal(hide.json().showing_reblogs, false);
	assert.equal(f.calls.filter(call => call.endpoint === 'renote-mute/create').length, 1);

	const unchanged = await f.request('POST', '/api/v1/accounts/bob/follow', { reblogs: false });
	assert.equal(unchanged.statusCode, 200, unchanged.body);
	assert.equal(f.calls.filter(call => call.endpoint === 'renote-mute/create').length, 1);

	const show = await f.request('POST', '/api/v1/accounts/bob/follow', { reblogs: true });
	assert.equal(show.statusCode, 200, show.body);
	assert.equal(show.json().showing_reblogs, true);
	assert.equal(f.calls.filter(call => call.endpoint === 'renote-mute/delete').length, 1);
});

test('muting an already-muted thread is idempotent on ALREADY_MUTING', async t => {
	const f = await fixture(t, { handler: async endpoint => {
		if (endpoint === 'notes/thread-muting/create') return response({ error: { code: 'ALREADY_MUTING', message: 'Already muting' } }, 400);
		return undefined;
	} });
	f.notes.push(note('100'));
	const res = await f.request('POST', '/api/v1/statuses/100/mute', {});
	assert.equal(res.statusCode, 200, res.body);
	assert.equal(res.json().muted, true);
});

test('favourited_by and favourites pass heart type filter to native reaction endpoints', async t => {
	const seen: Array<{ endpoint: string; body: Json }> = [];
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'notes/reactions') {
			seen.push({ endpoint, body });
			return response([{ id: 'r1', type: '❤', user: user('bob') }, { id: 'r2', type: '👍', user: user('carol') }]);
		}
		if (endpoint === 'users/reactions') {
			seen.push({ endpoint, body });
			return response([{ id: 'r3', type: '❤️', note: note('100') }]);
		}
		return undefined;
	} });
	f.notes.push(note('100'));
	const by = await f.request('GET', '/api/v1/statuses/100/favourited_by');
	assert.equal(by.statusCode, 200, by.body);
	assert.deepEqual(by.json().map((item: Json) => item.id), ['bob']);
	const favs = await f.request('GET', '/api/v1/favourites');
	assert.equal(favs.statusCode, 200, favs.body);
	assert.deepEqual(favs.json().map((item: Json) => item.id), ['100']);
	assert.equal(seen[0].body.type, '❤');
	assert.equal(seen[1].body.type, '❤');
});

test('notes/state myRenoteId hydrates native boosts, avoids duplicate reblogs, and clears stale hints', async t => {
	let myRenoteId: string | null = 'web-boost-1';
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'notes/state' && body.noteId === '100') return response({ isFavorited: false, isMutedThread: false, myRenoteId });
		return undefined;
	} });
	const original = note('100', { userId: 'bob', user: user('bob'), text: 'Hello' });
	const webBoost = note('web-boost-1', { userId: 'alice', user: user('alice'), text: null, renoteId: '100', renote: original });
	f.notes.push(original, webBoost);

	const read = await f.request('GET', '/api/v1/statuses/100');
	assert.equal(read.statusCode, 200, read.body);
	assert.equal(read.json().reblogged, true);

	const reblog = await f.request('POST', '/api/v1/statuses/100/reblog', {});
	assert.equal(reblog.statusCode, 200, reblog.body);
	assert.equal(reblog.json().id, 'web-boost-1');
	assert.equal(f.calls.some(call => call.endpoint === 'notes/create'), false);

	myRenoteId = null;
	const afterUnboost = await f.request('GET', '/api/v1/statuses/100');
	assert.equal(afterUnboost.statusCode, 200, afterUnboost.body);
	assert.equal(afterUnboost.json().reblogged, false);
	assert.equal(await f.store.get('reblog', 'alice', '100'), undefined);
});

test('accounts/lookup normalizes uppercase local host and direct status tolerates unresolved mentions when a valid recipient exists', async t => {
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'users/show' && body.username === 'missing') return response({ error: { code: 'NO_SUCH_USER', message: 'Not found' } }, 404);
		if (endpoint === 'users/show' && body.username === 'bob' && body.host === null) return response(user('bob'));
		if (endpoint === 'users/show' && body.username === 'alice' && body.host === null) return response(user('alice'));
		return undefined;
	} });
	const lookup = await f.request('GET', '/api/v1/accounts/lookup?acct=alice@SOCIAL.TEST');
	assert.equal(lookup.statusCode, 200, lookup.body);
	assert.equal(lookup.json().id, 'alice');

	const dm = await f.request('POST', '/api/v1/statuses', { status: '@missing @bob hi', visibility: 'direct' });
	assert.equal(dm.statusCode, 200, dm.body);
	const createCall = f.calls.find(call => call.endpoint === 'notes/create')!;
	assert.deepEqual(createCall.body.visibleUserIds, ['bob']);

	const emptyDm = await f.request('POST', '/api/v1/statuses', { status: '@missing hi', visibility: 'direct' });
	assert.equal(emptyDm.statusCode, 422, emptyDm.body);
});

test('POST /api/v1/reports returns native report ID and rejects oversized evidence with 422', async t => {
	const reports: Json[] = [];
	const f = await fixture(t, { handler: async (endpoint, body) => {
		if (endpoint === 'users/show' && body.userId === 'bob') return response(user('bob'));
		if (endpoint === 'users/report-abuse') { reports.push(body); return response({ id: '9xreport001' }); }
		return undefined;
	} });
	const denied = await f.app.inject({
		method: 'POST',
		url: '/api/v1/reports',
		headers: { authorization: `Bearer ${await f.token(['read'])}` },
		payload: { account_id: 'bob', category: 'spam' },
	});
	assert.equal(denied.statusCode, 403, denied.body);

	const tooLong = await f.request('POST', '/api/v1/reports', { account_id: 'bob', category: 'spam', comment: 'a'.repeat(2050) });
	assert.equal(tooLong.statusCode, 422, tooLong.body);
	assert.equal(reports.length, 0);

	const res = await f.request('POST', '/api/v1/reports', { account_id: 'bob', category: 'spam', comment: 'Sending spam', status_ids: ['100'] });
	assert.equal(res.statusCode, 200, res.body);
	assert.equal(res.json().id, '9xreport001');
	assert.equal(res.json().category, 'spam');
	assert.equal(res.json().target_account.id, 'bob');
	assert.equal(reports.length, 1);
	assert.equal(reports[0].userId, 'bob');
	assert.match(reports[0].comment, /\[spam\]/u);
	assert.match(reports[0].comment, /100/u);
});
