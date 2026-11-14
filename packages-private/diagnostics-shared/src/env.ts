/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function readIntegerEnv(name: string, defaultValue: number, min: number) {
	const rawValue = process.env[name];
	if (rawValue == null || rawValue === '') return defaultValue;
	if (!/^\d+$/.test(rawValue)) throw new Error(`${name} must be an integer`);

	const value = Number(rawValue);
	if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be >= ${min}`);
	return value;
}

export function readBooleanEnv(name: string, defaultValue: boolean) {
	const rawValue = process.env[name];
	if (rawValue == null || rawValue === '') return defaultValue;
	if (rawValue === '1' || rawValue === 'true') return true;
	if (rawValue === '0' || rawValue === 'false') return false;
	throw new Error(`${name} must be one of: 1, 0, true, false`);
}

export function readRequiredEnv(name: string) {
	const rawValue = process.env[name]?.trim();
	if (rawValue == null || rawValue === '') throw new Error(`${name} must be set`);
	return rawValue;
}

export function readOptionalEnv(name: string) {
	const rawValue = process.env[name]?.trim();
	if (rawValue == null || rawValue === '') return null;
	return rawValue;
}
