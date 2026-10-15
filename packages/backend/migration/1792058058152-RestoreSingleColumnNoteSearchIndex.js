/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const isConcurrentIndexMigrationEnabled = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';

// Copy the PGroonga options (tokenizer, normalizers, mappings) of an existing index.
async function indexOptions(queryRunner, name) {
	const [{ options }] = await queryRunner.query(`
		SELECT string_agg(format('%I = %L', option_name, option_value), ', ' ORDER BY option_name = 'plugins' DESC, option_name) AS options
		FROM pg_class index_class
		CROSS JOIN LATERAL pg_options_to_table(index_class.reloptions)
		WHERE index_class.oid = to_regclass($1)
	`, [`"${name}"`]);
	return options ? `WITH (${options})` : '';
}

async function isValidIndex(queryRunner, name) {
	const rows = await queryRunner.query('SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [`"${name}"`]);
	return rows[0]?.indisvalid === true;
}

// The (search text, id) PGroonga index from NoteSearchTextIdIndex1792049504336 made
// every note insert and update several seconds slower on a large instance. Return to
// the single-column search index; search keeps ID windows via primary key ranges.
export class RestoreSingleColumnNoteSearchIndex1792058058152 {
	name = 'RestoreSingleColumnNoteSearchIndex1792058058152';
	transaction = isConcurrentIndexMigrationEnabled ? false : undefined;

	async up(queryRunner) {
		const extensions = await queryRunner.query(`SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'`);
		if (extensions.length === 0) return;

		const concurrently = isConcurrentIndexMigrationEnabled ? 'CONCURRENTLY' : '';
		const options = await indexOptions(queryRunner, 'IDX_note_search_text_id');
		// Drop the slow index first so note writes recover before the rebuild finishes.
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_note_search_text_id"`);
		if (!await isValidIndex(queryRunner, 'IDX_note_search_text')) {
			// An interrupted concurrent build leaves an invalid index that must be rebuilt.
			await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_note_search_text"`);
			await queryRunner.query(`
				CREATE INDEX ${concurrently} "IDX_note_search_text" ON "note"
				USING pgroonga (note_search_text("text", "replyId"))
				${options}
			`);
		}
	}

	async down(queryRunner) {
		const extensions = await queryRunner.query(`SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'`);
		if (extensions.length === 0) return;

		const concurrently = isConcurrentIndexMigrationEnabled ? 'CONCURRENTLY' : '';
		if (!await isValidIndex(queryRunner, 'IDX_note_search_text_id')) {
			await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_note_search_text_id"`);
			await queryRunner.query(`
				CREATE INDEX ${concurrently} "IDX_note_search_text_id" ON "note"
				USING pgroonga (note_search_text("text", "replyId"), "id" pgroonga_varchar_term_search_ops_v2)
				${await indexOptions(queryRunner, 'IDX_note_search_text')}
			`);
		}
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_note_search_text"`);
	}
}
