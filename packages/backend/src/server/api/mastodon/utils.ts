/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';
const FORBIDDEN_REDIRECT_PROTOCOLS = new Set([
	'data:',
	'file:',
	'ftp:',
	'javascript:',
	'vbscript:',
]);

export function generateCredential(): string {
	return randomBytes(32).toString('hex');
}

export function digestCredential(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function timingSafeDigestEqual(value: string, expectedDigest: string): boolean {
	const actual = Buffer.from(digestCredential(value), 'hex');
	const expected = Buffer.from(expectedDigest, 'hex');

	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function validateRedirectUri(value: string): string {
	if (value === OOB_REDIRECT_URI) return value;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError('redirect_uri must be an absolute URI');
	}

	if (FORBIDDEN_REDIRECT_PROTOCOLS.has(url.protocol)) {
		throw new TypeError(`redirect_uri protocol ${url.protocol} is not allowed`);
	}
	if (url.username !== '' || url.password !== '') {
		throw new TypeError('redirect_uri must not contain credentials');
	}
	if (url.hash !== '') {
		throw new TypeError('redirect_uri must not contain a fragment');
	}
	if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
		throw new TypeError('plain HTTP redirect_uri is only allowed for loopback hosts');
	}

	return value;
}

export function parseRedirectUris(value: string | string[]): string[] {
	const values = (Array.isArray(value) ? value : value.split(/\r?\n/u))
		.map(uri => uri.trim())
		.filter(uri => uri !== '');
	const redirectUris = [...new Set(values)].map(validateRedirectUri);

	if (redirectUris.length === 0) {
		throw new TypeError('at least one redirect_uri is required');
	}

	return redirectUris;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
