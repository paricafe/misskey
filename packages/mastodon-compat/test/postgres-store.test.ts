/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createPostgresStore, hashCredential, type CompatStore } from '../src/store.js';
import { postgresFixture } from './postgres-http-fixture.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(accept => { resolve = accept; });
	return { promise, resolve };
}

const postgresOnly = { skip: !process.env.MASTODON_TEST_DATABASE_URL };

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
		// Drain pending socket events after the server confirms process shutdown.
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
	try {
		const { client } = await first.createClient({ name: 'App', scopes: ['read'], redirectUris: ['app://callback'] });
		const code = await first.issueCode({ clientId: client.id, redirectUri: 'app://callback', scopes: ['read'], userId: 'alice', nativeToken: 'native' }, Date.now() + 60000);
		const redeem = (store: CompatStore) => store.transaction(async () => {
			const authorization = await store.getCode(code);
			if (!authorization) return undefined;
			const grant = await store.createGrant({ kind: 'user', clientId: client.id, scopes: authorization.scopes, userId: authorization.userId, nativeToken: authorization.nativeToken });
			assert.equal(await store.deleteCode(code), true);
			return grant;
		});
		const grants = await Promise.all([redeem(first), redeem(second)]);
		assert.equal(grants.filter(Boolean).length, 1);
		assert.equal((await inspection.query('SELECT COUNT(*) AS count FROM "mastodon_compat_entry" WHERE "namespace" = $1', ['grants'])).rows[0].count, '1');
		assert.equal(await second.getCode(code), undefined);
		await first.putOperation('oauth_state', 'once', { value: 1 }, Date.now() + 60000);
		const consumed = await Promise.all([first.takeOperation('oauth_state', 'once'), second.takeOperation('oauth_state', 'once')]);
		assert.equal(consumed.filter(value => value !== undefined).length, 1);
	} finally { await first.close(); await second.close(); await inspection.end(); }
});

test('PostgreSQL rolls back nested state changes and serializes standalone writes behind transactions', postgresOnly, async t => {
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
		let writeFinished = false;
		const write = second.put('filter', 'alice', 'outside', true).then(() => { writeFinished = true; });
		await setImmediate();
		assert.equal(writeFinished, false);
		finish.resolve();
		await assert.rejects(transaction, /abort transaction/u);
		await write;
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
