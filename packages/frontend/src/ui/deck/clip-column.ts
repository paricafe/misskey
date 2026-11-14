/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const CLIP_COLUMN_RELOAD_JITTER_MAX_MS = 5000;

export function getClipColumnReloadDelayMs(
	clipUserId: string | null | undefined,
	meId: string | null | undefined,
	random: () => number = Math.random,
): number {
	if (clipUserId != null && meId != null && clipUserId === meId) {
		return 0;
	}

	return random() * CLIP_COLUMN_RELOAD_JITTER_MAX_MS;
}
