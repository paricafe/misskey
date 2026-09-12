/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { EntityConverter } from '../src/entities.js';
import { registerMediaSearch } from '../src/media-search.js';
import { NativeClient, NativeError } from '../src/native-client.js';
import { formParameters, parameters } from '../src/parameters.js';
import { Routes } from '../src/routes.js';
import { CompatStore } from '../src/store.js';
import type { Json, NativeTransportRequest } from '../src/types.js';

const alice = { id: 'alice', username: 'alice', name: 'Alice', createdAt: '2026-01-01T00:00:00Z' };
const note = (id = 'opaque-note', extra: Json = {}): Json => ({ id, userId: 'alice', user: alice, text: 'Current text', createdAt: '2026-01-01T00:00:00Z', visibility: 'public', files: [], ...extra });
const file = (extra: Json = {}): Json => ({ id: 'opaque-file', userId: 'alice', type: 'image/png', url: 'https://social.example/file.png', properties: { width: 20, height: 10 }, comment: null, ...extra });

async function fixture(t: TestContext, handler: (endpoint: string, body: Json, request: NativeTransportRequest) => unknown | Promise<unknown>, scopes = ['read', 'write']) {
	const app = Fastify();
	await app.register(multipart, { limits: { fileSize: 1024, files: 2 } });
	app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
		try { done(null, formParameters(String(body))); } catch (error) { done(error as Error); }
	});
	app.addHook('preValidation', async request => {
		request.query = parameters(request.query);
		if (!request.isMultipart()) request.body = parameters(request.body);
	});
	app.setErrorHandler((error, _request, reply) => {
		const status = error instanceof NativeError ? error.status === 400 ? 422 : error.status : (error as { statusCode?: number }).statusCode ?? 500;
		reply.code(status).send({ error: (error as Error).message });
	});
	const store = new CompatStore(':memory:');
	const { client } = await store.createClient({ name: 'Client', scopes, redirectUris: ['client://callback'] });
	const { token } = await store.createGrant({ clientId: client.id, scopes, kind: 'user', userId: 'alice', nativeToken: 'native-secret' });
	const calls: Array<{ endpoint: string; body: Json; request: NativeTransportRequest }> = [];
	const native = new NativeClient({ baseUrl: 'http://native.example', publicUrl: 'https://social.example', transport: async request => {
		const endpoint = new URL(request.url).pathname.slice(5);
		if (endpoint === 'ping') return { status: 200, body: '{"pong":0}' };
		const body: Json = request.headers['content-type']?.startsWith('multipart/') ? {} : JSON.parse(String(request.body));
		if (endpoint === 'notes/state') {
			assert.equal(typeof body.noteId, 'string');
			return { status: 200, body: JSON.stringify({ isFavorited: false, isMutedThread: false }) };
		}
		if (endpoint === 'users/show' && body.userId === alice.id) {
			return { status: 200, body: JSON.stringify({ ...alice, pinnedNoteIds: [], pinnedNotes: [] }) };
		}
		if (endpoint === 'users/show' && Array.isArray(body.userIds)) {
			return { status: 200, body: JSON.stringify(body.userIds.includes(alice.id) ? [{ ...alice, pinnedNoteIds: [], pinnedNotes: [] }] : []) };
		}
		calls.push({ endpoint, body, request });
		const result = await handler(endpoint, body, request);
		return result === undefined ? { status: 204, body: '' } : { status: 200, body: JSON.stringify(result) };
	} });
	registerMediaSearch(new Routes(app, { native, entities: new EntityConverter('https://social.example'), store, publicUrl: 'https://social.example' }));
	t.after(async () => { await app.close(); await store.close(); });
	return { app, store, calls, authorization: `Bearer ${token}` };
}

async function encoded(data: FormData): Promise<{ payload: Buffer; headers: Record<string, string> }> {
	const request = new Request('https://gateway.example', { method: 'POST', body: data });
	return { payload: Buffer.from(await request.arrayBuffer()), headers: { 'content-type': request.headers.get('content-type')! } };
}

test('multipart upload accepts binary bytes and trailing metadata through the public native API', async t => {
	let nativeForm: FormData | undefined;
	const f = await fixture(t, async (endpoint, _body, request) => {
		assert.equal(endpoint, 'drive/files/create');
		assert.equal(request.headers.authorization, 'Bearer native-secret');
		nativeForm = await new Request(request.url, { method: 'POST', headers: request.headers, body: Buffer.from(request.body) }).formData();
		return file({ comment: nativeForm.get('comment') });
	});
	const data = new FormData();
	const bytes = new Uint8Array([0, 255, 13, 10]);
	data.set('file', new Blob([bytes], { type: 'image/png' }), 'sample.png');
	data.set('description', 'A useful caption');
	data.set('focus', '-0.5,0.7');
	const multi = await encoded(data);
	const response = await f.app.inject({ method: 'POST', url: '/api/v2/media', ...multi, headers: { ...multi.headers, authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(response.json().description, 'A useful caption');
	assert.deepEqual(response.json().meta.focus, { x: -0.5, y: 0.7 });
	assert.equal(nativeForm?.get('force'), 'true');
	assert.deepEqual(new Uint8Array(await (nativeForm?.get('file') as File).arrayBuffer()), bytes);
	assert.deepEqual(await f.store.get('media', 'alice', 'opaque-file'), { focus: { x: -0.5, y: 0.7 } });
});

test('invalid trailing upload fields and custom thumbnails fail before the first native mutation', async t => {
	const f = await fixture(t, () => assert.fail('No native operation should run'));
	for (const focus of ['2,0', 'NaN,0', '0', ',0']) {
		const data = new FormData(); data.set('file', new Blob(['file'], { type: 'image/png' }), 'sample.png'); data.set('focus', focus);
		const multi = await encoded(data);
		const response = await f.app.inject({ method: 'POST', url: '/api/v1/media', ...multi, headers: { ...multi.headers, authorization: f.authorization } });
		assert.equal(response.statusCode, 422, response.body);
	}
	const data = new FormData(); data.set('file', new Blob(['file']), 'sample.png'); data.set('thumbnail', new Blob(['thumb']), 'thumbnail.png');
	const multi = await encoded(data);
	assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/media', ...multi, headers: { ...multi.headers, authorization: f.authorization } })).statusCode, 422);
	assert.equal(f.calls.length, 0);
});

test('media reads and updates enforce ownership even when native moderator access succeeds', async t => {
	const f = await fixture(t, () => file({ userId: 'someone-else' }));
	for (const method of ['GET', 'PUT'] as const) {
		const response = await f.app.inject({ method, url: '/api/v1/media/opaque-file', headers: { authorization: f.authorization }, ...(method === 'PUT' ? { payload: { description: 'overwrite' } } : {}) });
		assert.equal(response.statusCode, 404, response.body);
	}
	assert.ok(f.calls.every(call => call.endpoint === 'drive/files/show'));
});

test('media update preserves omitted descriptions and persists focus across later reads', async t => {
	const f = await fixture(t, endpoint => { assert.equal(endpoint, 'drive/files/show'); return file({ comment: 'Keep this' }); });
	const updated = await f.app.inject({ method: 'PUT', url: '/api/v1/media/opaque-file', headers: { authorization: f.authorization }, payload: { focus: '0.1,-0.2' } });
	assert.equal(updated.statusCode, 200, updated.body);
	assert.equal(updated.json().description, 'Keep this');
	const read = await f.app.inject({ method: 'GET', url: '/api/v1/media/opaque-file', headers: { authorization: f.authorization } });
	assert.deepEqual(read.json().meta.focus, { x: 0.1, y: -0.2 });
});

test('media operations require the media scope before uploading', async t => {
	const f = await fixture(t, () => assert.fail('No native operation should run'), ['read']);
	const response = await f.app.inject({ method: 'POST', url: '/api/v1/media', headers: { authorization: f.authorization }, payload: {} });
	assert.equal(response.statusCode, 403);
	assert.equal(f.calls.length, 0);
});

test('profile updates decode bracket fields and map native preferences plus isolated source defaults', async t => {
	const f = await fixture(t, (endpoint, body) => { assert.equal(endpoint, 'i/update'); return { ...alice, ...body }; });
	const response = await f.app.inject({ method: 'PATCH', url: '/api/v1/accounts/update_credentials', headers: { authorization: f.authorization, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'display_name=Updated&locked=false&bot=true&fields_attributes%5B0%5D%5Bname%5D=Site&fields_attributes%5B0%5D%5Bvalue%5D=https%3A%2F%2Fexample.com&source%5Bprivacy%5D=private&source%5Bsensitive%5D=true&source%5Blanguage%5D=ja' });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(f.calls[0].body, { name: 'Updated', isLocked: false, isBot: true, fields: [{ name: 'Site', value: 'https://example.com' }], alwaysMarkNsfw: true, lang: 'ja' });
	assert.equal(response.json().source.privacy, 'private');
	assert.equal(response.json().source.sensitive, true);
	assert.equal(response.json().source.language, 'ja');
	assert.deepEqual(await f.store.get('account-source', 'alice', 'defaults'), { privacy: 'private', sensitive: true, language: 'ja' });
});

test('profile multipart uploads both images and applies their native IDs in a single profile update', async t => {
	let uploads = 0;
	const f = await fixture(t, (endpoint, body) => {
		if (endpoint === 'drive/files/create') return file({ id: `image-${++uploads}` });
		assert.equal(endpoint, 'i/update');
		assert.deepEqual(body, { name: 'Updated', avatarId: 'image-1', bannerId: 'image-2' });
		return { ...alice, name: body.name };
	});
	const data = new FormData();
	data.set('avatar', new Blob(['avatar'], { type: 'image/png' }), 'avatar.png');
	data.set('header', new Blob(['header'], { type: 'image/jpeg' }), 'header.jpg');
	data.set('display_name', 'Updated');
	const multi = await encoded(data);
	const response = await f.app.inject({ method: 'PATCH', url: '/api/v1/accounts/update_credentials', ...multi, headers: { ...multi.headers, authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(f.calls.map(call => call.endpoint), ['drive/files/create', 'drive/files/create', 'i/update']);
});

test('invalid profile preferences reject a multipart request before uploading an avatar', async t => {
	const f = await fixture(t, () => assert.fail('No native operation should run'));
	const data = new FormData(); data.set('avatar', new Blob(['avatar'], { type: 'image/png' }), 'avatar.png'); data.set('source[privacy]', 'wrong');
	const multi = await encoded(data);
	assert.equal((await f.app.inject({ method: 'PATCH', url: '/api/v1/accounts/update_credentials', ...multi, headers: { ...multi.headers, authorization: f.authorization } })).statusCode, 422);
	assert.equal(f.calls.length, 0);
});

test('search returns the requested category and the correct hashtag entity version', async t => {
	const f = await fixture(t, (endpoint, body) => { assert.equal(endpoint, 'hashtags/search'); assert.equal(body.query, 'tag'); return ['tag', 'tag2']; });
	for (const version of [1, 2]) {
		const response = await f.app.inject({ method: 'GET', url: `/api/v${version}/search?q=%23tag&type=hashtags`, headers: { authorization: f.authorization } });
		assert.equal(response.statusCode, 200, response.body);
		assert.deepEqual(response.json().accounts, []);
		assert.deepEqual(response.json().statuses, []);
		assert.deepEqual(response.json().hashtags[0], version === 1 ? 'tag' : { name: 'tag', url: 'https://social.example/tags/tag', history: [] });
	}
});

test('anonymous search allows known accounts but prevents resolution, offset and full text search', async t => {
	const f = await fixture(t, (endpoint) => endpoint === 'users/search' ? [alice] : []);
	const result = await f.app.inject({ method: 'GET', url: '/api/v2/search?q=alice' });
	assert.equal(result.statusCode, 200);
	assert.equal(result.json().accounts[0].id, 'alice');
	assert.ok(f.calls.every(call => call.endpoint !== 'notes/search'));
	for (const query of ['resolve=true', 'offset=1&type=accounts', 'following=true']) assert.equal((await f.app.inject({ method: 'GET', url: `/api/v2/search?q=alice&${query}` })).statusCode, 401);
});

test('status search applies opaque cursor offsets and removes invisible results', async t => {
	const f = await fixture(t, (endpoint, body) => {
		assert.equal(endpoint, 'notes/search');
		assert.equal(body.userId, 'alice');
		assert.equal(body.sinceId, 'lower-opaque');
		assert.equal(body.offset, undefined);
		if (body.untilId === 'upper-opaque') return [note('n5'), note('n4', { isHidden: true }), note('n3')];
		assert.equal(body.untilId, 'n3');
		return [note('n2')];
	});
	const response = await f.app.inject({ method: 'GET', url: '/api/v2/search?q=text&type=statuses&offset=1&limit=2&max_id=upper-opaque&min_id=lower-opaque&account_id=alice', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(response.json().statuses.map((status: Json) => status.id), ['n3', 'n2']);
	assert.equal(f.calls.length, 2);
});

test('URL resolution uses the native resolver and respects result type and visibility', async t => {
	const f = await fixture(t, (endpoint, body) => { assert.equal(endpoint, 'ap/show'); assert.equal(body.uri, 'https://remote.example/note'); return { type: 'Note', object: note('remote', { isHidden: true }) }; });
	const response = await f.app.inject({ method: 'GET', url: '/api/v2/search?q=https%3A%2F%2Fremote.example%2Fnote&resolve=true', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	assert.deepEqual(response.json(), { accounts: [], statuses: [], hashtags: [] });
});

test('edit history converts native snapshots without replacing old media, poll or warning values', async t => {
	const f = await fixture(t, () => note('edited', { updatedAt: '2026-01-02T00:00:00Z', cw: 'Current warning', history: [{ createdAt: '2026-01-01T00:00:00Z', text: 'Old text', cw: 'Old warning', sensitive: true, files: [file({ comment: 'Old caption' })], emojiUrls: { wave: 'https://social.example/wave.png' }, poll: { multiple: false, choices: [{ text: 'Old option', votes: 1 }] } }] }));
	const response = await f.app.inject({ method: 'GET', url: '/api/v1/statuses/edited/history', headers: { authorization: f.authorization } });
	assert.equal(response.statusCode, 200, response.body);
	const revisions = response.json();
	assert.equal(revisions.length, 2);
	assert.match(revisions[0].content, /Old text/u);
	assert.equal(revisions[0].spoiler_text, 'Old warning');
	assert.equal(revisions[0].sensitive, true);
	assert.equal(revisions[0].media_attachments[0].description, 'Old caption');
	assert.deepEqual(revisions[0].poll, { options: [{ title: 'Old option' }] });
	assert.equal(revisions[0].emojis[0].shortcode, 'wave');
	assert.equal(revisions[1].created_at, '2026-01-02T00:00:00.000Z');
	assert.deepEqual(revisions[1].media_attachments, []);
	assert.equal(revisions[1].poll, null);
});

test('translation converts native text safely and separates the native warning delimiter', async t => {
	const f = await fixture(t, (endpoint, body) => {
		if (endpoint === 'notes/show') return note('translated', { cw: '元の警告' });
		assert.equal(endpoint, 'notes/translate');
		assert.deepEqual(body, { noteId: 'translated', targetLang: 'en' });
		return { sourceLang: 'JA', text: 'Translated warning\n-----\nHello <script>bad()</script>' };
	});
	const response = await f.app.inject({ method: 'POST', url: '/api/v1/statuses/translated/translate', headers: { authorization: f.authorization }, payload: { lang: 'en' } });
	assert.equal(response.statusCode, 200, response.body);
	assert.equal(response.json().spoiler_text, 'Translated warning');
	assert.match(response.json().content, /&lt;script&gt;/u);
	assert.doesNotMatch(response.json().content, /<script>/u);
	assert.equal(response.json().detected_source_language, 'ja');
});
