/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const MAX_NORMALIZE_LENGTH = 128 * 2;

export function normalizeTag(tag: string): string {
	if (tag.length > MAX_NORMALIZE_LENGTH) {
		return tag.toLowerCase();
	}

	return tag.normalize('NFKC').toLowerCase();
}
