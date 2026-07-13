/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import {
	digestCredential,
	generateCredential,
	parseRedirectUris,
	timingSafeDigestEqual,
	validateRedirectUri,
} from './utils.js';

describe('Mastodon API compatibility utilities', () => {
	test('generated credentials round-trip only through their digest', () => {
		const credential = generateCredential();
		const digest = digestCredential(credential);

		expect(credential).toHaveLength(64);
		expect(digest).toHaveLength(64);
		expect(timingSafeDigestEqual(credential, digest)).toBe(true);
		expect(timingSafeDigestEqual(`${credential}x`, digest)).toBe(false);
	});

	test.each([
		'https://client.example/callback',
		'http://127.0.0.1:34567/callback',
		'http://[::1]:34567/callback',
		'myapp://oauth/callback',
		'urn:ietf:wg:oauth:2.0:oob',
	])('accepts safe redirect URI %s', value => {
		expect(validateRedirectUri(value)).toBe(value);
	});

	test.each([
		'javascript:alert(1)',
		'data:text/plain,x',
		'file:///tmp/x',
		'vbscript:msgbox(1)',
		'https://user:password@example.com/callback',
		'https://client.example/callback#fragment',
		'http://client.example/callback',
		'not a uri',
	])('rejects unsafe redirect URI %s', value => {
		expect(() => validateRedirectUri(value)).toThrow();
	});

	test('parses newline-separated redirect URIs and removes duplicates', () => {
		expect(parseRedirectUris('https://client.example/a\n\nhttps://client.example/b\r\nhttps://client.example/a')).toEqual([
			'https://client.example/a',
			'https://client.example/b',
		]);
	});

	test('rejects an empty redirect URI list', () => {
		expect(() => parseRedirectUris('\n')).toThrow();
	});
});
