/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { postgresFixture } from './postgres-http-fixture.js';

const postgresOnly = { skip: !process.env.MASTODON_TEST_DATABASE_URL };
const legacyTables = ['mastodon_oauth_client', 'mastodon_oauth_token', 'mastodon_user_state'];

async function migrate(pool: Pool, direction: 'up' | 'down'): Promise<void> {
	const migration = await import(new URL('../../../backend/migration/1789183519130-MastodonCompatEntry.js', import.meta.url).href);
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		await new migration.MastodonCompatEntry1789183519130()[direction]({ query: (sql: string) => client.query(sql) });
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK');
		throw error;
	} finally { client.release(); }
}

async function tables(pool: Pool): Promise<string[]> {
	const result = await pool.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename');
	return result.rows.map(row => row.tablename);
}

/** Catalog definitions exclude object IDs and normalize the generated schema name. */
async function schemaSnapshot(pool: Pool, names: string[]) {
	const columns = await pool.query(`
		SELECT c.relname AS table_name, a.attname AS column_name,
			format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
			pg_get_expr(d.adbin, d.adrelid) AS default_value
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
		WHERE n.nspname = current_schema() AND c.relname = ANY($1)
		ORDER BY c.relname, a.attnum`, [names]);
	const indexes = await pool.query(`
		SELECT tablename AS table_name, indexname AS index_name,
			replace(indexdef, quote_ident(current_schema()) || '.', '<schema>.') AS definition
		FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ANY($1)
		ORDER BY tablename, indexname`, [names]);
	// NOT NULL is already covered by columns; newer PostgreSQL also records it as a constraint.
	const constraints = await pool.query(`
		SELECT c.relname AS table_name, k.conname AS constraint_name, k.contype AS type,
			k.condeferrable AS deferrable, k.condeferred AS deferred, k.convalidated AS validated,
			replace(pg_get_constraintdef(k.oid), quote_ident(current_schema()) || '.', '<schema>.') AS definition
		FROM pg_constraint k
		JOIN pg_class c ON c.oid = k.conrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema() AND c.relname = ANY($1) AND k.contype <> 'n'
		ORDER BY c.relname, k.conname`, [names]);
	return { columns: columns.rows, indexes: indexes.rows, constraints: constraints.rows };
}

async function seedLegacy(pool: Pool): Promise<void> {
	await pool.query('INSERT INTO "user" ("id") VALUES ($1)', ['alice']);
	await pool.query('CREATE TABLE "native_sentinel" ("id" integer PRIMARY KEY, "value" text NOT NULL)');
	await pool.query('INSERT INTO "native_sentinel" VALUES (1, $1)', ['preserved']);
	await pool.query(`INSERT INTO "mastodon_oauth_client"
		("id", "secretHash", "name", "redirectUris", "scopes", "createdAt")
		VALUES ('legacy-client', 'legacy-secret-hash', 'Legacy app', ARRAY['app://callback'], ARRAY['read'], '2026-01-01Z')`);
	await pool.query(`INSERT INTO "mastodon_oauth_token"
		("id", "tokenHash", "userId", "clientId", "scopes", "createdAt") VALUES
		('user-token', 'user-token-hash', 'alice', 'legacy-client', ARRAY['read'], '2026-01-01Z'),
		('application-token', 'application-token-hash', NULL, 'legacy-client', ARRAY['read'], '2026-01-01Z')`);
	await pool.query(`INSERT INTO "mastodon_user_state"
		("id", "userId", "tokenId", "kind", "key", "value", "createdAt", "updatedAt")
		VALUES ('legacy-state', 'alice', 'user-token', 'filter', 'one', '{"title":"legacy"}', '2026-01-01Z', '2026-01-01Z')`);
}

async function legacyData(pool: Pool) {
	return {
		clients: (await pool.query('SELECT * FROM "mastodon_oauth_client" ORDER BY "id"')).rows,
		tokens: (await pool.query('SELECT * FROM "mastodon_oauth_token" ORDER BY "id"')).rows,
		state: (await pool.query('SELECT * FROM "mastodon_user_state" ORDER BY "id"')).rows,
	};
}

async function assertNativeData(pool: Pool): Promise<void> {
	assert.deepEqual((await pool.query('SELECT * FROM "user"')).rows, [{ id: 'alice' }]);
	assert.deepEqual((await pool.query('SELECT * FROM "native_sentinel"')).rows, [{ id: 1, value: 'preserved' }]);
}

async function assertCompatSchema(pool: Pool): Promise<void> {
	const snapshot = await schemaSnapshot(pool, ['mastodon_compat_entry']);
	assert.deepEqual(snapshot.columns, [
		{ table_name: 'mastodon_compat_entry', column_name: 'namespace', type: 'character varying(96)', not_null: true, default_value: null },
		{ table_name: 'mastodon_compat_entry', column_name: 'owner', type: 'text', not_null: true, default_value: null },
		{ table_name: 'mastodon_compat_entry', column_name: 'key', type: 'text', not_null: true, default_value: null },
		{ table_name: 'mastodon_compat_entry', column_name: 'value', type: 'jsonb', not_null: true, default_value: null },
		{ table_name: 'mastodon_compat_entry', column_name: 'expiresAt', type: 'bigint', not_null: false, default_value: null },
	]);
	assert.deepEqual(snapshot.indexes, [
		{ table_name: 'mastodon_compat_entry', index_name: 'IDX_mastodon_compat_entry_expires_at', definition: 'CREATE INDEX "IDX_mastodon_compat_entry_expires_at" ON <schema>.mastodon_compat_entry USING btree ("expiresAt")' },
		{ table_name: 'mastodon_compat_entry', index_name: 'PK_mastodon_compat_entry', definition: 'CREATE UNIQUE INDEX "PK_mastodon_compat_entry" ON <schema>.mastodon_compat_entry USING btree (namespace, owner, key)' },
	]);
	assert.deepEqual(snapshot.constraints, [{
		table_name: 'mastodon_compat_entry', constraint_name: 'PK_mastodon_compat_entry', type: 'p',
		deferrable: false, deferred: false, validated: true, definition: 'PRIMARY KEY (namespace, owner, key)',
	}]);
}

test('a fresh compatibility migration history leaves only the current compatibility table', postgresOnly, async t => {
	const pool = new Pool({ connectionString: await postgresFixture(t) });
	try {
		assert.deepEqual(await tables(pool), ['mastodon_compat_entry', 'user']);
		await assertCompatSchema(pool);
	} finally { await pool.end(); }
});

test('PostgreSQL upgrade removes legacy data and rollback restores the exact final legacy schema', postgresOnly, async t => {
	const pool = new Pool({ connectionString: await postgresFixture(t, { legacyOnly: true }) });
	try {
		await seedLegacy(pool);
		const baseline = await schemaSnapshot(pool, legacyTables);
		assert.equal((await legacyData(pool)).tokens.find(token => token.id === 'application-token')?.userId, null);
		await migrate(pool, 'up');
		assert.deepEqual(await tables(pool), ['mastodon_compat_entry', 'native_sentinel', 'user']);
		await assertCompatSchema(pool);
		await assertNativeData(pool);
		assert.equal((await pool.query('SELECT count(*) AS count FROM "mastodon_compat_entry"')).rows[0].count, '0');
		await pool.query(`INSERT INTO "mastodon_compat_entry" ("namespace", "owner", "key", "value") VALUES ('filters', 'alice', 'new', '{}')`);
		await migrate(pool, 'down');
		assert.deepEqual(await tables(pool), [...legacyTables, 'native_sentinel', 'user']);
		assert.deepEqual(await schemaSnapshot(pool, legacyTables), baseline);
		assert.deepEqual(await legacyData(pool), { clients: [], tokens: [], state: [] });
		await assertNativeData(pool);
		await migrate(pool, 'up');
		assert.deepEqual(await tables(pool), ['mastodon_compat_entry', 'native_sentinel', 'user']);
		await assertCompatSchema(pool);
		assert.equal((await pool.query('SELECT count(*) AS count FROM "mastodon_compat_entry"')).rows[0].count, '0');
		await assertNativeData(pool);
	} finally { await pool.end(); }
});

test('an external legacy-table dependency aborts PostgreSQL upgrade and rolls back all schema and data changes', postgresOnly, async t => {
	const pool = new Pool({ connectionString: await postgresFixture(t, { legacyOnly: true }) });
	try {
		await seedLegacy(pool);
		await pool.query('CREATE VIEW "external_legacy_client" AS SELECT "id", "name" FROM "mastodon_oauth_client"');
		const baseline = await schemaSnapshot(pool, legacyTables);
		const data = await legacyData(pool);
		// This dependency fails at the final legacy DROP, after both earlier tables were dropped.
		await assert.rejects(migrate(pool, 'up'), { code: '2BP01' });
		assert.deepEqual(await tables(pool), [...legacyTables, 'native_sentinel', 'user']);
		assert.deepEqual(await schemaSnapshot(pool, legacyTables), baseline);
		assert.deepEqual(await legacyData(pool), data);
		assert.deepEqual((await pool.query('SELECT * FROM "external_legacy_client"')).rows, [{ id: 'legacy-client', name: 'Legacy app' }]);
		assert.equal((await pool.query("SELECT to_regclass('mastodon_compat_entry') AS table")).rows[0].table, null);
		await assertNativeData(pool);
		await pool.query('DROP VIEW "external_legacy_client"');
		await migrate(pool, 'up');
		assert.deepEqual(await tables(pool), ['mastodon_compat_entry', 'native_sentinel', 'user']);
	} finally { await pool.end(); }
});
