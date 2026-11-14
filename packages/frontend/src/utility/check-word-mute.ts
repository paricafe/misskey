/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as Misskey from 'misskey-js';

export type WordMuteResult = Array<string | string[]> | false;

const regexCache = new Map<string, RegExp | null>();
const keywordsCache = new WeakMap<string[], string[]>();

function getCompiledRegex(filter: string): RegExp | null {
	let regex = regexCache.get(filter);
	if (regex === undefined) {
		const parts = filter.match(/^\/(.+)\/(.*)$/);
		if (parts == null) {
			regex = null;
		} else {
			try {
				regex = new RegExp(parts[1], parts[2]);
			} catch (_) {
				regex = null;
			}
		}
		regexCache.set(filter, regex);
	}
	return regex;
}

function getCleanedKeywords(filter: string[]): string[] {
	let keywords = keywordsCache.get(filter);
	if (keywords === undefined) {
		keywords = filter.filter(keyword => keyword !== '');
		keywordsCache.set(filter, keywords);
	}
	return keywords;
}

export function checkWordMute(note: Misskey.entities.Note, me: Misskey.entities.UserLite | null | undefined, mutedWords: Array<string | string[]>): WordMuteResult {
	if (me && (note.userId === me.id)) return false;

	if (mutedWords.length === 0) return false;

	const text = ((note.cw ?? '') + '\n' + (note.text ?? '')).trim();

	if (text !== '') {
		const matched = mutedWords.filter(filter => {
			if (Array.isArray(filter)) {
				const keywords = getCleanedKeywords(filter);
				if (keywords.length === 0) return false;

				return keywords.every(keyword => text.includes(keyword));
			} else {
				const regex = getCompiledRegex(filter);
				if (regex == null) return false;

				regex.lastIndex = 0;
				return regex.test(text);
			}
		});

		if (matched.length > 0) return matched;
	}

	return false;
}
