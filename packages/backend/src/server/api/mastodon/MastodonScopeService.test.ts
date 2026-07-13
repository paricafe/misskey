/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { MastodonScopeService } from './MastodonScopeService.js';

describe(MastodonScopeService, () => {
	const service = new MastodonScopeService();

	test('umbrella scopes allow their granular children', () => {
		expect(service.allows(['read'], 'read:statuses')).toBe(true);
		expect(service.allows(['write'], 'write:media')).toBe(true);
	});

	test('granular scopes do not allow siblings', () => {
		expect(service.allows(['read:accounts'], 'read:statuses')).toBe(false);
	});

	test('deprecated follow scope allows only follow operations', () => {
		expect(service.allows(['follow'], 'read:follows')).toBe(true);
		expect(service.allows(['follow'], 'write:follows')).toBe(true);
		expect(service.allows(['follow'], 'write:statuses')).toBe(false);
	});

	test('normalizes a whitespace-delimited scope list', () => {
		expect(service.normalize('write:statuses  read:accounts write:statuses')).toEqual([
			'write:statuses',
			'read:accounts',
		]);
	});

	test('rejects unknown scopes', () => {
		expect(() => service.normalize('read unknown')).toThrow();
	});

	test('maps granular scopes to the minimum Misskey permissions', () => {
		expect(service.toMisskeyPermissions(['write:statuses'])).toEqual(['write:drive', 'write:notes', 'write:votes']);
		expect(service.toMisskeyPermissions(['read:notifications'])).toEqual(['read:notifications']);
	});

	test('expands umbrella and compatibility scopes without duplicates', () => {
		const permissions = service.toMisskeyPermissions(['read', 'write', 'follow', 'push']);

		expect(permissions).toContain('read:account');
		expect(permissions).toContain('write:notes');
		expect(permissions).toContain('write:following');
		expect(new Set(permissions).size).toBe(permissions.length);
	});

	test('exposes the supported compatibility scopes for OAuth metadata', () => {
		expect(service.getSupportedScopes()).toEqual(expect.arrayContaining(['read', 'write', 'follow', 'push', 'read:statuses', 'write:statuses']));
	});
});
