/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Json } from './types.js';

export class HttpError extends Error {
	constructor(readonly statusCode: number, message: string) { super(message); }
}

/** Decode Rails-style bracket parameters without prototype or inherited-property writes. */
export function parameters(input: unknown): Json {
	if (input == null) return {};
	if (typeof input !== 'object' || Array.isArray(input)) throw new HttpError(422, 'Expected an object');
	const result: Json = Object.create(null);
	for (const [key, value] of Object.entries(input)) {
		const parts = key.match(/[^\[\]]+/gu) ?? [];
		if (!parts.length || parts.length > 5 || parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new HttpError(422, 'Invalid parameter');
		let target = result;
		for (const part of parts.slice(0, -1)) {
			if (target[part] === undefined) target[part] = Object.create(null);
			if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) throw new HttpError(422, 'Conflicting parameter');
			target = target[part];
		}
		const name = parts.at(-1)!;
		if (target[name] !== undefined) throw new HttpError(422, 'Conflicting parameter');
		target[name] = key.endsWith('[]') ? array(value) : value;
	}
	return result;
}

export function formParameters(value: string): Json {
	const input: Json = Object.create(null);
	for (const [key, item] of new URLSearchParams(value)) {
		if (input[key] === undefined) input[key] = item;
		else input[key] = [...array(input[key]), item];
	}
	return parameters(input);
}

export function array(value: unknown): any[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }
export function strings(value: unknown): string[] { return array(value).map(item => string(item)); }
export function string(value: unknown, fallback = ''): string {
	if (value == null) return fallback;
	if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(422, 'Expected a string');
	return String(value);
}
export function boolean(value: unknown, fallback = false): boolean {
	if (value == null) return fallback;
	if ([true, 'true', '1', 1].includes(value as any)) return true;
	if ([false, 'false', '0', 0, ''].includes(value as any)) return false;
	throw new HttpError(422, 'Expected a boolean');
}
export function integer(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (value == null) return fallback;
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < min || number > max) throw new HttpError(422, 'Invalid integer');
	return number;
}

export function pagination(query: Json, limit = 20, maximum = 80): Json {
	const body: Json = { limit: integer(query.limit, limit, 1, maximum) };
	if (query.min_id) {
		const lower = string(query.min_id);
		body.sinceId = query.since_id && compareIds(string(query.since_id), lower) > 0 ? string(query.since_id) : lower;
	} else if (query.max_id) {
		body.untilId = string(query.max_id);
	}
	// Native sinceId selects the *oldest* newer page (ASC). Mastodon since_id
	// selects the latest page instead, so apply that lower bound after a DESC read.
	return body;
}

export function compareIds(a: string, b: string): number {
	return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Apply Mastodon bounds to native source IDs before converting them to another entity. */
export function pageRows(rows: Json[], query: Json, cursor = (item: Json): string => string(item.id), limit = 20, maximum = 80): Json[] {
	const size = integer(query.limit, limit, 1, maximum);
	const after = query.since_id ? string(query.since_id) : undefined;
	const newer = query.min_id ? string(query.min_id) : undefined;
	const before = query.max_id ? string(query.max_id) : undefined;
	const selected = rows.filter(item => {
		const id = cursor(item);
		return (!after || compareIds(id, after) > 0) && (!newer || compareIds(id, newer) > 0) && (!before || compareIds(id, before) < 0);
	}).sort((a, b) => compareIds(cursor(a), cursor(b)));
	return (newer ? selected.slice(0, size) : selected.slice(-size)).reverse();
}
