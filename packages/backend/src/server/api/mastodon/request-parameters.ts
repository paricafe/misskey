/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { FastifyRequest } from 'fastify';
import { MastodonApiError } from './errors.js';

export type MastodonParameters = Record<string, unknown>;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 8;

function invalidParameters(): never {
	throw new MastodonApiError(400, 'invalid_request', 'The request parameters are invalid');
}

function dictionary(value: unknown): value is MastodonParameters {
	return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value: unknown, depth: number): unknown {
	if (depth > MAX_DEPTH) invalidParameters();
	if (Array.isArray(value)) return value.map(item => cloneValue(item, depth + 1));
	if (!dictionary(value)) return value;
	const result: MastodonParameters = {};
	for (const [key, item] of Object.entries(value)) {
		if (FORBIDDEN_KEYS.has(key)) invalidParameters();
		result[key] = cloneValue(item, depth + 1);
	}
	return result;
}

function assignNested(target: MastodonParameters, path: string[], value: unknown): void {
	const [key, ...remaining] = path;
	if (remaining.length === 0) {
		if (Object.hasOwn(target, key) && JSON.stringify(target[key]) !== JSON.stringify(value)) invalidParameters();
		target[key] = value;
		return;
	}
	if (remaining[0] === '') {
		const values = Array.isArray(value) ? value : [value];
		if (remaining.length === 1) {
			if (dictionary(target[key])) invalidParameters();
			const existing = target[key] == null ? [] : Array.isArray(target[key]) ? target[key] : [target[key]];
			const merged = [...existing];
			const unmatched = existing.map(item => JSON.stringify(item));
			for (const item of values) {
				const index = unmatched.indexOf(JSON.stringify(item));
				if (index < 0) merged.push(item);
				else unmatched.splice(index, 1);
			}
			target[key] = merged;
			return;
		}
		if (target[key] != null && !Array.isArray(target[key])) invalidParameters();
		const array = (target[key] ??= []) as unknown[];
		for (const [index, item] of values.entries()) {
			if (array[index] != null && !dictionary(array[index])) invalidParameters();
			const entry = (array[index] ??= {}) as MastodonParameters;
			assignNested(entry, remaining.slice(1), item);
		}
		return;
	}
	if (target[key] != null && !dictionary(target[key])) invalidParameters();
	const nested = (target[key] ??= {}) as MastodonParameters;
	assignNested(nested, remaining, value);
}

/** Canonical nested parameters, retaining bracket aliases for existing adapters. */
export function normalizeMastodonParameters(input: unknown): MastodonParameters {
	if (input == null) return {};
	if (!dictionary(input)) invalidParameters();
	const result: MastodonParameters = {};
	for (const [key, value] of Object.entries(input)) {
		if (key.includes('[')) continue;
		if (FORBIDDEN_KEYS.has(key)) invalidParameters();
		result[key] = cloneValue(value, 1);
	}
	for (const [key, value] of Object.entries(input)) {
		if (!key.includes('[')) continue;
		if (!/^[^\[\]]+(?:\[[^\[\]]*\])+$/u.test(key)) invalidParameters();
		const path = [key.slice(0, key.indexOf('[')), ...[...key.matchAll(/\[([^\[\]]*)\]/gu)].map(match => match[1])];
		if (path.length > MAX_DEPTH || path.some(part => FORBIDDEN_KEYS.has(part))) invalidParameters();
		if (path.some((part, index) => part === '' && path[index + 1] === '')) invalidParameters();
		const cloned = cloneValue(value, path.length);
		assignNested(result, path, cloned);
		result[key] = cloned;
	}
	return result;
}

export function parseMastodonForm(body: string): MastodonParameters {
	const parameters: MastodonParameters = Object.create(null) as MastodonParameters;
	for (const [key, value] of new URLSearchParams(body)) {
		const current = parameters[key];
		parameters[key] = current == null ? value : Array.isArray(current) ? [...current, value] : [current, value];
	}
	return normalizeMastodonParameters(parameters);
}

/** Only for text endpoints. Media/profile upload handlers must retain their streams. */
export async function readMastodonRequestBody(request: FastifyRequest): Promise<MastodonParameters> {
	if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
		return normalizeMastodonParameters(request.body);
	}
	const parameters: MastodonParameters = Object.create(null) as MastodonParameters;
	for await (const part of request.parts()) {
		if (part.type === 'file') {
			part.file.resume();
			throw new MastodonApiError(422, 'unprocessable_entity', 'This endpoint only accepts text form fields');
		}
		if (part.fieldnameTruncated || part.valueTruncated) invalidParameters();
		const current = parameters[part.fieldname];
		parameters[part.fieldname] = current == null ? part.value : Array.isArray(current) ? [...current, part.value] : [current, part.value];
	}
	return normalizeMastodonParameters(parameters);
}
