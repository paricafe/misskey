/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { escapeHtml } from './format';

export class Raw {
	constructor(private readonly value: string) {}

	toString() {
		return this.value;
	}
}

export function raw(value: string) {
	return new Raw(value);
}

function interpolate(value: unknown): string {
	if (value instanceof Raw) return value.toString();
	if (Array.isArray(value)) return value.map(interpolate).join('');
	if (value == null) return '';
	return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]) {
	let result = strings[0];
	for (let i = 0; i < values.length; i++) {
		result += interpolate(values[i]) + strings[i + 1];
	}
	return new Raw(result);
}

export function joinHtml(parts: readonly Raw[], separator: string) {
	return new Raw(parts.map(part => part.toString()).join(separator));
}
