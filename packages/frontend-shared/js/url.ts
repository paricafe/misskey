/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { toUnicode as decodePunycode } from 'punycode.js';

export function query(obj: Record<string, string | number | boolean>): string {
	const params = Object.entries(obj)
		.filter(([, v]) => Array.isArray(v) ? v.length : v !== undefined) // eslint-disable-line @typescript-eslint/no-unnecessary-condition
		.reduce<Record<string, string | number | boolean>>((a, [k, v]) => (a[k] = v, a), {});

	return Object.entries(params)
		.map((p) => `${p[0]}=${encodeURIComponent(p[1])}`)
		.join('&');
}

export function appendQuery(url: string, queryString: string): string {
	return `${url}${/\?/.test(url) ? url.endsWith('?') ? '' : '&' : '?'}${queryString}`;
}

export function extractDomain(url: string) {
	const match = url.match(/^(?:https?:)?(?:\/\/)?(?:[^@\n]+@)?([^:\/\n]+)/im);
	return match ? match[1] : null;
}

export function tryParseUrl(url: string | URL, base?: string | URL): URL | null {
	try {
		return new URL(url, base);
	} catch {
		return null;
	}
}

export function maybeMakeRelative(urlStr: string, baseStr: string): string {
	try {
		const baseObj = new URL(baseStr);
		const urlObj = new URL(urlStr);
		if (urlObj.origin === baseObj.origin) {
			return urlObj.pathname + urlObj.search + urlObj.hash;
		}
		return urlStr;
	} catch {
		return '';
	}
}

export function safeURIDecode(str: string): string {
	try {
		return decodeURIComponent(str);
	} catch {
		return str;
	}
}

export function parseUrlForDisplay(urlStr: string) {
	const url = new URL(urlStr);
	if (!['http:', 'https:'].includes(url.protocol)) throw new Error('invalid url');

	return {
		schema: url.protocol,
		hostname: decodePunycode(url.hostname),
		port: url.port,
		pathname: safeURIDecode(url.pathname),
		query: safeURIDecode(url.search),
		hash: safeURIDecode(url.hash),
	};
}
