/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';

/** Apply the compatibility migration history in an isolated schema, never a production table. */
export async function postgresFixture(t: TestContext, options: { legacyOnly?: boolean } = {}): Promise<string> {
	const configured = process.env.MASTODON_TEST_DATABASE_URL;
	if (!configured) throw new Error('Set MASTODON_TEST_DATABASE_URL to an isolated test PostgreSQL database');
	const admin = new Pool({ connectionString: configured, max: 1, statement_timeout: 5000 });
	const schema = `mastodon_http_${randomBytes(8).toString('hex')}`;
	let created = false;
	let closed = false;
	const cleanup = async () => {
		if (closed) return;
		closed = true;
		try {
			if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
		} finally { await admin.end(); }
	};
	t.after(cleanup);
	const url = new URL(configured);
	url.searchParams.set('options', `${url.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim());
	const scoped = new Pool({ connectionString: url.href, max: 1 });
	try {
		await admin.query(`CREATE SCHEMA "${schema}"`);
		created = true;
		const client = await scoped.connect();
		try {
			await client.query('BEGIN');
			await client.query('CREATE TABLE "user" ("id" character varying(32) NOT NULL PRIMARY KEY)');
			const migrations = [
				['1783956161436-mastodon-api-compatibility.js', 'MastodonApiCompatibility1783956161436'],
				['1784113507739-mastodon-oauth-application-tokens.js', 'MastodonOAuthApplicationTokens1784113507739'],
				['1784221450402-mastodon-user-state.js', 'MastodonUserState1784221450402'],
			];
			if (!options.legacyOnly) migrations.push(['1789183519130-MastodonCompatEntry.js', 'MastodonCompatEntry1789183519130']);
			for (const [file, name] of migrations) {
				const migration = await import(new URL(`../../../backend/migration/${file}`, import.meta.url).href);
				await new migration[name]().up({ query: (sql: string) => client.query(sql) });
			}
			await client.query('COMMIT');
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally { client.release(); }
	} catch (error) {
		await cleanup();
		throw error;
	} finally { await scoped.end(); }
	return url.href;
}
