export class PGroongaUserDescription1652213556290 {
    name = 'PGroongaUserDescription1652213556290'

    async up(queryRunner) {
        await queryRunner.query(`CREATE INDEX "IDX_fcb770976ff8240af5799e3ffc" ON "user_profile" USING "pgroonga" ("description" pgroonga_varchar_full_text_search_ops_v2) `);
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX "public"."IDX_fcb770976ff8240af5799e3ffc"`);
    }
}
