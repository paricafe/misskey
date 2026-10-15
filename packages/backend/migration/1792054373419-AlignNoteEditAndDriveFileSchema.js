/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// The migration that created note.history (EditNote1706162844037) was removed from the
// chain after existing instances had run it, so new installations lack the column.
// Add it only where it is missing; existing instances keep their edit history.
export class AlignNoteEditAndDriveFileSchema1792054373419 {
	name = 'AlignNoteEditAndDriveFileSchema1792054373419';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note" ADD COLUMN IF NOT EXISTS "history" jsonb`);
		await queryRunner.query(`COMMENT ON COLUMN "note"."updatedAt" IS 'The update time of the Note.'`);
		// varchar to text does not rewrite the table.
		await queryRunner.query(`ALTER TABLE "drive_file" ALTER COLUMN "comment" TYPE text`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "drive_file" ALTER COLUMN "comment" TYPE varchar(100000)`);
		await queryRunner.query(`COMMENT ON COLUMN "note"."updatedAt" IS NULL`);
		// note.history is intentionally kept: on existing instances it predates this
		// migration, and dropping it would delete their edit history.
	}
}
