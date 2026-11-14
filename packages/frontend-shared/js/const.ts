/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
	'image/svg+xml',

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

export const MFM_TAGS = ['tada', 'jelly', 'twitch', 'shake', 'spin', 'jump', 'bounce', 'flip', 'x2', 'x3', 'x4', 'scale', 'position', 'fg', 'bg', 'border', 'font', 'blur', 'rainbow', 'sparkle', 'rotate', 'ruby', 'unixtime'];
export const MFM_PARAMS: Record<typeof MFM_TAGS[number], string[]> = {
	tada: ['speed=', 'delay='],
	jelly: ['speed=', 'delay='],
	twitch: ['speed=', 'delay='],
	shake: ['speed=', 'delay='],
	spin: ['speed=', 'delay=', 'left', 'alternate', 'x', 'y'],
	jump: ['speed=', 'delay='],
	bounce: ['speed=', 'delay='],
	flip: ['h', 'v'],
	x2: [],
	x3: [],
	x4: [],
	scale: ['x=', 'y='],
	position: ['x=', 'y='],
	fg: ['color='],
	bg: ['color='],
	border: ['width=', 'style=', 'color=', 'radius=', 'noclip'],
	font: ['serif', 'monospace', 'cursive', 'fantasy', 'emoji', 'math'],
	blur: [],
	rainbow: ['speed=', 'delay='],
	rotate: ['deg='],
	ruby: [],
	unixtime: [],
};

export const DEFAULT_EMOJIS = ['👍', '❤️', '😆', '🤔', '😮', '🎉', '💢', '😥', '😇', '🍮'];
