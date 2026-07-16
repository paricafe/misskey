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

	test('deprecated follow scope aliases follow, block, and mute operations', () => {
		expect(service.allows(['follow'], 'read:follows')).toBe(true);
		expect(service.allows(['follow'], 'write:follows')).toBe(true);
		expect(service.allows(['follow'], 'read:blocks')).toBe(true);
		expect(service.allows(['follow'], 'write:blocks')).toBe(true);
		expect(service.allows(['follow'], 'read:mutes')).toBe(true);
		expect(service.allows(['follow'], 'write:mutes')).toBe(true);
		expect(service.allows(['follow'], 'write:statuses')).toBe(false);
	});

	test('normalizes a whitespace-delimited scope list', () => {
		expect(service.normalize('write:statuses  read:accounts write:statuses')).toEqual([
			'write:statuses',
			'read:accounts',
		]);
	});

	test('recognizes official non-admin profile and collection scopes', () => {
		expect(service.normalize('profile read:collections write:collections')).toEqual([
			'profile',
			'read:collections',
			'write:collections',
		]);
	});

	test.each(['admin:read', 'admin:write', 'unknown'])('rejects unsupported or admin scope %s', scope => {
		expect(() => service.normalize(`read ${scope}`)).toThrow();
	});

	test('maps granular scopes to the minimum Misskey permissions', () => {
		expect(service.toMisskeyPermissions(['write:statuses'])).toEqual(['write:drive', 'write:notes', 'write:votes']);
		expect(service.toMisskeyPermissions(['read:notifications'])).toEqual(['read:notifications']);
		expect(service.toMisskeyPermissions(['profile'])).toEqual(['read:account']);
		expect(service.toMisskeyPermissions(['read:collections', 'write:collections'])).toEqual([]);
		expect(service.toMisskeyPermissions(['follow'])).toEqual(expect.arrayContaining([
			'read:following',
			'write:following',
			'read:blocks',
			'write:blocks',
			'read:mutes',
			'write:mutes',
		]));
	});

	test('keeps profile distinct while allowing generic read to satisfy account alternatives', () => {
		expect(service.allows(['profile'], 'profile')).toBe(true);
		expect(service.allows(['profile'], 'read:accounts')).toBe(false);
		expect(service.allowsAny(['read'], ['profile', 'read:accounts'])).toBe(true);
		expect(service.allowsAny(['write'], ['write:statuses', 'write:accounts'])).toBe(true);
	});

	test('expands umbrella and compatibility scopes without duplicates', () => {
		const permissions = service.toMisskeyPermissions(['read', 'write', 'follow', 'push']);

		expect(permissions).toContain('read:account');
		expect(permissions).toContain('write:notes');
		expect(permissions).toContain('write:following');
		expect(new Set(permissions).size).toBe(permissions.length);
	});

	test('exposes the supported compatibility scopes for OAuth metadata', () => {
		expect(service.getSupportedScopes()).toEqual(expect.arrayContaining([
			'read',
			'write',
			'follow',
			'push',
			'profile',
			'read:collections',
			'write:collections',
			'read:statuses',
			'write:statuses',
		]));
	});
});
