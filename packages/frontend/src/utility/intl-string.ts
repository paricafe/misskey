/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { versatileLang } from '@@/js/intl-const.js';
import type { toHiragana as toHiraganaType } from 'wanakana';

let toHiragana: typeof toHiraganaType = (str?: string) => str ?? '';
let isWanakanaLoaded = false;

export async function initIntlString(forceWanakana = false) {
	if ((!versatileLang.includes('ja') && !forceWanakana) || isWanakanaLoaded) return;
	const { toHiragana: _toHiragana } = await import('wanakana');
	toHiragana = _toHiragana;
	isWanakanaLoaded = true;
}

const graphemeSegmenter = new Intl.Segmenter(versatileLang, { granularity: 'grapheme' });

export function normalizeString(str: string) {
	let normalized = '';
	for (const { segment } of graphemeSegmenter.segment(str)) {
		normalized += segment.normalize('NFKC');
	}
	return normalized.toLowerCase().trim();
}

const hyphens = [
	0x002d,
	0x02d7,
	0x1173,
	0x1680,
	0x1b78,
	0x2010,
	0x2011,
	0x2012,
	0x2013,
	0x2014,
	0x2015,
	0x2043,
	0x207b,
	0x2212,
	0x25ac,
	0x2500,
	0x2501,
	0x2796,
	0x30fc,
	0x3161,
	0xfe58,
	0xfe63,
	0xff0d,
	0xff70,
	0x10110,
	0x10191,
];

const hyphensCodePoints = hyphens.map(code => `\\u{${code.toString(16).padStart(4, '0')}}`);
const hyphensRegex = new RegExp(`[${hyphensCodePoints.join('')}]`, 'ug');

export function normalizeHyphens(str: string) {
	return str.replace(hyphensRegex, '\u002d');
}

export function normalizeStringWithHiragana(str: string) {
	return normalizeHyphens(toHiragana(normalizeString(str), { convertLongVowelMark: false }));
}

export function compareStringEquals(a: string, b: string) {
	if (a === b) return true;
	if (normalizeString(a) === normalizeString(b)) return true;
	if (normalizeStringWithHiragana(a) === normalizeStringWithHiragana(b)) return true;
	return false;
}

export function compareStringIncludes(base: string, query: string) {
	if (base === query) return true;
	if (base.includes(query)) return true;
	if (normalizeString(base).includes(normalizeString(query))) return true;
	if (normalizeStringWithHiragana(base).includes(normalizeStringWithHiragana(query))) return true;
	return false;
}
