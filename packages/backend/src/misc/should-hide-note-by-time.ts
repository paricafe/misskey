/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function shouldHideNoteByTime(hiddenBefore: number | null | undefined, createdAt: string | Date): boolean {
	if (hiddenBefore == null) {
		return false;
	}

	const createdAtTime = typeof createdAt === 'string' ? new Date(createdAt).getTime() : createdAt.getTime();

	if (hiddenBefore <= 0) {
		const elapsedSeconds = (Date.now() - createdAtTime) / 1000;
		const hideAfterSeconds = Math.abs(hiddenBefore);
		return elapsedSeconds >= hideAfterSeconds;
	} else {
		const createdAtSeconds = createdAtTime / 1000;
		return createdAtSeconds <= hiddenBefore;
	}
}
