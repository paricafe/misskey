/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const MAX_NOTE_TEXT_LENGTH = 3000;
export const MAX_NOTE_FILES = 16;

export const USER_ONLINE_THRESHOLD = 1000 * 60 * 10;
export const USER_ACTIVE_THRESHOLD = 1000 * 60 * 60 * 24 * 3;

export const PER_NOTE_REACTION_USER_PAIR_CACHE_MAX = 16;

export const DB_MAX_NOTE_TEXT_LENGTH = 8192;

export const DB_MAX_IMAGE_COMMENT_LENGTH = 512;

export const FILE_TYPE_IMAGE = [
	'image/png',
	'image/gif',
	'image/jpeg',
	'image/webp',
	'image/avif',
	'image/apng',
	'image/bmp',
	'image/tiff',
	'image/x-icon',
];

export const FILE_TYPE_BROWSERSAFE = [
	'image/png',
	'image/gif',
	'image/jpeg',
	'image/webp',
	'image/avif',
	'image/apng',
	'image/bmp',
	'image/tiff',
	'image/x-icon',

	'audio/opus',
	'video/ogg',
	'audio/ogg',
	'application/ogg',

	'video/quicktime',
	'video/mp4',
	'audio/mp4',
	'video/x-m4v',
	'audio/x-m4a',
	'video/3gpp',
	'video/3gpp2',

	'video/mpeg',
	'audio/mpeg',

	'video/webm',
	'audio/webm',

	'audio/aac',

	'audio/flac',
	'audio/wav',
	'audio/x-flac',
	'audio/vnd.wave',
];
