/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { CompatStore, type ClaimResult, type StoreAdapter, type StoreEntry, type StoreKey } from './store.js';

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
		let destroy = false;
		try {
			await client.query('BEGIN');
			const result = await this.context.run(context, callback);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			try {
				await client.query('ROLLBACK');
			} catch {
				destroy = true;
			}
			throw error;
		} finally {
			context.active = false;
			client.release(destroy);
		}
	}

	private async lockKey(namespace: string, owner: string, key: string): Promise<void> {
		if (!this.context.getStore()) return;
		await this.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([namespace, owner, key])]);
	}

	async get(namespace: string, owner: string, key: string): Promise<StoreEntry | undefined> {
		await this.lockKey(namespace, owner, key);
		const result = await this.query<Row>(`SELECT ${columns} FROM "mastodon_compat_entry" WHERE "namespace" = $1 AND "owner" = $2 AND "key" = $3`, [namespace, owner, key]);
		return result.rows[0] ? entry(result.rows[0]) : undefined;
	}

	async getMany(keys: StoreKey[]): Promise<StoreEntry[]> {
		if (keys.length === 0) return [];
		if (this.context.getStore()) {
			const sorted = [...new Map(keys.map(k => [JSON.stringify([k.namespace, k.owner, k.key]), k])).entries()]
				.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
			for (const [, k] of sorted) await this.lockKey(k.namespace, k.owner, k.key);
		}
		const result = await this.query<Row>(`SELECT e.* FROM "mastodon_compat_entry" e
			JOIN unnest($1::text[], $2::text[], $3::text[]) AS requested(namespace, owner, key)
			ON e."namespace" = requested.namespace AND e."owner" = requested.owner AND e."key" = requested.key`,
		[keys.map(key => key.namespace), keys.map(key => key.owner), keys.map(key => key.key)]);
		return result.rows.map(entry);
	}

	async put(value: StoreEntry, insertOnly = false): Promise<void> {
		const json = JSON.stringify(value.value);
		if (json === undefined) throw new TypeError('Compatibility values must be JSON serializable');
		await this.lockKey(value.namespace, value.owner, value.key);
		await this.query(`INSERT INTO "mastodon_compat_entry" (${columns}) VALUES ($1, $2, $3, $4::jsonb, $5)${insertOnly ? '' : ' ON CONFLICT ("namespace", "owner", "key") DO UPDATE SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt"'}`, [value.namespace, value.owner, value.key, json, value.expiresAt]);
	}

	async claim(value: StoreEntry, now: number): Promise<ClaimResult<StoreEntry>> {
		const json = JSON.stringify(value.value);
		if (json === undefined) throw new TypeError('Compatibility values must be JSON serializable');
		await this.lockKey(value.namespace, value.owner, value.key);
		for (let attempt = 0; attempt < 3; attempt++) {
			const claimed = await this.query<Row>(
				`INSERT INTO "mastodon_compat_entry" (${columns}) VALUES ($1, $2, $3, $4::jsonb, $5)
				ON CONFLICT ("namespace", "owner", "key") DO UPDATE
					SET "value" = EXCLUDED."value", "expiresAt" = EXCLUDED."expiresAt"
					WHERE "mastodon_compat_entry"."expiresAt" IS NOT NULL AND "mastodon_compat_entry"."expiresAt" <= $6
				RETURNING ${columns}`,
				[value.namespace, value.owner, value.key, json, value.expiresAt, now],
			);
			if (claimed.rows.length > 0) return { status: 'claimed' };
			const existing = await this.get(value.namespace, value.owner, value.key);
			if (existing) return { status: 'existing', entry: existing };
		}
		return { status: 'retry' };
	}

	async delete(namespace: string, owner: string, key: string): Promise<boolean> {
		await this.lockKey(namespace, owner, key);
		return (await this.query('DELETE FROM "mastodon_compat_entry" WHERE "namespace" = $1 AND "owner" = $2 AND "key" = $3', [namespace, owner, key])).rowCount === 1;
	}

	async take(namespace: string, owner: string, key: string): Promise<StoreEntry | undefined> {
		await this.lockKey(namespace, owner, key);
		const result = await this.query<Row>(`DELETE FROM "mastodon_compat_entry" WHERE "namespace" = $1 AND "owner" = $2 AND "key" = $3 RETURNING ${columns}`, [namespace, owner, key]);
		return result.rows[0] ? entry(result.rows[0]) : undefined;
	}

	async list(namespace: string, owner: string): Promise<StoreEntry[]> {
		return (await this.query<Row>(`SELECT ${columns} FROM "mastodon_compat_entry" WHERE "namespace" = $1 AND "owner" = $2 ORDER BY "key" COLLATE "C"`, [namespace, owner])).rows.map(entry);
	}

	async prune(now: number, limit: number): Promise<void> {
		await this.query(`DELETE FROM "mastodon_compat_entry" e USING (
			SELECT "namespace", "owner", "key" FROM "mastodon_compat_entry"
			WHERE "namespace" IN ('codes', 'operations', 'kv:idempotency') AND "expiresAt" <= $1
			ORDER BY "expiresAt", "namespace", "owner", "key" LIMIT $2
			FOR UPDATE SKIP LOCKED
		) expired WHERE e."namespace" = expired."namespace" AND e."owner" = expired."owner" AND e."key" = expired."key"`, [now, limit]);
	}
}

export async function createPostgresStore(config: PoolConfig): Promise<CompatStore> {
	const pool = new Pool(config);
	pool.on('error', error => { console.error('Mastodon compatibility PostgreSQL pool error:', error); });
	try {
		await pool.query(`SELECT ${columns} FROM "mastodon_compat_entry" LIMIT 0`);
		return new CompatStore(new PostgresAdapter(pool));
	} catch (error) {
		await pool.end();
		throw new Error('Cannot open PostgreSQL compatibility storage; check the database connection and run Misskey migrations', { cause: error });
	}
}
