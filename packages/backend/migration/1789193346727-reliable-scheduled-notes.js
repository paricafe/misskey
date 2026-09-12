/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ReliableScheduledNotes1789193346727 {
    name = 'ReliableScheduledNotes1789193346727';

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "note_draft" ADD "scheduleRevision" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`CREATE INDEX "IDX_NOTE_DRAFT_SCHEDULED" ON "note_draft" ("scheduledAt", "id") WHERE "isActuallyScheduled" = true`);
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX "IDX_NOTE_DRAFT_SCHEDULED"`);
        await queryRunner.query(`ALTER TABLE "note_draft" DROP COLUMN "scheduleRevision"`);
    }
}
