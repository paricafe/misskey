/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const unicodeEmojiCategories = ['face', 'people', 'animals_and_nature', 'food_and_drink', 'activity', 'travel_and_places', 'objects', 'symbols', 'flags'] as const;

export type UnicodeEmojiDef = {
	name: string;
	char: string;
	category: typeof unicodeEmojiCategories[number];
};

import _emojilist from '@misskey-dev/emoji-data/emojilist.json';

export const emojilist: UnicodeEmojiDef[] = _emojilist.map(x => ({
	name: x[1] as string,
	char: x[0] as string,
	category: unicodeEmojiCategories[x[2] as number],
}));

const unicodeEmojisMap = new Map<string, UnicodeEmojiDef>(
	emojilist.map(x => [x.char, x]),
);

const _indexByChar = new Map<string, number>();
const _charGroupByCategory = new Map<string, string[]>();
for (let i = 0; i < emojilist.length; i++) {
	const emo = emojilist[i];
	_indexByChar.set(emo.char, i);

	if (_charGroupByCategory.has(emo.category)) {
		_charGroupByCategory.get(emo.category)?.push(emo.char);
	} else {
		_charGroupByCategory.set(emo.category, [emo.char]);
	}
}

export const emojiCharByCategory = _charGroupByCategory;

export function getUnicodeEmojiOrNull(char: string): UnicodeEmojiDef | null {
	return unicodeEmojisMap.get(forceColorizeEmoji(char))
		?? unicodeEmojisMap.get(char)
		?? null;
}

export function getUnicodeEmoji(char: string): UnicodeEmojiDef | string {
	return getUnicodeEmojiOrNull(char) ?? char;
}

export function isSupportedEmoji(char: string): boolean {
	return unicodeEmojisMap.has(forceColorizeEmoji(char)) || unicodeEmojisMap.has(char);
}

export function getEmojiName(char: string): string {
	const idx = _indexByChar.get(forceColorizeEmoji(char)) ?? _indexByChar.get(char);
	if (idx === undefined) {
		return char;
	} else {
		return emojilist[idx].name;
	}
}

export function colorizeEmoji(char: string) {
	return Array.from(char).length === 1 ? `${char}\uFE0F` : char;
}

function forceColorizeEmoji(char: string) {
	const chars = Array.from(char);
	if (chars.includes('\uFE0F')) {
		return char;
	} else {
		chars.splice(1, 0, '\uFE0F');
		return chars.join('');
	}
}

export interface CustomEmojiFolderTree {
	value: string;
	category: string;
	children: CustomEmojiFolderTree[];
}
