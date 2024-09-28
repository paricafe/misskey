export class PGroongaUserName1652213168020 {
    name = 'PGroongaUserName1652213168020'

    async up(queryRunner) {
        await queryRunner.query(`CREATE INDEX "IDX_065d4d8f3b5adb4a08841eae3c" ON "user" USING "pgroonga" ("name" pgroonga_varchar_full_text_search_ops_v2)`);
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX "public"."IDX_065d4d8f3b5adb4a08841eae3c"`);
    }
}
