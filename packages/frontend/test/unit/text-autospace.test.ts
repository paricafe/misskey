/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, assert, describe, test } from 'vitest';
import { applyTextAutospacePreference } from '@/utility/text-autospace.js';

const globalStyles = readFileSync(resolve(process.cwd(), 'src/style.scss'), 'utf8');

describe('applyTextAutospacePreference', () => {
	afterEach(() => {
		document.documentElement.style.removeProperty('--MI-textAutospace');
	});

	test.each([
		[true, 'normal'],
		[false, 'no-autospace'],
	] as const)('maps %s to %s', (enabled, expected) => {
		applyTextAutospacePreference(enabled);

		assert.strictEqual(document.documentElement.style.getPropertyValue('--MI-textAutospace'), expected);
	});

	test('keeps automatic spacing disabled outside explicitly scoped content', () => {
		assert.match(globalStyles, /html\s*\{[^}]*text-autospace:\s*no-autospace;/s);
	});
});
