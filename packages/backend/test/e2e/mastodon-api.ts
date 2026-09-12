/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterEach, beforeAll, describe, test } from 'vitest';
import WebSocket from 'ws';
import { createGateway, createPostgresStore } from '@pari/mastodon-compat';
import { loadConfig } from '@/config.js';
import { api, port, relativeFetch, sendEnvResetRequest, signup } from '../utils.js';
import type * as misskey from 'misskey-js';

type Json = Record<string, any>;

describe('Mastodon gateway against real Misskey HTTP and streaming APIs', () => {
	let alice: misskey.entities.SignupResponse;
	let bob: misskey.entities.SignupResponse;
	let aliceToken: string;
	let bobToken: string;
	const sockets: WebSocket[] = [];

	async function request(path: string, token?: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
		const response = await relativeFetch(path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), redirect: 'manual' });
		const text = await response.text();
		let data: any;
		try { data = JSON.parse(text); } catch { data = text; }
		return { response, status: response.status, body: data };
	}

	async function ok(path: string, token?: string, method = 'GET', body?: unknown, headers?: Record<string, string>): Promise<any> {
		const result = await request(path, token, method, body, headers);
		assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status} ${JSON.stringify(result.body)}`);
		return result.body;
	}

	async function authorize(user: misskey.entities.SignupResponse, scope = 'read write follow push') {
		const application = await ok('/api/v1/apps', undefined, 'POST', { client_name: 'Gateway integration', redirect_uris: 'gateway-test://oauth', scopes: scope });
		const params = new URLSearchParams({ client_id: application.client_id, response_type: 'code', redirect_uri: 'gateway-test://oauth', scope, state: 'client-state' });
		const response = await relativeFetch(`/oauth/authorize?${params}`, { redirect: 'manual' });
		assert.equal(response.status, 302, await response.clone().text());
		const miauth = new URL(response.headers.get('location')!);
		assert.match(miauth.pathname, /^\/miauth\//u);
		const native = await api('miauth/gen-token', { session: miauth.pathname.split('/').at(-1)!, permission: miauth.searchParams.get('permission')!.split(','), name: 'Gateway integration' }, user);
		assert.equal(native.status, 200, JSON.stringify(native.body));
		const callback = new URL(miauth.searchParams.get('callback')!);
		const callbackResponse = await relativeFetch(callback.pathname + callback.search, { redirect: 'manual' });
		assert.equal(callbackResponse.status, 302, await callbackResponse.clone().text());
		const destination = new URL(callbackResponse.headers.get('location')!);
		assert.equal(destination.searchParams.get('state'), 'client-state');
		assert.ok(destination.searchParams.get('code'), destination.toString());
		const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: application.client_id, client_secret: application.client_secret, code: destination.searchParams.get('code')!, redirect_uri: 'gateway-test://oauth' });
		const token = await ok('/oauth/token', undefined, 'POST', form.toString(), { 'content-type': 'application/x-www-form-urlencoded' });
		return { token: token.access_token as string, nativeToken: native.body.token, application };
	}

	beforeAll(async () => {
		alice = await signup({ username: 'gateway_alice' });
		bob = await signup({ username: 'gateway_bob' });
		assert.ok(alice?.id); assert.ok(bob?.id);
		aliceToken = (await authorize(alice)).token;
		bobToken = (await authorize(bob)).token;
	});
	afterEach(() => { for (const socket of sockets.splice(0)) socket.terminate(); });

	test('serves usable bootstrap entities and keeps native OAuth/token isolation', async () => {
		const account = await ok('/api/v1/accounts/verify_credentials', aliceToken);
		assert.equal(account.id, alice.id); assert.ok(account.source); assert.equal(typeof account.avatar, 'string');
		for (const version of [1, 2]) {
			const instance = await ok(`/api/v${version}/instance`);
			assert.ok(instance.version); assert.ok(instance.configuration.statuses.max_characters > 0);
		}
		assert.ok(Array.isArray(await ok('/api/v1/custom_emojis')));
		assert.equal((await request('/api/v1/accounts/verify_credentials', alice.token)).status, 401);
		assert.equal((await api('i', {}, { token: aliceToken, bearer: true })).status, 401);
		const native = await api('i', {}, alice); assert.equal(native.status, 200); assert.equal(native.body.id, alice.id);
		assert.equal((await request('/api/v1/statuses', aliceToken, 'POST', { status: 'invalid visibility', visibility: 'everyone' })).status, 422);
	});

	test('posts JSON/form/multipart, preserves idempotency, edits, and returns real history', async () => {
		const body = { status: 'JSON gateway text <script>alert(1)</script>', visibility: 'public', language: 'zh', quote_approval_policy: 'public' };
		const first = await ok('/api/v1/statuses', aliceToken, 'POST', body, { 'idempotency-key': 'test-post-once' });
		const replay = await ok('/api/v1/statuses', aliceToken, 'POST', body, { 'idempotency-key': 'test-post-once' });
		assert.equal(replay.id, first.id); assert.ok(!first.content.includes('<script>'));
		assert.equal(first.language, 'zh');
		assert.equal((await api('notes/show', { noteId: first.id }, alice)).body.text, body.status);
		const form = await ok('/api/v1/statuses', aliceToken, 'POST', 'status=URL+encoded+post&visibility=unlisted&quote_approval_policy=public', { 'content-type': 'application/x-www-form-urlencoded' });
		assert.equal(form.visibility, 'unlisted');
		const parts = new FormData(); parts.append('status', 'multipart post'); parts.append('visibility', 'public'); parts.append('quote_approval_policy', 'public');
		const multipart = await relativeFetch('/api/v1/statuses', { method: 'POST', headers: { authorization: `Bearer ${aliceToken}` }, body: parts });
		assert.equal(multipart.status, 200, await multipart.clone().text());
		const edited = await ok(`/api/v1/statuses/${first.id}`, aliceToken, 'PUT', { status: 'edited through gateway', spoiler_text: 'CW' });
		assert.match(edited.content, /edited through gateway/u); assert.equal(edited.spoiler_text, 'CW');
		const history = await ok(`/api/v1/statuses/${first.id}/history`, aliceToken); assert.ok(history.length >= 2);
		const source = await ok(`/api/v1/statuses/${first.id}/source`, aliceToken); assert.equal(source.text, 'edited through gateway');
		await ok(`/api/v1/statuses/${first.id}`, aliceToken, 'DELETE');
		assert.equal((await request(`/api/v1/statuses/${first.id}`, aliceToken)).status, 404);
	});

	test('creates native quotes with and without comments and preserves visibility restrictions', async () => {
		const original = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'Quote target', quote_approval_policy: 'public' });
		const payload = { status: 'Quoted comment', quoted_status_id: original.id, quote_approval_policy: 'public' };
		const quoted = await ok('/api/v1/statuses', bobToken, 'POST', payload, { 'idempotency-key': 'quoted-comment' });
		assert.equal(quoted.quote.quoted_status.id, original.id); assert.equal(quoted.quote.state, 'accepted'); assert.equal(quoted.reblog, null);
		const native = await api('notes/show', { noteId: quoted.id }, bob);
		assert.equal(native.body.renoteId, original.id); assert.equal(native.body.text, payload.status);
		assert.equal((await ok('/api/v1/statuses', bobToken, 'POST', payload, { 'idempotency-key': 'quoted-comment' })).id, quoted.id);
		const bare = await ok('/api/v1/statuses', bobToken, 'POST', { quoted_status_id: original.id, quote_approval_policy: 'public' });
		assert.equal(bare.quote.quoted_status.id, original.id); assert.equal(bare.reblog, null);
		assert.equal((await api('notes/show', { noteId: bare.id }, bob)).body.text, original.url);
		const boost = await api('notes/create', { renoteId: original.id }, bob); assert.equal(boost.status, 200);
		const unwrapped = await ok('/api/v1/statuses', bobToken, 'POST', { quoted_status_id: boost.body.createdNote.id, quote_approval_policy: 'public' });
		assert.equal(unwrapped.quote.quoted_status.id, original.id);
		const cleared = await ok(`/api/v1/statuses/${quoted.id}`, bobToken, 'PUT', { status: '', quote_approval_policy: 'public' });
		assert.equal(cleared.quote.quoted_status.id, original.id);
		assert.equal((await api('notes/show', { noteId: quoted.id }, bob)).body.text, original.url);
		const direct = await ok('/api/v1/statuses', bobToken, 'POST', { status: '@gateway_alice Direct quote', quoted_status_id: original.id, visibility: 'direct', quote_approval_policy: 'nobody' });
		assert.equal(direct.visibility, 'direct'); assert.equal((await ok(`/api/v1/statuses/${direct.id}`, aliceToken)).quote.quoted_status.id, original.id);
		const privateNote = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'Private quote target', visibility: 'private', quote_approval_policy: 'nobody' });
		assert.equal((await request('/api/v1/statuses', bobToken, 'POST', { status: 'Cannot quote private target', quoted_status_id: privateNote.id, quote_approval_policy: 'public' })).status, 404);
		assert.equal((await request('/api/v1/statuses', aliceToken, 'POST', { status: 'Cannot enforce restrictive public policy', quote_approval_policy: 'nobody' })).status, 422);
		const notes = await api('users/notes', { userId: alice.id, limit: 100 }, alice);
		assert.ok(!notes.body.some(note => note.text === 'Cannot enforce restrictive public policy'));
	});

	test('loads paginated timelines and does not expose follower-only or direct notes', async () => {
		const a = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'timeline older', visibility: 'public' });
		const b = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'timeline newer', visibility: 'public' });
		const page = await request('/api/v1/timelines/public?local=true&limit=1', aliceToken);
		assert.equal(page.status, 200, JSON.stringify(page.body)); assert.equal(page.body[0].id, b.id);
		assert.match(page.response.headers.get('link') ?? '', /rel="next"/u);
		const older = await ok(`/api/v1/timelines/public?local=true&limit=1&max_id=${b.id}`, aliceToken); assert.equal(older[0].id, a.id);
		const newest = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'timeline newest' });
		assert.equal((await ok(`/api/v1/timelines/public?local=true&limit=1&since_id=${a.id}`, aliceToken))[0].id, newest.id);
		assert.equal((await ok(`/api/v1/timelines/public?local=true&limit=1&min_id=${a.id}`, aliceToken))[0].id, b.id);
		const privateNote = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'followers only secret', visibility: 'private' });
		assert.equal((await request(`/api/v1/statuses/${privateNote.id}`, bobToken)).status, 404);
		assert.equal((await request(`/api/v1/statuses/${privateNote.id}`)).status, 404);
		const direct = await ok('/api/v1/statuses', aliceToken, 'POST', { status: '@gateway_bob direct secret', visibility: 'direct' });
		assert.equal((await ok(`/api/v1/statuses/${direct.id}`, bobToken)).visibility, 'direct');
		assert.equal((await request(`/api/v1/statuses/${direct.id}`)).status, 404);
		const publicNotes = await ok('/api/v1/timelines/public?local=true&limit=80', bobToken);
		assert.ok(!publicNotes.some((item: Json) => [privateNote.id, direct.id].includes(item.id)));
	});

	test('follows, bookmarks and favourites use native state without replacing an emoji', async () => {
		const followed = await ok(`/api/v1/accounts/${alice.id}/follow`, bobToken, 'POST', {}); assert.equal(followed.following, true);
		const note = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'native actions' });
		const fav = await ok(`/api/v1/statuses/${note.id}/favourite`, bobToken, 'POST', {}); assert.equal(fav.favourited, true);
		await ok(`/api/v1/statuses/${note.id}/unfavourite`, bobToken, 'POST', {});
		const reaction = await api('notes/reactions/create', { noteId: note.id, reaction: '🎉' }, bob); assert.equal(reaction.status, 204);
		assert.equal((await request(`/api/v1/statuses/${note.id}/favourite`, bobToken, 'POST', {})).status, 409);
		await ok(`/api/v1/statuses/${note.id}/unfavourite`, bobToken, 'POST', {});
		assert.equal((await api('notes/show', { noteId: note.id }, bob)).body.myReaction, '🎉');
		const saved = await ok(`/api/v1/statuses/${note.id}/bookmark`, bobToken, 'POST', {}); assert.equal(saved.bookmarked, true);
		assert.equal((await api('notes/state', { noteId: note.id }, bob)).body.isFavorited, true);
		assert.ok((await ok('/api/v1/bookmarks', bobToken)).some((item: Json) => item.id === note.id));
		await ok(`/api/v1/statuses/${note.id}/unbookmark`, bobToken, 'POST', {});
		assert.equal((await api('notes/state', { noteId: note.id }, bob)).body.isFavorited, false);
		const boosted = await ok(`/api/v1/statuses/${note.id}/reblog`, bobToken, 'POST', {}); assert.equal(boosted.reblogged, true);
		await ok(`/api/v1/statuses/${note.id}/unreblog`, bobToken, 'POST', {});
	});

	test('accepts bracketed poll choices, validates them before writing, and votes atomically', async () => {
		const post = await ok('/api/v1/statuses', aliceToken, 'POST', 'status=poll&poll[options][]=one&poll[options][]=two&poll[options][]=three&poll[multiple]=true&poll[expires_in]=3600', { 'content-type': 'application/x-www-form-urlencoded' });
		assert.equal(post.poll.options.length, 3);
		assert.equal((await request(`/api/v1/polls/${post.id}/votes`, bobToken, 'POST', { choices: [0, 99] })).status, 422);
		assert.equal((await ok(`/api/v1/polls/${post.id}`, bobToken)).votes_count, 0);
		const voted = await ok(`/api/v1/polls/${post.id}/votes`, bobToken, 'POST', { choices: [0, 2] });
		assert.deepEqual(voted.own_votes, [0, 2]); assert.equal(voted.votes_count, 2);
	});

	test('uploads real media and creates a status with the returned drive file', async () => {
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzBkAAAAASUVORK5CYII=', 'base64');
		const form = new FormData(); form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png'); form.append('description', 'one pixel');
		const response = await relativeFetch('/api/v2/media', { method: 'POST', headers: { authorization: `Bearer ${aliceToken}` }, body: form });
		assert.equal(response.status, 200, await response.clone().text());
		const file = await response.json() as Json; assert.equal(file.type, 'image'); assert.equal(file.description, 'one pixel');
		const note = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'image attached', media_ids: [file.id], sensitive: true });
		assert.equal(note.media_attachments[0].id, file.id); assert.equal(note.sensitive, true);
	});

	test('lists, filters, markers and notifications return usable persisted entities', async () => {
		const list = await ok('/api/v1/lists', bobToken, 'POST', { title: 'People' });
		await ok(`/api/v1/lists/${list.id}/accounts`, bobToken, 'POST', { account_ids: [alice.id] });
		assert.ok((await ok(`/api/v1/lists/${list.id}/accounts`, bobToken)).some((item: Json) => item.id === alice.id));
		const filter = await ok('/api/v2/filters', bobToken, 'POST', { title: 'Muted phrase', context: ['home'], filter_action: 'warn', keywords_attributes: [{ keyword: 'native actions', whole_word: false }] });
		assert.ok(filter.id); assert.ok((await ok('/api/v2/filters', bobToken)).some((item: Json) => item.id === filter.id));
		const markers = await ok('/api/v1/markers', bobToken, 'POST', { home: { last_read_id: list.id } });
		assert.equal(markers.home.version, 1); assert.equal((await ok('/api/v1/markers?timeline[]=home', bobToken)).home.last_read_id, list.id);
		await ok('/api/v1/statuses', aliceToken, 'POST', { status: '@gateway_bob notification mention' });
		let notifications: Json[] = [];
		for (let attempt = 0; attempt < 20; attempt++) { notifications = await ok('/api/v1/notifications', bobToken); if (notifications.some(item => item.type === 'mention')) break; await new Promise(resolve => setTimeout(resolve, 100)); }
		assert.ok(notifications.some(item => item.type === 'mention'));
		const grouped = await ok('/api/v2/notifications', bobToken);
		assert.ok(grouped.notification_groups.some((item: Json) => item.type === 'mention'));
		assert.ok(grouped.accounts.some((item: Json) => item.id === alice.id));
		const group = grouped.notification_groups[0];
		assert.equal((await ok(`/api/v2/notifications/${group.group_key}`, bobToken)).notification_groups[0].group_key, group.group_key);
	});

	test('streams public updates through a real native WebSocket subscription', async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/streaming?access_token=${encodeURIComponent(bobToken)}&stream=public:local`);
		sockets.push(socket); await once(socket, 'open');
		const event = new Promise<Json>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Missing streaming update')), 10000);
			socket.on('message', data => { const frame = JSON.parse(data.toString()); if (frame.event === 'update' && JSON.parse(frame.payload).content.includes('real streaming event')) { clearTimeout(timer); resolve(frame); } });
		});
		// Native channel connect has no acknowledgement; allow the subscription frame to arrive.
		await new Promise(resolve => setTimeout(resolve, 150));
		const note = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'real streaming event' });
		const frame = await event; assert.deepEqual(frame.stream, ['public:local']); assert.equal(JSON.parse(frame.payload).id, note.id);
	});

	test('validates before writing, atomically claims direct idempotency, and traverses reply context', async () => {
		const invalid = await request('/api/v1/statuses', aliceToken, 'POST', { status: 'must never publish invalid sensitivity', sensitive: 'invalid' });
		assert.equal(invalid.status, 422);
		const notes = await api('users/notes', { userId: alice.id, limit: 100 }, alice);
		assert.ok(!notes.body.some(note => note.text === 'must never publish invalid sensitivity'));
		const body = { status: '@gateway_bob only one direct write', visibility: 'direct' };
		const requests = await Promise.all([request('/api/v1/statuses', aliceToken, 'POST', body, { 'idempotency-key': 'parallel-direct' }), request('/api/v1/statuses', aliceToken, 'POST', body, { 'idempotency-key': 'parallel-direct' })]);
		assert.ok(requests.some(item => item.status === 200)); assert.ok(requests.every(item => [200, 409].includes(item.status)));
		const directNotes = await api('users/notes', { userId: alice.id, limit: 100 }, alice); assert.equal(directNotes.body.filter(note => note.text === body.status).length, 1);
		const root = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'context root' });
		const child = await ok('/api/v1/statuses', bobToken, 'POST', { status: 'context reply', in_reply_to_id: root.id });
		const grandchild = await ok('/api/v1/statuses', aliceToken, 'POST', { status: 'context nested reply', in_reply_to_id: child.id });
		const quoted = await api('notes/create', { text: 'context quote excluded', renoteId: root.id }, bob); assert.equal(quoted.status, 200);
		const context = await ok(`/api/v1/statuses/${root.id}/context`, aliceToken);
		assert.ok(context.descendants.some((item: Json) => item.id === grandchild.id));
		assert.ok(!context.descendants.some((item: Json) => item.id === quoted.body.createdNote.id));
		await ok(`/api/v1/statuses/${root.id}/bookmark`, bobToken, 'POST', {});
		assert.equal((await api('notes/favorites/delete', { noteId: root.id }, bob)).status, 204);
		assert.equal((await ok(`/api/v1/statuses/${root.id}`, bobToken)).bookmarked, false);
	});

	test('runs as a separate service and preserves authorization across a gateway restart', async () => {
		const config = loadConfig();
		const newGateway = async () => createGateway({
			publicUrl: 'http://misskey.local',
			nativeUrl: `http://127.0.0.1:${port}`,
			store: await createPostgresStore({ host: config.db.host, port: config.db.port, database: config.db.db, user: config.db.user, password: config.db.pass, ...config.db.extra }),
		});
		let gateway = await newGateway();
		await gateway.listen({ host: '127.0.0.1', port: 0 });
		const address = gateway.server.address(); assert.ok(address && typeof address !== 'string');
		const base = `http://127.0.0.1:${address.port}`;
		const fetchGateway = async (path: string, init?: RequestInit) => fetch(new URL(path, base), { ...init, redirect: 'manual' });
		try {
			const registered = await fetchGateway('/api/v1/apps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Standalone adapter', redirect_uris: 'gateway-test://oauth', scopes: 'read write' }) });
			const application = await registered.json() as Json; assert.equal(registered.status, 200);
			const authorize = await fetchGateway(`/oauth/authorize?${new URLSearchParams({ client_id: application.client_id, response_type: 'code', redirect_uri: 'gateway-test://oauth', scope: 'read write' })}`);
			assert.equal(authorize.status, 302); const miauth = new URL(authorize.headers.get('location')!);
			assert.equal((await api('miauth/gen-token', { session: miauth.pathname.split('/').at(-1)!, permission: miauth.searchParams.get('permission')!.split(',') }, alice)).status, 200);
			const callbackUrl = new URL(miauth.searchParams.get('callback')!);
			const callback = await fetchGateway(callbackUrl.pathname + callbackUrl.search); assert.equal(callback.status, 302);
			const code = new URL(callback.headers.get('location')!).searchParams.get('code'); assert.ok(code);
			const tokenResponse = await fetchGateway('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: application.client_id, client_secret: application.client_secret, grant_type: 'authorization_code', redirect_uri: 'gateway-test://oauth', code }) });
			const token = await tokenResponse.json() as Json; assert.equal(tokenResponse.status, 200);
			const created = await fetchGateway('/api/v1/statuses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token.access_token}` }, body: JSON.stringify({ status: 'posted through the separate HTTP gateway' }) });
			const note = await created.json() as Json; assert.equal(created.status, 200, JSON.stringify(note));
			assert.equal((await api('notes/show', { noteId: note.id }, alice)).body.text, 'posted through the separate HTTP gateway');
			const mediaPage = await fetchGateway(`/api/v1/accounts/${alice.id}/statuses?only_media=true`, { headers: { authorization: `Bearer ${token.access_token}` } }); assert.equal(mediaPage.status, 200);
			await gateway.close();
			gateway = await newGateway();
			await gateway.listen({ host: '127.0.0.1', port: address.port });
			const restored = await fetchGateway('/api/v1/accounts/verify_credentials', { headers: { authorization: `Bearer ${token.access_token}` } });
			assert.equal(restored.status, 200, await restored.clone().text());
			assert.equal((await restored.json() as Json).id, alice.id);
		} finally { await gateway.close(); }
	});

	test('honours narrow scopes, app tokens, OAuth revoke, and native grant revocation', async () => {
		const scoped = await authorize(bob, 'read:filters write:filters');
		assert.ok(Array.isArray(await ok('/api/v2/filters', scoped.token)));
		assert.equal((await request('/api/v1/statuses', scoped.token, 'POST', { status: 'not authorized' })).status, 403);
		const revoked = await api('i/revoke-token', { token: scoped.nativeToken }, bob); assert.equal(revoked.status, 204);
		assert.equal((await request('/api/v2/filters', scoped.token)).status, 401);
		const application = await ok('/api/v1/apps', undefined, 'POST', { client_name: 'Application only', redirect_uris: 'gateway-test://oauth', scopes: 'read' });
		const appToken = await ok('/oauth/token', undefined, 'POST', { grant_type: 'client_credentials', client_id: application.client_id, client_secret: application.client_secret, scope: 'read' });
		assert.equal((await request('/api/v1/accounts/verify_credentials', appToken.access_token)).status, 401);
		await ok('/oauth/revoke', undefined, 'POST', { client_id: application.client_id, client_secret: application.client_secret, token: appToken.access_token });
		assert.equal((await request('/api/v1/apps/verify_credentials', appToken.access_token)).status, 401);
	});

	test('restarts the embedded host with an active compatibility stream', async () => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/streaming?access_token=${encodeURIComponent(bobToken)}&stream=user`);
		sockets.push(socket); await once(socket, 'open');
		const closed = once(socket, 'close');
		await sendEnvResetRequest();
		await closed;
		assert.equal(socket.readyState, WebSocket.CLOSED);
		// The native test host deliberately drops its PostgreSQL schema when it
		// starts. Persistence is exercised above without resetting the upstream.
		assert.ok((await ok('/api/v1/instance')).version);
	});
});
