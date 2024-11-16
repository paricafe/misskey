export class AfterIncreaseCharacterLimits1727998351591 {
	name = 'AfterIncreaseCharacterLimits1727998351591'

	async up(queryRunner) {
		await queryRunner.query(`DROP INDEX "IDX_7cc8d9b0ee7861b4e5dc86ad85"`);
		await queryRunner.query(
			`CREATE INDEX IF NOT EXISTS "IDX_7cc8d9b0ee7861b4e5dc86ad85" ON "note" USING "pgroonga" ("cw")`,
		);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "IDX_7cc8d9b0ee7861b4e5dc86ad85"`);
		await queryRunner.query(
			`CREATE INDEX IF NOT EXISTS "IDX_7cc8d9b0ee7861b4e5dc86ad85" ON "note" USING "pgroonga" ("cw" pgroonga_varchar_full_text_search_ops_v2)`,
		);
	}
}
