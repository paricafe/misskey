/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as crypto from 'node:crypto';

export const L_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const LU_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function secureRndstr(length = 32, { chars = LU_CHARS } = {}): string {
	const chars_len = chars.length;

	let str = '';

	for (let i = 0; i < length; i++) {
	    const rand = crypto.randomInt(0, chars_len);
	    str += chars.charAt(rand);
	}

	return str;
}
