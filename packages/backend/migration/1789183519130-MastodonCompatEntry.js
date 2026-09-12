/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class MastodonCompatEntry1789183519130 {
    name = 'MastodonCompatEntry1789183519130'

    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "mastodon_compat_entry" ("namespace" character varying(96) NOT NULL, "owner" text NOT NULL, "key" text NOT NULL, "value" jsonb NOT NULL, "expiresAt" bigint, CONSTRAINT "PK_mastodon_compat_entry" PRIMARY KEY ("namespace", "owner", "key"))`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_compat_entry_expires_at" ON "mastodon_compat_entry" ("expiresAt")`);

        // The fresh gateway does not retain credentials or state from the old implementation.
        await queryRunner.query(`DROP TABLE "mastodon_user_state"`);
        await queryRunner.query(`DROP TABLE "mastodon_oauth_token"`);
        await queryRunner.query(`DROP TABLE "mastodon_oauth_client"`);
    }

    async down(queryRunner) {
        // Restore the final legacy schema, including application tokens with no user.
        // Dropped legacy data and new gateway data cannot be recovered by this rollback.
        await queryRunner.query(`CREATE TABLE "mastodon_oauth_client" ("id" character varying(32) NOT NULL, "secretHash" character varying(64) NOT NULL, "name" character varying(256) NOT NULL, "website" character varying(2048), "redirectUris" character varying(2048) array NOT NULL, "scopes" character varying(64) array NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_bce491d867634e1bba7b879a5f7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_mastodon_oauth_client_secret_hash" ON "mastodon_oauth_client" ("secretHash")`);
        await queryRunner.query(`CREATE TABLE "mastodon_oauth_token" ("id" character varying(32) NOT NULL, "tokenHash" character varying(64) NOT NULL, "userId" character varying(32), "clientId" character varying(32) NOT NULL, "scopes" character varying(64) array NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "lastUsedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_c8e179db214fa165c644ed657b1" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_mastodon_oauth_token_hash" ON "mastodon_oauth_token" ("tokenHash")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_oauth_token_user_id" ON "mastodon_oauth_token" ("userId")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_oauth_token_client_id" ON "mastodon_oauth_token" ("clientId")`);
        await queryRunner.query(`ALTER TABLE "mastodon_oauth_token" ADD CONSTRAINT "FK_mastodon_oauth_token_user_id" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mastodon_oauth_token" ADD CONSTRAINT "FK_mastodon_oauth_token_client_id" FOREIGN KEY ("clientId") REFERENCES "mastodon_oauth_client"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE TABLE "mastodon_user_state" ("id" character varying(32) NOT NULL, "userId" character varying(32) NOT NULL, "tokenId" character varying(32), "kind" character varying(64) NOT NULL, "key" character varying(512) NOT NULL, "value" jsonb NOT NULL, "version" integer NOT NULL DEFAULT 1, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_fd1d4840de4e20a32d26e249658" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_mastodon_user_state_user_kind_key" ON "mastodon_user_state" ("userId", "kind", "key")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_user_state_user_kind_updated_at" ON "mastodon_user_state" ("userId", "kind", "updatedAt")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_user_state_token_id" ON "mastodon_user_state" ("tokenId")`);
        await queryRunner.query(`CREATE INDEX "IDX_mastodon_user_state_expires_at" ON "mastodon_user_state" ("expiresAt")`);
        await queryRunner.query(`ALTER TABLE "mastodon_user_state" ADD CONSTRAINT "FK_mastodon_user_state_user_id" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "mastodon_user_state" ADD CONSTRAINT "FK_mastodon_user_state_token_id" FOREIGN KEY ("tokenId") REFERENCES "mastodon_oauth_token"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`DROP INDEX "IDX_mastodon_compat_entry_expires_at"`);
        await queryRunner.query(`DROP TABLE "mastodon_compat_entry"`);
    }
}
