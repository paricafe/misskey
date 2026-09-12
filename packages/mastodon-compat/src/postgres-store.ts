/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { CompatStore, type StoreAdapter, type StoreEntry, type StoreKey } from './store.js';

// Stable across every gateway process sharing this database. All mutations use
// this transaction lock, including standalone writes and one-time consumption.
const lockKeys = [0x4d434f4d, 0x53544f52];
const columns = '"namespace", "owner", "key", "value", "expiresAt"';
interface TransactionContext { client: PoolClient; active: boolean; }
type Row = Omit<StoreEntry, 'expiresAt'> & { expiresAt: string | null };
const entry = (row: Row): StoreEntry => ({ ...row, expiresAt: row.expiresAt === null ? null : Number(row.expiresAt) });

class PostgresAdapter implements StoreAdapter {
	private readonly context = new AsyncLocalStorage<TransactionContext>();
	private closing?: Promise<void>;

	constructor(private readonly pool: Pool) {}

	async close(): Promise<void> { await (this.closing ??= this.pool.end()); }

	private async query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
		const current = this.context.getStore();
		if (current && !current.active) throw new Error('The compatibility transaction has ended');
		return (current?.client ?? this.pool).query<T>(text, values);
	}

	async transaction<T>(callback: () => T | Promise<T>): Promise<T> {
		const current = this.context.getStore();
		if (current) {
			if (!current.active) throw new Error('The compatibility transaction has ended');
			return callback();
		}
		const client = await this.pool.connect();
		const context: TransactionContext = { client, active: true };
		try {
			await client.query('BEGIN');
			await client.query('SELECT pg_advisory_xact_lock($1, $2)', lockKeys);
			const result = await this.context.run(context, callback);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			context.active = false;
			client.release();
		}
	}

	async get(namespace: string, owner: string, key: string): Promise<StoreEntry | undefined> {
		const result = await this.query<Row>(`SELECT ${columns} FROM "mastodon_compat_entry" WHERE "namespace" = $1 AND "owner" = $2 AND "key" = $3`, [namespace, owner, key]);
		return result.rows[0] ? entry(result.rows[0]) : undefined;
	}

	async getMany(keys: StoreKey[]): Promise<StoreEntry[]> {
		if (keys.length === 0) return [];
		const result = await this.query<Row>(`SELECT e.* FROM "mastodon_compat_entry" e
			JOIN unnest($1::text[], $2::text[], $3::text[]) AS requested(namespace, owner, key)
			ON e."namespace" = requested.namespace AND e."owner" = requested.owner AND e."key" = requested.key`,
		[keys.map(key => key.namespace), keys.map(key => key.owner), keys.map(key => key.key)]);
		return result.rows.map(entry);
	}

	async put(value: StoreEntry, insertOnly = false): Promise<void> {
		await this.transaction(async () => {
			const json = JSON.stringify(value.value);
			if (json === undefined) throw new TypeError('Compatibility values must be JSON serializable');
			await this.query(`INSERT INTO "mastodon_compat_entry" (${columns}) VALUES ($1, $2, $3, $4::jsonb, $5)${insertOnly ? '' : ' ON CONFLICT ("namespace", "owner", "key") DO UPDATE SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt"'}`, [value.namespace, value.owner, value.key, json, value.expiresAt]);
		});
	}

	async delete(namespace: string, owner: string, key: string): Promise<boolean> {
		return this.transaction(async () => (await this.query('DELETE FROM "mastodon_compat_entry" WHERE "namespace" = $1 AND "owner" = $2 AND "key" = $3', [namespace, owner, key])).rowCount === 1);
	}

	async take(namespace: string, owner: string, key: string): Promise<StoreEntry | undefined> {
		return this.transaction(async () => {
			const result = await this.query<Row>(`DELETE FROM "mastodon_compat_entry" WHERE "namespace" = $1 AND "owner" = $2 AND "key" = $3 RETURNING ${columns}`, [namespace, owner, key]);
			return result.rows[0] ? entry(result.rows[0]) : undefined;
		});
	}

	async list(namespace: string, owner: string): Promise<StoreEntry[]> {
		return (await this.query<Row>(`SELECT ${columns} FROM "mastodon_compat_entry" WHERE "namespace" = $1 AND "owner" = $2 ORDER BY "key" COLLATE "C"`, [namespace, owner])).rows.map(entry);
	}

	async prune(now: number): Promise<void> {
		await this.transaction(async () => { await this.query(`DELETE FROM "mastodon_compat_entry" WHERE "namespace" IN ('codes', 'operations') AND "expiresAt" <= $1`, [now]); });
	}
}

/** The native migration owns this table; startup must never create its schema. */
export async function createPostgresStore(config: PoolConfig): Promise<CompatStore> {
	const pool = new Pool(config);
	// pg removes failed idle clients before emitting this event. Active query
	// failures still reject their callers; future requests can open a new client.
	pool.on('error', () => {});
	try {
		await pool.query(`SELECT ${columns} FROM "mastodon_compat_entry" LIMIT 0`);
		return new CompatStore(new PostgresAdapter(pool));
	} catch (error) {
		await pool.end();
		throw new Error('Cannot open PostgreSQL compatibility storage; check the database connection and run Misskey migrations', { cause: error });
	}
}
