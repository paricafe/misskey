/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const colonsRegex = /:/g;
const localHostMarkRegex = /@\./;

export function getEmojiNameFromReaction(reaction: string): string {
	return reaction.replace(colonsRegex, '').replace(localHostMarkRegex, '');
}

export function normalizeCustomEmojiName(name: string): string {
	return (name[0] === ':' ? name.substring(1, name.length - 1) : name).replace('@.', '');
}

export function isLocalCustomEmojiName(name: string, host: string | null | undefined): boolean {
	return !host && (name.endsWith('@.') || !name.includes('@'));
}

export function isLocalCustomEmojiReaction(reaction: string): boolean {
	return reaction[0] === ':' && reaction.includes('@.');
}

export function getCustomEmojiImagePath(name: string, host: string | null | undefined): string {
	return host ? `/emoji/${name}@${host}.webp` : `/emoji/${name}.webp`;
}
