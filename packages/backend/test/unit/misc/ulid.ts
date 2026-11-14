/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { parseUlidFull } from '@/misc/id/ulid.js';

describe('misc:ulid', () => {
	test('parseUlidFull - timestamp is parsed correctly', () => {
		const { date } = parseUlidFull('01KPS7S3000000000000000000');
		expect(date).toBe(1776816000000);
	});

	test('parseUlidFull - W/X/Y/Z at id[10] (chunk 1 head) do not throw', () => {
		expect(() => parseUlidFull('01KPS7S300W000000000000000')).not.toThrow();
		expect(() => parseUlidFull('01KPS7S300X000000000000000')).not.toThrow();
		expect(() => parseUlidFull('01KPS7S300Y000000000000000')).not.toThrow();
		expect(() => parseUlidFull('01KPS7S300Z000000000000000')).not.toThrow();
	});

	test('parseUlidFull - W/X/Y/Z at id[16] (chunk 2 head) do not throw', () => {
		expect(() => parseUlidFull('01KPS7S300ABCDEFW000000000')).not.toThrow();
		expect(() => parseUlidFull('01KPS7S300ABCDEFX000000000')).not.toThrow();
		expect(() => parseUlidFull('01KPS7S300ABCDEFY000000000')).not.toThrow();
		expect(() => parseUlidFull('01KPS7S300ABCDEFZ000000000')).not.toThrow();
	});

	test('parseUlidFull - additional exceeds uint64 max (all-Z randomness)', () => {
		const { additional } = parseUlidFull('01ARZ3NDEKZZZZZZZZZZZZZZZZ');
		const uint64Max = 2n ** 64n - 1n;
		expect(additional > uint64Max).toBe(true);
		expect(BigInt.asUintN(64, additional) <= uint64Max).toBe(true);
	});
});
