/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class MastodonCompatEntryPartialExpiresIndex1795492074423 {
	name = 'MastodonCompatEntryPartialExpiresIndex1795492074423';

	async up(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_mastodon_compat_entry_expires_at"`);
		await queryRunner.query(`CREATE INDEX "IDX_mastodon_compat_entry_expires_at" ON "mastodon_compat_entry" ("expiresAt", "namespace", "owner", "key") WHERE "expiresAt" IS NOT NULL`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_mastodon_compat_entry_expires_at"`);
		await queryRunner.query(`CREATE INDEX "IDX_mastodon_compat_entry_expires_at" ON "mastodon_compat_entry" ("expiresAt")`);
	}
}
