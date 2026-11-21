/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class FollowActivityIdText1795196226271 {
	name = 'FollowActivityIdText1795196226271';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "following" ALTER COLUMN "requestId" TYPE text');
		await queryRunner.query('ALTER TABLE "follow_request" ALTER COLUMN "requestId" TYPE text');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "follow_request" ALTER COLUMN "requestId" TYPE varchar(128)');
		await queryRunner.query('ALTER TABLE "following" ALTER COLUMN "requestId" TYPE varchar(512)');
	}
}
