/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ReactionsBufferCheckpoint1789188448879 {
    name = 'ReactionsBufferCheckpoint1789188448879';

    async up(queryRunner) {
        await queryRunner.query('ALTER TABLE "note" ADD "lastReactionsBufferId" uuid');
    }

    async down(queryRunner) {
        await queryRunner.query('ALTER TABLE "note" DROP COLUMN "lastReactionsBufferId"');
    }
}
