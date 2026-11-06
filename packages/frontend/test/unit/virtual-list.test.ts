/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { VirtualListLayout } from '@/utility/virtual-list.js';

describe('VirtualListLayout', () => {
	test('returns an empty range and no anchor for an empty list', () => {
		const layout = new VirtualListLayout(100);
		layout.update([]);
		expect(layout.totalHeight).toBe(0);
		expect(layout.range(0, 400, 0)).toEqual({ start: 0, end: 0, top: 0, bottom: 0 });
		expect(layout.anchor(0)).toBeNull();
	});

	test('calculates a bounded range and spacers for hundreds of items', () => {
		const layout = new VirtualListLayout(100);
		layout.update(Array.from({ length: 500 }, (_, i) => `note-${i}`));
		expect(layout.totalHeight).toBe(50000);
		const range = layout.range(10000, 300, 200);
		expect(range.start).toBe(98);
		expect(range.end).toBeGreaterThanOrEqual(105);
		expect(range.end).toBeLessThanOrEqual(106);
		expect(range.top).toBe(layout.offset(range.start));
		expect(range.bottom).toBe(layout.totalHeight - layout.offset(range.end));
	});

	test('combines measured and estimated heights and rejects invalid measurements', () => {
		const layout = new VirtualListLayout(100);
		layout.update(['a', 'b', 'c']);
		expect(layout.measure('a', 50)).toBe(true);
		expect(layout.measure('b', 0)).toBe(true);
		expect(layout.measure('b', 0)).toBe(false);
		for (const invalid of [-1, NaN, Infinity, -Infinity]) expect(layout.measure('c', invalid)).toBe(false);
		expect(layout.measure('missing', 500)).toBe(false);
		expect(layout.totalHeight).toBe(150);
		expect([layout.offset(0), layout.offset(1), layout.offset(2), layout.offset(3)]).toEqual([0, 50, 50, 150]);
		expect(layout.range(50, 100, 0)).toEqual({ start: 2, end: 3, top: 50, bottom: 0 });
	});

	test('preserves the visible anchor through inserts, removals and measurements', () => {
		const layout = new VirtualListLayout(100);
		layout.update(['a', 'b', 'c', 'd']);
		layout.measure('a', 80);
		layout.measure('b', 120);
		const anchor = layout.anchor(225);
		expect(anchor).toEqual({ id: 'c', offset: 25 });
		layout.update(['new', 'a', 'b', 'c', 'd']);
		expect(layout.position(anchor!)).toBe(325);
		layout.measure('new', 40);
		expect(layout.position(anchor!)).toBe(265);
		layout.update(['new', 'b', 'c', 'd']);
		expect(layout.position(anchor!)).toBe(185);
		layout.update(['new', 'b', 'd']);
		expect(layout.position(anchor!)).toBeNull();
	});

	test('drops measurements for removed ids when those ids return', () => {
		const layout = new VirtualListLayout(100);
		layout.update(['a', 'b']);
		layout.measure('a', 20);
		layout.measure('b', 30);
		layout.update(['b']);
		layout.update(['a', 'b']);
		expect(layout.offset(1)).toBe(100);
		expect(layout.totalHeight).toBe(130);
	});
});
