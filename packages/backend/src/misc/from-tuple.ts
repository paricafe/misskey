/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function fromTuple<T>(value: T | [T]): T {
	if (Array.isArray(value)) {
		return value[0];
	}

	return value;
}
