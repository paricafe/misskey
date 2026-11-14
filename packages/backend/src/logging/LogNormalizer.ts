/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Buffer } from 'node:buffer';
import type { LogAttributeValue, LogAttributes, SerializedError } from './types.js';

export type LogNormalizationProfile = 'standard' | 'detailed';

export type LogNormalizationLimits = {
	readonly maxDepth: number;
	readonly maxEntries: number;
	readonly maxStringBytes: number;
	readonly maxBytes: number;
};

export type LogRedactor = (path: readonly string[], key: string) => boolean;

export type LogNormalizationOptions = {
	readonly profile?: LogNormalizationProfile;
	readonly limits?: Partial<LogNormalizationLimits>;
	readonly redactor?: LogRedactor;
};

export const STANDARD_LOG_NORMALIZATION_LIMITS: LogNormalizationLimits = {
	maxDepth: 6,
	maxEntries: 100,
	maxStringBytes: 8 * 1024,
	maxBytes: 64 * 1024,
};

export const DETAILED_LOG_NORMALIZATION_LIMITS: LogNormalizationLimits = {
	maxDepth: 10,
	maxEntries: 1000,
	maxStringBytes: 64 * 1024,
	maxBytes: 256 * 1024,
};

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const TRUNCATED = '[Truncated]';
const UNSUPPORTED = '[Unsupported]';
const TRUNCATED_KEY = '[Truncated]';

const sensitiveKeyParts = [
	'password',
	'passwd',
	'passphrase',
	'token',
	'secret',
	'authorization',
	'cookie',
	'apikey',
	'privatekey',
	'credential',
	'captcha',
	'hcaptcharesponse',
	'grecaptcharesponse',
	'turnstileresponse',
	'mcaptcharesponse',
	'testcaptcharesponse',
];

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[-_.\s]/g, '');
}

export function defaultLogRedactor(_path: readonly string[], key: string): boolean {
	const normalized = normalizeKey(key);
	return normalized === 'i' || sensitiveKeyParts.some(part => normalized.includes(part));
}

export function resolveLogNormalizationLimits(options: LogNormalizationOptions = {}): LogNormalizationLimits {
	const base = options.profile === 'detailed'
		? DETAILED_LOG_NORMALIZATION_LIMITS
		: STANDARD_LOG_NORMALIZATION_LIMITS;
	const limits = {
		...base,
		...options.limits,
	};
	return {
		maxDepth: Math.max(0, limits.maxDepth),
		maxEntries: Math.max(0, limits.maxEntries),
		maxStringBytes: Math.max(1, limits.maxStringBytes),
		maxBytes: Math.max(2, limits.maxBytes),
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function createAttributeMap(): Record<string, LogAttributeValue> {
	return Object.create(null) as Record<string, LogAttributeValue>;
}

function stringifySafely(value: unknown): string {
	try {
		return String(value);
	} catch {
		return UNSUPPORTED;
	}
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, 'utf8');
}

function normalizeString(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	const suffix = `…${TRUNCATED}`;
	if (byteLength(suffix) > maxBytes) {
		const end = findMaxPrefixLength(value, '', maxBytes);
		return value.slice(0, end);
	}
	const end = findMaxPrefixLength(value, suffix, maxBytes);
	return value.slice(0, end) + suffix;
}

function charUtf8Len(codePoint: number): number {
	return codePoint < 0x80 ? 1
		: codePoint < 0x800 ? 2
		: codePoint < 0x10000 ? 3
		: 4;
}

function charUtf16Len(codePoint: number): number {
	return codePoint < 0x10000 ? 1 : 2;
}

function findMaxPrefixLength(value: string, suffix: string, maxBytes: number) {
	let usedBytes = byteLength(suffix);
	let prefixLength = 0;
	while (prefixLength < value.length) {
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- similar to for-of, but for-of requires additional allocations
		const cp = value.codePointAt(prefixLength)!;
		const charBytes = charUtf8Len(cp);
		if (usedBytes + charBytes > maxBytes) break;
		usedBytes += charBytes;
		prefixLength += charUtf16Len(cp);
	}
	return prefixLength;
}

function isErrorValue(value: unknown): value is Error {
	try {
		return value instanceof Error;
	} catch {
		return false;
	}
}

function readProperty(value: Record<string, unknown>, key: string): unknown {
	try {
		return value[key];
	} catch {
		return `${UNSUPPORTED}: property access failed`;
	}
}

function normalizeValue(
	value: unknown,
	path: readonly string[],
	depth: number,
	seen: WeakSet<object>,
	limits: LogNormalizationLimits,
	redactor: LogRedactor,
): LogAttributeValue {
	if (value === null) return null;
	if (typeof value === 'string') return normalizeString(value, limits.maxStringBytes);
	if (typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : stringifySafely(value);
	if (typeof value === 'bigint') return value.toString(10);
	if (typeof value === 'undefined') return `${UNSUPPORTED}: undefined`;
	if (typeof value === 'function' || typeof value === 'symbol') return `${UNSUPPORTED}: ${typeof value}`;
	let isArray = false;
	try {
		if (value instanceof Date) {
			return normalizeString(value.toISOString(), limits.maxStringBytes);
		}
		isArray = Array.isArray(value);
		if (!isArray) {
			const prototype = Object.getPrototypeOf(value);
			if (prototype !== Object.prototype && prototype !== null) return `${UNSUPPORTED}: object`;
		}
	} catch {
		return `${UNSUPPORTED}: object access failed`;
	}
	if (seen.has(value)) return CIRCULAR;
	if (depth >= limits.maxDepth) return TRUNCATED;
	seen.add(value);

	try {
		if (isArray) {
			const arrayValue = value as readonly unknown[];
			const result: LogAttributeValue[] = [];
			const entries = Math.min(arrayValue.length, limits.maxEntries);
			for (let i = 0; i < entries; i++) {
				result.push(normalizeValue(arrayValue[i], [...path, String(i)], depth + 1, seen, limits, redactor));
			}
			if (arrayValue.length > entries) result.push(TRUNCATED);
			return result;
		}

		const result = createAttributeMap();
		const keys = Object.keys(value).sort();
		const entries = Math.min(keys.length, limits.maxEntries);
		for (let i = 0; i < entries; i++) {
			const key = keys[i];
			result[key] = redactor(path, key)
				? REDACTED
				: normalizeValue(readProperty(value as Record<string, unknown>, key), [...path, key], depth + 1, seen, limits, redactor);
		}
		if (keys.length > entries) result[TRUNCATED_KEY] = TRUNCATED;
		return result;
	} catch {
		return `${UNSUPPORTED}: object access failed`;
	} finally {
		seen.delete(value);
	}
}

function serializedByteLength(value: LogAttributeValue): number {
	return byteLength(JSON.stringify(value));
}

function trimToByteLimit(value: LogAttributeValue, maxBytes: number): LogAttributeValue {
	if (serializedByteLength(value) <= maxBytes) return value;
	if (typeof value === 'string') return normalizeString(value, maxBytes);
	if (Array.isArray(value)) {
		const result: LogAttributeValue[] = [];
		for (const item of value) {
			const trimmedItem = trimToByteLimit(item, maxBytes);
			const candidate = [...result, trimmedItem];
			if (serializedByteLength(candidate) > maxBytes) break;
			result.push(trimmedItem);
		}
		if (result.length < value.length && serializedByteLength([...result, TRUNCATED]) <= maxBytes) result.push(TRUNCATED);
		return result;
	}
	if (isObject(value)) {
		const result = createAttributeMap();
		for (const key of Object.keys(value).sort()) {
			const candidate = Object.assign(createAttributeMap(), result, { [key]: trimToByteLimit(value[key], maxBytes) });
			if (serializedByteLength(candidate) > maxBytes) break;
			result[key] = candidate[key];
		}
		if (Object.keys(result).length < Object.keys(value).length) {
			const candidate = Object.assign(createAttributeMap(), result, { [TRUNCATED_KEY]: TRUNCATED });
			if (serializedByteLength(candidate) <= maxBytes) return candidate;
		}
		return result;
	}
	return TRUNCATED;
}

function isErrorLike(value: unknown): value is Record<string, unknown> {
	if (!isObject(value)) return false;
	try {
		return ['name', 'message', 'stack', 'cause'].some(key => key in value);
	} catch {
		return false;
	}
}

export function normalizeLogAttributes(value: unknown, options: LogNormalizationOptions = {}): LogAttributes {
	const limits = resolveLogNormalizationLimits(options);
	const redactor = options.redactor ?? defaultLogRedactor;
	const normalized = normalizeValue(value, [], 0, new WeakSet<object>(), limits, redactor);
	const root = isObject(normalized) && !Array.isArray(normalized) ? normalized : { value: normalized };
	return trimToByteLimit(root as LogAttributes, limits.maxBytes) as LogAttributes;
}

export function normalizeLogValue(value: unknown, options: LogNormalizationOptions = {}): LogAttributeValue {
	const limits = resolveLogNormalizationLimits(options);
	const redactor = options.redactor ?? defaultLogRedactor;
	const normalized = normalizeValue(value, [], 0, new WeakSet<object>(), limits, redactor);
	return trimToByteLimit(normalized, limits.maxBytes);
}

export function findLegacyLogError(value: unknown): unknown {
	if (isErrorValue(value)) return value;
	if (!isObject(value)) return undefined;
	for (const key of ['e', 'err', 'error', 'stack']) {
		const candidate = readProperty(value, key);
		if (isErrorValue(candidate)) return candidate;
	}
	return undefined;
}

function serializeErrorValue(
	value: unknown,
	depth: number,
	seen: WeakSet<object>,
	limits: LogNormalizationLimits,
	redactor: LogRedactor,
): SerializedError {
	if (!isObject(value)) {
		return {
			type: value === null ? 'null' : typeof value,
			message: normalizeString(stringifySafely(value), limits.maxStringBytes),
		};
	}
	if (seen.has(value)) return { type: 'CircularError', message: CIRCULAR };
	seen.add(value);

	try {
		const name = readProperty(value, 'name');
		const message = readProperty(value, 'message');
		const stack = readProperty(value, 'stack');
		const cause = readProperty(value, 'cause');
		const constructor = readProperty(value, 'constructor');
		const constructorName = typeof constructor === 'function' || isObject(constructor)
			? readProperty(constructor as Record<string, unknown>, 'name')
			: undefined;
		const type = normalizeString(
			typeof name === 'string' && name.length > 0
				? name
				: typeof constructorName === 'string' && constructorName.length > 0 ? constructorName : 'Error',
			limits.maxStringBytes,
		);
		const result: { type: string; message: string; stack?: string; cause?: SerializedError | LogAttributeValue } = {
			type,
			message: normalizeString(typeof message === 'string' ? message : stringifySafely(value), limits.maxStringBytes),
		};
		if (typeof stack === 'string') result.stack = normalizeString(stack, limits.maxStringBytes);
		if (typeof cause !== 'undefined') {
			result.cause = depth < limits.maxDepth
				? isErrorValue(cause) || isErrorLike(cause)
					? serializeErrorValue(cause, depth + 1, seen, limits, redactor)
					: normalizeValue(cause, ['cause'], depth + 1, seen, limits, redactor)
				: TRUNCATED;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function trimSerializedError(value: SerializedError, maxBytes: number): SerializedError {
	const requiredLimit = Math.max(0, Math.floor((maxBytes - 24) / 2));
	const result: { type: string; message: string; stack?: string; cause?: SerializedError | LogAttributeValue } = {
		type: normalizeString(value.type, requiredLimit),
		message: normalizeString(value.message, requiredLimit),
	};
	if (serializedByteLength(result as unknown as LogAttributeValue) > maxBytes) {
		return { type: '', message: '' };
	}
	if (value.stack != null) {
		const candidate = { ...result, stack: value.stack };
		if (serializedByteLength(candidate as unknown as LogAttributeValue) <= maxBytes) result.stack = value.stack;
	}
	if (value.cause != null) {
		const cause = typeof value.cause === 'object'
			? trimToByteLimit(value.cause as LogAttributeValue, maxBytes)
			: value.cause;
		const candidate = { ...result, cause };
		if (serializedByteLength(candidate as unknown as LogAttributeValue) <= maxBytes) result.cause = cause as SerializedError | LogAttributeValue;
	}
	return result;
}

export function serializeLogError(value: unknown, options: LogNormalizationOptions = {}): SerializedError | undefined {
	if (typeof value === 'undefined' || value === null) return undefined;
	const limits = resolveLogNormalizationLimits(options);
	if (limits.maxBytes < 24) return undefined;
	const serialized = serializeErrorValue(value, 0, new WeakSet<object>(), limits, options.redactor ?? defaultLogRedactor);
	return trimSerializedError(serialized, limits.maxBytes);
}
