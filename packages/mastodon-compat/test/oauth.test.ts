/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { CompatStore } from '../src/store.js';
import { getAuthorization, handlesOAuth, registerOAuth } from '../src/oauth.js';
import { allowsScope, assertScope, normalizeScopes, toNativePermissions } from '../src/scopes.js';

async function fixture(t: TestContext, nativeResult: unknown = { ok: true, token: 'native-application-token', user: { id: 'alice' } }) {
	const server = Fastify();
	await server.register(multipart);
	const store = new CompatStore(':memory:');
	let now = 1000;
	const calls: string[] = [];
	registerOAuth(server, {
		store, publicUrl: 'https://social.example', nativeUrl: 'http://127.0.0.1:3000', now: () => now,
		native: { async call<T>(endpoint: string): Promise<T> { calls.push(endpoint); return nativeResult as T; } },
	});
	server.get('/inspect', async request => ({ handled: handlesOAuth(request), grant: getAuthorization(request, store) }));
	t.after(async () => { await server.close(); store.close(); });
	async function app(scopes = 'read write', redirect = 'testapp://callback') {
		const response = await server.inject({ method: 'POST', url: '/api/v1/apps', payload: { client_name: 'Example', redirect_uris: redirect, scopes } });
		assert.equal(response.statusCode, 200);
		return response.json<{ client_id: string; client_secret: string }>();
	}
	async function begin(clientId: string, extra: Record<string, string> = {}) {
		const query = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: 'testapp://callback', ...extra });
		return server.inject({ method: 'GET', url: `/oauth/authorize?${query}` });
	}
	async function complete(clientId: string, extra: Record<string, string> = {}) {
		const started = await begin(clientId, extra);
		assert.equal(started.statusCode, 302);
		const nativeUrl = new URL(String(started.headers.location));
		const callbackUrl = new URL(nativeUrl.searchParams.get('callback')!);
		const response = await server.inject({ method: 'GET', url: callbackUrl.pathname + callbackUrl.search });
		return { response, nativeUrl, callbackUrl };
	}
	return { server, store, app, begin, complete, calls, advance: (ms: number) => { now += ms; } };
}

test('application registration accepts JSON, URL encoded arrays and multipart fields', async t => {
	const f = await fixture(t);
	const created = await f.app();
	assert.match(created.client_id, /^mc_/u);
	assert.match(created.client_secret, /^mc_/u);
	const form = await f.server.inject({ method: 'POST', url: '/api/v1/apps', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'client_name=Form&redirect_uris%5B%5D=one%3A%2F%2Fcallback&redirect_uris%5B%5D=two%3A%2F%2Fcallback' });
	assert.equal(form.statusCode, 200);
	assert.deepEqual(form.json().redirect_uris, ['one://callback', 'two://callback']);
	const multipartBody = '--bound\r\nContent-Disposition: form-data; name="client_name"\r\n\r\nMultipart\r\n--bound\r\nContent-Disposition: form-data; name="redirect_uris"\r\n\r\napp://callback\r\n--bound--\r\n';
	const multi = await f.server.inject({ method: 'POST', url: '/api/v1/apps', headers: { 'content-type': 'multipart/form-data; boundary=bound' }, payload: multipartBody });
	assert.equal(multi.statusCode, 200);
	assert.deepEqual(multi.json().scopes, ['read']);
	const invalid = await f.server.inject({ method: 'POST', url: '/api/v1/apps', payload: { client_name: 'Unsafe', redirect_uris: 'javascript:alert(1)' } });
	assert.equal(invalid.statusCode, 422);
});

test('MiAuth callback yields a one-time authorization code and an isolated bearer', async t => {
	const f = await fixture(t);
	const client = await f.app();
	const completed = await f.complete(client.client_id, { state: 'client-state' });
	assert.equal(completed.nativeUrl.origin, 'https://social.example');
	assert.match(completed.nativeUrl.pathname, /^\/miauth\/[\da-f-]{36}$/u);
	assert.ok(completed.nativeUrl.searchParams.get('permission')!.includes('read:account'));
	assert.deepEqual(f.calls, [`miauth/${completed.nativeUrl.pathname.split('/').at(-1)}/check`]);
	const location = new URL(String(completed.response.headers.location));
	assert.equal(location.searchParams.get('state'), 'client-state');
	const code = location.searchParams.get('code')!;
	assert.ok(code);
	const body = { ...client, grant_type: 'authorization_code', code, redirect_uri: 'testapp://callback' };
	const response = await f.server.inject({ method: 'POST', url: '/oauth/token', payload: body });
	assert.equal(response.statusCode, 200);
	assert.equal(response.json().access_token.includes('native-application-token'), false);
	const grant = f.store.getGrant(response.json().access_token)!;
	assert.equal(grant.userId, 'alice');
	assert.equal(grant.nativeToken, 'native-application-token');
	assert.equal(grant.kind, 'user');
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload: body })).statusCode, 400);
	assert.equal((await f.server.inject({ method: 'GET', url: completed.callbackUrl.pathname + completed.callbackUrl.search })).statusCode, 400);
	assert.equal(f.calls.length, 1);
});

test('PKCE requires S256, verifies the challenge, and retains a code after a rejected verifier', async t => {
	const f = await fixture(t);
	const client = await f.app('read');
	const verifier = 'a'.repeat(43);
	const challenge = createHash('sha256').update(verifier).digest('base64url');
	assert.equal((await f.begin(client.client_id, { code_challenge: verifier, code_challenge_method: 'plain' })).statusCode, 400);
	const { response } = await f.complete(client.client_id, { code_challenge: challenge, code_challenge_method: 'S256' });
	const code = new URL(String(response.headers.location)).searchParams.get('code');
	const payload = { ...client, grant_type: 'authorization_code', code, redirect_uri: 'testapp://callback', code_verifier: 'b'.repeat(43) };
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload })).statusCode, 400);
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, code_verifier: verifier } })).statusCode, 200);
});

test('client, redirect and scope binding reject escalation before consuming a valid code', async t => {
	const f = await fixture(t);
	const first = await f.app();
	const second = await f.app();
	assert.equal((await f.begin(first.client_id, { redirect_uri: 'evil://callback' })).statusCode, 400);
	const { response } = await f.complete(first.client_id, { scope: 'read:accounts' });
	const code = new URL(String(response.headers.location)).searchParams.get('code');
	const payload = { ...first, grant_type: 'authorization_code', code, redirect_uri: 'testapp://callback' };
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, ...second } })).statusCode, 400);
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, redirect_uri: 'wrong://callback' } })).statusCode, 400);
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload: { ...payload, scope: 'write' } })).statusCode, 400);
	const good = await f.server.inject({ method: 'POST', url: '/oauth/token', payload });
	assert.equal(good.statusCode, 200);
	assert.equal(good.json().scope, 'read:accounts');
});

test('client_credentials uses persisted app-only grants and Basic client authentication', async t => {
	const f = await fixture(t);
	const client = await f.app('read');
	const basic = Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64');
	const response = await f.server.inject({ method: 'POST', url: '/oauth/token', headers: { authorization: `basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'grant_type=client_credentials' });
	assert.equal(response.statusCode, 200);
	const grant = f.store.getGrant(response.json().access_token)!;
	assert.equal(grant.kind, 'app');
	assert.equal(grant.nativeToken, undefined);
	assert.equal(grant.userId, undefined);
	const verified = await f.server.inject({ method: 'GET', url: '/api/v1/apps/verify_credentials', headers: { authorization: `Bearer ${response.json().access_token}` } });
	assert.equal(verified.json().name, 'Example');
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload: { ...client, client_secret: 'wrong', grant_type: 'client_credentials' } })).statusCode, 401);
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload: { ...client, grant_type: 'refresh_token' } })).json().error, 'unsupported_grant_type');
});

test('revocation is client-owned, persistent and idempotent', async t => {
	const f = await fixture(t);
	const client = await f.app('read');
	const other = await f.app('read');
	const response = await f.server.inject({ method: 'POST', url: '/oauth/token', payload: { ...client, grant_type: 'client_credentials' } });
	const token = response.json().access_token;
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/revoke', payload: { ...other, token } })).statusCode, 403);
	assert.ok(f.store.getGrant(token));
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/revoke', payload: { ...client } })).statusCode, 403);
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/revoke', payload: { ...client, token } })).statusCode, 200);
	assert.equal(f.store.getGrant(token), undefined);
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/revoke', payload: { ...client, token } })).statusCode, 200);
});

test('expired authorization state and code cannot issue grants', async t => {
	const f = await fixture(t);
	const client = await f.app();
	const started = await f.begin(client.client_id);
	const callbackUrl = new URL(new URL(String(started.headers.location)).searchParams.get('callback')!);
	f.advance(11 * 60 * 1000);
	assert.equal((await f.server.inject({ method: 'GET', url: callbackUrl.pathname + callbackUrl.search })).statusCode, 400);
	assert.equal(f.calls.length, 0);
	const { response } = await f.complete(client.client_id);
	const code = new URL(String(response.headers.location)).searchParams.get('code');
	f.advance(6 * 60 * 1000);
	assert.equal((await f.server.inject({ method: 'POST', url: '/oauth/token', payload: { ...client, grant_type: 'authorization_code', code, redirect_uri: 'testapp://callback' } })).statusCode, 400);
});

test('OOB displays the code without redirecting to a URN and denied MiAuth returns access_denied', async t => {
	const f = await fixture(t);
	const client = await f.app('read', 'urn:ietf:wg:oauth:2.0:oob');
	const { response } = await f.complete(client.client_id, { redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' });
	assert.equal(response.statusCode, 200);
	assert.equal(response.headers.location, undefined);
	assert.match(response.body, /readonly value="mc_/u);
	assert.equal(response.headers['cache-control'], 'no-store');
	const denied = await fixture(t, { ok: false });
	const deniedClient = await denied.app();
	const result = await denied.complete(deniedClient.client_id, { state: 'preserved' });
	const uri = new URL(String(result.response.headers.location));
	assert.equal(uri.searchParams.get('error'), 'access_denied');
	assert.equal(uri.searchParams.get('state'), 'preserved');
});

test('force-login fails explicitly, optional language is a hint, and native tokens never authenticate the gateway', async t => {
	const f = await fixture(t);
	const client = await f.app();
	assert.equal((await f.begin(client.client_id, { force_login: 'true' })).json().error, 'unsupported_parameter');
	assert.equal((await f.begin(client.client_id, { lang: 'ja-JP' })).statusCode, 302);
	assert.equal((await f.begin(client.client_id, { force_login: 'false' })).statusCode, 302);
	assert.equal((await f.server.inject({ method: 'GET', url: '/api/v1/apps/verify_credentials', headers: { authorization: 'Bearer native-application-token' } })).statusCode, 401);
	assert.equal((await f.server.inject({ method: 'GET', url: '/api/v1/apps/verify_credentials' })).statusCode, 401);
});

test('scope implication and native permission mapping stay minimal', () => {
	assert.deepEqual(normalizeScopes('read read:accounts read'), ['read', 'read:accounts']);
	assert.equal(allowsScope(['read'], 'write:accounts'), false);
	assert.equal(allowsScope(['follow'], 'write:blocks'), true);
	assert.throws(() => assertScope(['profile'], 'read:statuses'), /read:statuses/u);
	assert.throws(() => normalizeScopes('admin'), /Invalid/u);
	assert.deepEqual(toNativePermissions(['write:filters', 'write:collections']), []);
	assert.deepEqual(toNativePermissions(['write:statuses']), ['write:notes', 'write:votes']);
	assert.deepEqual(toNativePermissions(['read:notifications']), ['read:notifications', 'read:account']);
});
