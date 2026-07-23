/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const defaultFontsList = [
	'roboto',
	'misskey-biz',
	'arial',
	'times',
	'system-ui',
];

export async function loadFontStyle(fontId: string) {
	if (defaultFontsList.includes(fontId)) return;
	try {
		await import(`@/styles-font/${fontId}.scss`);
	} catch (err) {
		console.warn(`Failed to load font style: ${fontId}`, err);
	}
}
