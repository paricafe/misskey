/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class MastodonApiCompatibility1783956161436 {
    name = 'MastodonApiCompatibility1783956161436'

    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "mastodon_oauth_client" ("id" character varying(32) NOT NULL, "secretHash" character varying(64) NOT NULL, "name" character varying(256) NOT NULL, "website" character varying(2048), "redirectUris" character varying(2048) array NOT NULL, "scopes" character varying(64) array NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_bce491d867634e1bba7b879a5f7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_mastodon_oauth_client_secret_hash" ON "mastodon_oauth_client" ("secretHash")`);
        await queryRunner.query(`CREATE TABLE "mastodon_oauth_token" ("id" character varying(32) NOT NULL, "tokenHash" character varying(64) NOT NULL, "userId" character varying(32) NOT NULL, "clientId" character varying(32) NOT NULL, "scopes" character varying(64) array NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastUsedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_c8e179db214fa165c644ed657b1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_mastodon_oauth_token_hash" ON "mastodon_oauth_token" ("tokenHash")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_oauth_token_user_id" ON "mastodon_oauth_token" ("userId")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_oauth_token_client_id" ON "mastodon_oauth_token" ("clientId")`);
        await queryRunner.query(`ALTER TABLE "mastodon_oauth_token" ADD CONSTRAINT "FK_mastodon_oauth_token_user_id" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mastodon_oauth_token" ADD CONSTRAINT "FK_mastodon_oauth_token_client_id" FOREIGN KEY ("clientId") REFERENCES "mastodon_oauth_client"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "mastodon_oauth_token" DROP CONSTRAINT "FK_mastodon_oauth_token_client_id"`);
        await queryRunner.query(`ALTER TABLE "mastodon_oauth_token" DROP CONSTRAINT "FK_mastodon_oauth_token_user_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_mastodon_oauth_token_client_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_mastodon_oauth_token_user_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_mastodon_oauth_token_hash"`);
        await queryRunner.query(`DROP TABLE "mastodon_oauth_token"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_mastodon_oauth_client_secret_hash"`);
        await queryRunner.query(`DROP TABLE "mastodon_oauth_client"`);
    }
}
