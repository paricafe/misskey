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
			const created = note(String(++sequence), { ...body, ...(body.renoteId ? { renote: notes.find(item => item.id === body.renoteId) } : {}), files: (body.fileIds ?? []).map((id: string) => ({ id, type: 'image/png' })) });
			notes.push(created);
			return response({ createdNote: created });
		}
		if (endpoint === 'notes/update') { Object.assign(notes.find(item => item.id === body.noteId)!, body); return response({}); }
		if (endpoint === 'notes/unrenote') { for (let index = notes.length - 1; index >= 0; index--) if (notes[index].renoteId === body.noteId) notes.splice(index, 1); return response({}); }
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
	return { store, calls, notes, followers, notifications, pinned, bookmarks, muted, token, request };
}

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
	assert.equal((await f.request('POST', '/api/v1/statuses', { ...payload, status: '@bob Different' }, undefined, 'same')).statusCode, 422);
});

test('ambiguous native write failures retain the idempotency reservation', async t => {
	let writes = 0;
	const f = await fixture(t, { handler: async endpoint => { if (endpoint === 'notes/create') { writes++; throw new Error('Connection lost after commit'); } return undefined; } });
	assert.equal((await f.request('POST', '/api/v1/statuses', { status: 'Once' }, undefined, 'ambiguous')).statusCode, 502);
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
	assert.equal((await f.request('POST', '/api/v1/statuses/100/reblog', {})).statusCode, 200);
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
