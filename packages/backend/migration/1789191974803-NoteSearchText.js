/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const isConcurrentIndexMigrationEnabled = process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY === '1';

export class NoteSearchText1789191974803 {
	name = 'NoteSearchText1789191974803';
	transaction = isConcurrentIndexMigrationEnabled ? false : undefined;

	async up(queryRunner) {
		// Only standalone leading mention tokens in replies are addressing metadata.
		// Keep mentions in ordinary notes, body text, and punctuation-adjacent text.
		await queryRunner.query(`
			CREATE OR REPLACE FUNCTION note_search_text(source text, reply_id text)
			RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
			AS $$
				SELECT CASE WHEN reply_id IS NULL THEN source ELSE regexp_replace(
					source,
					'^[[:space:]]*(@[A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_])?(@[A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_])?(:[0-9]+)?)?([[:space:]]+|$))+',
					''
				) END
			$$
		`);

		const extensions = await queryRunner.query(`SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'`);
		if (extensions.length === 0) return;

		const existingIndex = await queryRunner.query(`
			SELECT indisvalid FROM pg_index
			WHERE indexrelid = to_regclass('"IDX_note_search_text"')
		`);
		if (existingIndex[0]?.indisvalid === true) return;

		const concurrently = isConcurrentIndexMigrationEnabled ? 'CONCURRENTLY' : '';
		// An interrupted concurrent build leaves an invalid index that must be rebuilt.
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_note_search_text"`);

		// Preserve the site's existing tokenization, normalization, and index options.
		// Mapping options refer to index target names; this target is now an expression.
		const [indexOptions] = await queryRunner.query(`
			SELECT string_agg(format('%I = %L', option_name,
				CASE WHEN option_name IN ('normalizers_mapping', 'index_flags_mapping') THEN
					(SELECT COALESCE(jsonb_object_agg(
						CASE WHEN key = 'text' THEN 'note_search_text' ELSE key END, value
					), '{}'::jsonb) FROM jsonb_each(option_value::jsonb))::text
				ELSE option_value END
			), ', ' ORDER BY option_name = 'plugins' DESC, option_name) AS options
			FROM pg_class index_class
			INNER JOIN pg_am access_method ON access_method.oid = index_class.relam
			CROSS JOIN LATERAL pg_options_to_table(index_class.reloptions)
			WHERE index_class.oid = to_regclass('"IDX_f27f5d88941e57442be75ba9c8"')
				AND access_method.amname = 'pgroonga'
		`);
		const withOptions = indexOptions.options ? `WITH (${indexOptions.options})` : '';
		await queryRunner.query(`
			CREATE INDEX ${concurrently} "IDX_note_search_text" ON "note"
			USING pgroonga (note_search_text("text", "replyId")) ${withOptions}
		`);
	}

	async down(queryRunner) {
		const concurrently = isConcurrentIndexMigrationEnabled ? 'CONCURRENTLY' : '';
		await queryRunner.query(`DROP INDEX ${concurrently} IF EXISTS "IDX_note_search_text"`);
		await queryRunner.query(`DROP FUNCTION note_search_text(text, text)`);
	}
}
