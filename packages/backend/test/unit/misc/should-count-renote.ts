/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { shouldCountRenote } from '@/misc/should-count-renote.js';

describe('shouldCountRenote', () => {
	test.each([
		[{ userId: 'author' }, { id: 'renoter', isBot: false }, true],
		[{ userId: 'author' }, { id: 'author', isBot: false }, false],
		[{ userId: 'author' }, { id: 'renoter', isBot: true }, false],
	] as const)('target=%o renoter=%o returns %s', (target, renoter, expected) => {
		expect(shouldCountRenote(target, renoter)).toBe(expected);
	});
});
