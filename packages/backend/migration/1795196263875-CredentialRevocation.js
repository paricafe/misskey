/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class CredentialRevocation1795196263875 {
	name = 'CredentialRevocation1795196263875'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "credential_revocation" ("id" BIGSERIAL NOT NULL, "userId" varchar(32) NOT NULL, "event" varchar(32) NOT NULL, "credentialId" varchar(64) NOT NULL, CONSTRAINT "PK_credential_revocation" PRIMARY KEY ("id"))`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DO $$
			BEGIN
				LOCK TABLE "credential_revocation" IN ACCESS EXCLUSIVE MODE;
				IF EXISTS (SELECT FROM "credential_revocation") THEN
					RAISE EXCEPTION 'Deliver pending credential revocations before reverting this migration';
				END IF;
				DROP TABLE "credential_revocation";
			END $$`);
	}
}
