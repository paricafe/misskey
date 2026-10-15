/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const isConcurrentIndexMigrationEnabled = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';

// Note search uses IDX_note_search_text_id. These PGroonga indexes on note.text and
// note.cw are no longer used by any query but still cost every note insert and edit.
export class DropUnusedNotePgroongaIndexes1792052524739 {
	name = 'DropUnusedNotePgroongaIndexes1792052524739';
	transaction = isConcurrentIndexMigrationEnabled ? false : undefined;

	async up(queryRunner) {
		const concurrently = isConcurrentIndexMigrationEnabled ? 'CONCURRENTLY' : '';
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_f27f5d88941e57442be75ba9c8"`);
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_7cc8d9b0ee7861b4e5dc86ad85"`);
	}

	async down(queryRunner) {
		const extensions = await queryRunner.query(`SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'`);
		if (extensions.length === 0) return;

		const concurrently = isConcurrentIndexMigrationEnabled ? 'CONCURRENTLY' : '';
		await queryRunner.query(`CREATE INDEX ${concurrently} IF NOT EXISTS "IDX_f27f5d88941e57442be75ba9c8" ON "note" USING pgroonga ("text")`);
		await queryRunner.query(`CREATE INDEX ${concurrently} IF NOT EXISTS "IDX_7cc8d9b0ee7861b4e5dc86ad85" ON "note" USING pgroonga ("cw")`);
	}
}
