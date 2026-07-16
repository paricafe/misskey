/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class MastodonUserState1784221450402 {
    name = 'MastodonUserState1784221450402'

    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "mastodon_user_state" ("id" character varying(32) NOT NULL, "userId" character varying(32) NOT NULL, "tokenId" character varying(32), "kind" character varying(64) NOT NULL, "key" character varying(512) NOT NULL, "value" jsonb NOT NULL, "version" integer NOT NULL DEFAULT 1, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_fd1d4840de4e20a32d26e249658" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_mastodon_user_state_user_kind_key" ON "mastodon_user_state" ("userId", "kind", "key")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_user_state_user_kind_updated_at" ON "mastodon_user_state" ("userId", "kind", "updatedAt")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_user_state_token_id" ON "mastodon_user_state" ("tokenId")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_user_state_expires_at" ON "mastodon_user_state" ("expiresAt")`);
        await queryRunner.query(`ALTER TABLE "mastodon_user_state" ADD CONSTRAINT "FK_mastodon_user_state_user_id" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mastodon_user_state" ADD CONSTRAINT "FK_mastodon_user_state_token_id" FOREIGN KEY ("tokenId") REFERENCES "mastodon_oauth_token"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP TABLE "mastodon_user_state"`);
    }
}
