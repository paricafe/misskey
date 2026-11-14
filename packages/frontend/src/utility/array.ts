/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

type EndoRelation<T> = (a: T, b: T) => boolean;
type Predicate<T> = (x: T) => boolean;

export function countIf<T>(f: Predicate<T>, xs: T[]): number {
	return xs.filter(f).length;
}

export function count<T>(a: T, xs: T[]): number {
	return countIf(x => x === a, xs);
}

export function concat<T>(xss: T[][]): T[] {
	return ([] as T[]).concat(...xss);
}

export function intersperse<T>(sep: T, xs: T[]): T[] {
	return concat(xs.map(x => [sep, x])).slice(1);
}

export function erase<T>(a: T, xs: T[]): T[] {
	return xs.filter(x => x !== a);
}

export function difference<T>(xs: T[], ys: T[]): T[] {
	return xs.filter(x => !ys.includes(x));
}

export function unique<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}

export function uniqueBy<TValue, TKey>(values: TValue[], keySelector: (value: TValue) => TKey): TValue[] {
	const map = new Map<TKey, TValue>();

	for (const value of values) {
		const key = keySelector(value);
		if (!map.has(key)) map.set(key, value);
	}

	return [...map.values()];
}

export function sum(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0);
}

export function maximum(xs: number[]): number {
	return Math.max(...xs);
}

export function lessThan(xs: number[], ys: number[]): boolean {
	for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
		if (xs[i] < ys[i]) return true;
		if (xs[i] > ys[i]) return false;
	}
	return xs.length < ys.length;
}

export function takeWhile<T>(f: Predicate<T>, xs: T[]): T[] {
	const ys: T[] = [];
	for (const x of xs) {
		if (f(x)) {
			ys.push(x);
		} else {
			break;
		}
	}
	return ys;
}

export function cumulativeSum(xs: number[]): number[] {
	const ys = Array.from(xs);
	for (let i = 1; i < ys.length; i++) ys[i] += ys[i - 1];
	return ys;
}

export function toArray<T>(x: T | T[] | undefined): T[] {
	return Array.isArray(x) ? x : x != null ? [x] : [];
}

export function toSingle<T>(x: T | T[] | undefined): T | undefined {
	return Array.isArray(x) ? x[0] : x;
}
