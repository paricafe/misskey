/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const targetExtsToSkip = new Set([
	'.gz',
	'.tar',
	'.tgz',
	'.bz2',
	'.xz',
	'.zip',
	'.7z',
]);

const extRegExp = /\.[0-9a-zA-Z]+$/i;

export function correctFilename(filename: string, ext: string | null) {
	const dotExt = ext ? ext[0] === '.' ? ext : `.${ext}` : '';

	const match = extRegExp.exec(filename);
	if (!match || !match[0]) {
		return `${filename}${dotExt}`;
	}

	const filenameExt = match[0].toLowerCase();
	if (
		ext === null ||
		filenameExt === dotExt ||

		dotExt === '.jpg' && filenameExt === '.jpeg' ||
		dotExt === '.tif' && filenameExt === '.tiff' ||
		dotExt === '.exe' && filenameExt === '.dll' ||

		targetExtsToSkip.has(dotExt)
	) {
		return filename;
	}

	return `${filename}${dotExt}`;
}
