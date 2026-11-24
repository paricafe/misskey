/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { dispatchHandler } from '../src/oauth.js';
import { EntityConverter } from '../src/entities.js';
import { registerFeatures } from '../src/features.js';
import { NativeClient } from '../src/native-client.js';
import { parameters } from '../src/parameters.js';
import { Routes } from '../src/routes.js';
import { createPostgresStore, hashCredential, type CompatStore } from '../src/store.js';
import { postgresFixture } from './postgres-http-fixture.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(accept => { resolve = accept; });
	return { promise, resolve };
}

const postgresOnly = { skip: !process.env.MASTODON_TEST_DATABASE_URL };

test('PostgreSQL idempotency uses the indexed TTL', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const store = await createPostgresStore({ connectionString });
	const inspection = new Pool({ connectionString });
	try {
		await store.putIdempotency('alice', 'new', { digest: 'request', id: 'note', expiresAt: 100 });
		const row = (await inspection.query('SELECT "expiresAt", "value" FROM "mastodon_compat_entry" WHERE "key" = $1', ['new'])).rows[0];
		assert.equal(row.expiresAt, '100');
		assert.equal(row.value.expiresAt, 100);
		await inspection.query('UPDATE "mastodon_compat_entry" SET "value" = jsonb_set("value", \'{expiresAt}\', \'200\') WHERE "key" = $1', ['new']);
		assert.equal(await store.getIdempotency('alice', 'new', 100), undefined);
		await store.putIdempotency('alice', 'live', { digest: 'pending', expiresAt: 200 });
		await inspection.query('UPDATE "mastodon_compat_entry" SET "value" = jsonb_set("value", \'{expiresAt}\', \'1\') WHERE "key" = $1', ['live']);
		assert.equal((await store.getIdempotency('alice', 'live', 100))?.expiresAt, 200);
		await store.prune(100);
		assert.equal(await store.get('idempotency', 'alice', 'new'), undefined);
		assert.ok(await store.getIdempotency('alice', 'live', 100));
	} finally { await store.close(); await inspection.end(); }
});

test('PostgreSQL prunes bounded batches without deleting active or unrelated state', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const store = await createPostgresStore({ connectionString });
	try {
		const { client } = await store.createClient({ name: 'App', scopes: ['read'], redirectUris: ['app://callback'] });
		const { token } = await store.createGrant({ clientId: client.id, kind: 'user', userId: 'alice', nativeToken: 'native', scopes: ['read'] });
		for (let index = 0; index < 3; index++) await store.putIdempotency('alice', `a-expired-${index}`, { digest: 'old', expiresAt: 100 });
		await store.putIdempotency('alice', 'live', { digest: 'pending', expiresAt: 200 });
		await store.put('status', 'alice', 'note', { sensitive: true, expiresAt: 1 });
		await store.prune(100, 2);
		assert.equal((await store.list('idempotency', 'alice')).length, 2);
		await store.prune(100, 2);
		assert.equal((await store.list('idempotency', 'alice')).length, 1);
		assert.ok(await store.getIdempotency('alice', 'live', 100));
		assert.ok(await store.getGrant(token));
		assert.deepEqual(await store.get('status', 'alice', 'note'), { sensitive: true, expiresAt: 1 });
	} finally { await store.close(); }
});

test('PostgreSQL batch metadata lookup uses complete keys and excludes missing or unrelated values', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const store = await createPostgresStore({ connectionString });
	t.after(() => store.close());
	await store.put('status', 'alice', 'one', { language: 'ja' });
	await store.put('status', 'bob', 'one', { language: 'en' });
	await store.put('media', 'alice', 'one', { focus: { x: 0, y: 1 } });
	const entries = await store.getMany([
		{ namespace: 'status', owner: 'alice', key: 'one' },
		{ namespace: 'media', owner: 'alice', key: 'one' },
		{ namespace: 'status', owner: 'alice', key: 'missing' },
	]);
	assert.equal(entries.length, 2);
	assert.deepEqual(entries.find(entry => entry.namespace === 'status')?.value, { language: 'ja' });
	assert.deepEqual(entries.find(entry => entry.namespace === 'media')?.value, { focus: { x: 0, y: 1 } });
	assert.ok(entries.every(entry => entry.owner === 'alice'));
	assert.deepEqual(await store.getMany([]), []);
});

test('PostgreSQL pruning cannot remove a concurrently renewed idempotency claim', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const first = await createPostgresStore({ connectionString });
	const second = await createPostgresStore({ connectionString });
	const renewed = deferred();
	const finish = deferred();
	try {
		await first.putIdempotency('alice', 'request', { digest: 'expired', expiresAt: 99 });
		const renewal = first.transaction(async () => {
			await first.putIdempotency('alice', 'request', { digest: 'active', expiresAt: 101 });
			renewed.resolve();
			await finish.promise;
		});
		await renewed.promise;
		let pruned = false;
		const cleanup = second.prune(100).then(() => { pruned = true; });
		await setImmediate();
		assert.equal(pruned, false);
		finish.resolve();
		await Promise.all([renewal, cleanup]);
		assert.equal((await second.getIdempotency('alice', 'request', 100))?.digest, 'active');
	} finally { finish.resolve(); await first.close(); await second.close(); }
});

test('an idle PostgreSQL connection failure is recoverable and close is idempotent', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const applicationName = `mastodon_idle_${randomBytes(8).toString('hex')}`;
	const store = await createPostgresStore({ connectionString, application_name: applicationName, max: 1 });
	const admin = new Pool({ connectionString });
	try {
		await store.put('filter', 'alice', 'one', { title: 'retained' });
		const sessions = await admin.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND state = $2', [applicationName, 'idle']);
		assert.equal(sessions.rows.length, 1);
		const pid = sessions.rows[0].pid;
		assert.equal((await admin.query('SELECT pg_terminate_backend($1, 5000) AS terminated', [pid])).rows[0].terminated, true);
		await setImmediate();
		await setImmediate();
		assert.deepEqual(await store.get('filter', 'alice', 'one'), { title: 'retained' });
		const replacement = await admin.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE application_name = $1', [applicationName]);
		assert.equal(replacement.rows.length, 1);
		assert.notEqual(replacement.rows[0].pid, pid);
	} finally { await store.close(); await admin.end(); }
	await store.close();
});

test('two PostgreSQL stores redeem an authorization code and consume pending operations exactly once', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const first = await createPostgresStore({ connectionString });
	const second = await createPostgresStore({ connectionString });
	const inspection = new Pool({ connectionString });
	const makeApp = (store: CompatStore) => {
		const app = Fastify();
		app.all('/oauth/*', (request, reply) => dispatchHandler(request, reply, {
			publicUrl: 'https://social.example',
			nativeUrl: 'http://127.0.0.1:3000',
			store,
			native: {} as never,
		}));
		return app;
	};
	const firstApp = makeApp(first);
	const secondApp = makeApp(second);
	try {
		const { client, clientSecret } = await first.createClient({ name: 'App', scopes: ['read'], redirectUris: ['app://callback'] });
		const code = await first.issueCode({ clientId: client.id, redirectUri: 'app://callback', scopes: ['read'], userId: 'alice', nativeToken: 'native' }, Date.now() + 60000);
		const redeem = (app: ReturnType<typeof Fastify>) => app.inject({
			method: 'POST',
			url: '/oauth/token',
			payload: {
				grant_type: 'authorization_code',
				client_id: client.id,
				client_secret: clientSecret,
				redirect_uri: 'app://callback',
				code,
			},
		});
		const responses = await Promise.all([redeem(firstApp), redeem(secondApp)]);
		const statuses = responses.map(res => res.statusCode).sort((a, b) => a - b);
		assert.deepEqual(statuses, [200, 400]);
		assert.equal(responses.find(res => res.statusCode === 400)?.json().error, 'invalid_grant');
		assert.equal((await inspection.query('SELECT COUNT(*) AS count FROM "mastodon_compat_entry" WHERE "namespace" = $1', ['grants'])).rows[0].count, '1');
		assert.equal(await second.getCode(code), undefined);
		await first.putOperation('oauth_state', 'once', { value: 1 }, Date.now() + 60000);
		const consumed = await Promise.all([first.takeOperation('oauth_state', 'once'), second.takeOperation('oauth_state', 'once')]);
		assert.equal(consumed.filter(value => value !== undefined).length, 1);
	} finally {
		await firstApp.close();
		await secondApp.close();
		await first.close();
		await second.close();
		await inspection.end();
	}
});

test('PostgreSQL rolls back nested state changes, allows unrelated writes, and serializes same-key transactions', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const first = await createPostgresStore({ connectionString });
	const second = await createPostgresStore({ connectionString });
	try {
		await first.put('filter', 'alice', 'one', { value: 'original' });
		const started = deferred();
		const finish = deferred();
		const transaction = first.transaction(async () => {
			await first.put('filter', 'alice', 'one', { value: 'uncommitted' });
			await first.transaction(async () => { await first.put('filter', 'alice', 'nested', true); });
			started.resolve();
			await finish.promise;
			throw new Error('abort transaction');
		});
		await started.promise;
		assert.deepEqual(await second.get('filter', 'alice', 'one'), { value: 'original' });
		await second.put('filter', 'alice', 'outside', true);
		finish.resolve();
		await assert.rejects(transaction, /abort transaction/u);
		assert.deepEqual(await second.get('filter', 'alice', 'one'), { value: 'original' });
		assert.equal(await second.get('filter', 'alice', 'nested'), undefined);
		assert.equal(await first.get('filter', 'alice', 'outside'), true);
		await Promise.all(Array.from({ length: 12 }, (_, index) => {
			const store = index % 2 ? first : second;
			return store.transaction(async () => {
				const value = await store.get<number>('counter', 'alice', 'one') ?? 0;
				await store.put('counter', 'alice', 'one', value + 1);
			});
		}));
		assert.equal(await second.get('counter', 'alice', 'one'), 12);
	} finally { await first.close(); await second.close(); }
});

test('PostgreSQL clients, grants and revocation persist across independent connections and reconnects', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const first = await createPostgresStore({ connectionString });
	const second = await createPostgresStore({ connectionString });
	const { client, clientSecret } = await first.createClient({ name: 'App', scopes: ['read'], redirectUris: ['app://callback'] });
	const { token } = await first.createGrant({ kind: 'user', clientId: client.id, scopes: ['read'], userId: 'alice', nativeToken: 'native-credential' });
	try {
		assert.equal((await second.getGrant(token))?.nativeToken, 'native-credential');
		assert.equal(await second.revokeGrant(token, 'other-client'), false);
		assert.ok(await first.getGrant(token));
		assert.equal(await second.revokeGrant(token, client.id), true);
		assert.equal(await first.getGrant(token), undefined);
	} finally { await first.close(); await second.close(); }
	const restarted = await createPostgresStore({ connectionString });
	try {
		assert.equal((await restarted.verifyClient(client.id, clientSecret))?.id, client.id);
		assert.equal(await restarted.getGrant(token), undefined);
	} finally { await restarted.close(); }
});

test('PostgreSQL stores client secrets, bearer credentials and authorization codes only as hashes', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const store = await createPostgresStore({ connectionString });
	const inspection = new Pool({ connectionString });
	try {
		const { client, clientSecret } = await store.createClient({ name: 'App', scopes: ['read'], redirectUris: ['app://callback'] });
		const { token, grant } = await store.createGrant({ kind: 'user', clientId: client.id, scopes: ['read'], userId: 'alice', nativeToken: 'native-credential' });
		const code = await store.issueCode({ clientId: client.id, redirectUri: 'app://callback', scopes: ['read'], userId: 'alice', nativeToken: 'native-credential' }, Date.now() + 60000);
		const entries = (await inspection.query('SELECT "namespace", "owner", "key", "value" FROM "mastodon_compat_entry"')).rows;
		for (const secret of [clientSecret, token, code]) assert.equal(JSON.stringify(entries).includes(secret), false);
		assert.equal(entries.find(entry => entry.namespace === 'clients')?.value.secretHash, hashCredential(clientSecret));
		assert.equal(entries.find(entry => entry.namespace === 'grants')?.key, hashCredential(token));
		assert.equal(entries.find(entry => entry.namespace === 'codes')?.key, hashCredential(code));
		assert.deepEqual(entries.find(entry => entry.namespace === 'grants')?.value, grant);
	} finally { await store.close(); await inspection.end(); }
});

test('PostgreSQL startup requires the native migration and never recreates a missing table', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const pool = new Pool({ connectionString });
	try {
		const migration = await import(new URL('../../../backend/migration/1789183519130-MastodonCompatEntry.js', import.meta.url).href);
		const queryRunner = { query: (sql: string) => pool.query(sql) };
		await new migration.MastodonCompatEntry1789183519130().down(queryRunner);
		await assert.rejects(createPostgresStore({ connectionString }), /run Misskey migrations/u);
		assert.equal((await pool.query("SELECT to_regclass('mastodon_compat_entry') AS table")).rows[0].table, null);
		await new migration.MastodonCompatEntry1789183519130().up(queryRunner);
		const store = await createPostgresStore({ connectionString });
		await store.close();
	} finally { await pool.end(); }
});

test('two PostgreSQL stores preserve concurrent keyword edits on the same filter', postgresOnly, async t => {
	const connectionString = await postgresFixture(t);
	const first = await createPostgresStore({ connectionString });
	const second = await createPostgresStore({ connectionString });
	const makeApp = (store: CompatStore) => {
		const app = Fastify();
		app.addHook('preValidation', async request => { request.query = parameters(request.query); request.body = parameters(request.body); });
		const native = new NativeClient({ baseUrl: 'http://native.example', publicUrl: 'https://social.example', transport: async () => ({ status: 200, body: '{}' }) });
		registerFeatures(new Routes(app, { store, native, entities: new EntityConverter('https://social.example'), publicUrl: 'https://social.example' }));
		return app;
	};
	const firstApp = makeApp(first);
	const secondApp = makeApp(second);
	try {
		const { client } = await first.createClient({ name: 'Filters', scopes: ['read:filters', 'write:filters'], redirectUris: ['app://callback'] });
		const { token } = await first.createGrant({ clientId: client.id, kind: 'user', userId: 'alice', nativeToken: 'native', scopes: ['read:filters', 'write:filters'] });
		const headers = { authorization: `Bearer ${token}` };
		const created = (await firstApp.inject({ method: 'POST', url: '/api/v2/filters', headers, payload: { title: 'Concurrent', context: ['home'] } })).json();
		const kw1 = (await firstApp.inject({ method: 'POST', url: `/api/v2/filters/${created.id}/keywords`, headers, payload: { keyword: 'alpha' } })).json();
		const kw2 = (await firstApp.inject({ method: 'POST', url: `/api/v2/filters/${created.id}/keywords`, headers, payload: { keyword: 'beta' } })).json();
		const [res1, res2] = await Promise.all([
			firstApp.inject({ method: 'PUT', url: `/api/v2/filters/keywords/${kw1.id}`, headers, payload: { keyword: 'alpha-updated' } }),
			secondApp.inject({ method: 'PUT', url: `/api/v2/filters/keywords/${kw2.id}`, headers, payload: { keyword: 'beta-updated' } }),
		]);
		assert.equal(res1.statusCode, 200, res1.body);
		assert.equal(res2.statusCode, 200, res2.body);
		const finalFilter = (await secondApp.inject({ method: 'GET', url: `/api/v2/filters/${created.id}`, headers })).json();
		assert.deepEqual(finalFilter.keywords.map((item: { keyword: string }) => item.keyword).sort(), ['alpha-updated', 'beta-updated']);
	} finally {
		await firstApp.close();
		await secondApp.close();
		await first.close();
		await second.close();
	}
});
