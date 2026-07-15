/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class MastodonOAuthApplicationTokens1784113507739 {
    name = 'MastodonOAuthApplicationTokens1784113507739'

    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" DROP NOT NULL');
    }

    async down(queryRunner) {
        await queryRunner.query('DELETE FROM "mastodon_oauth_token" WHERE "userId" IS NULL');
        await queryRunner.query('ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" SET NOT NULL');
    }
}
