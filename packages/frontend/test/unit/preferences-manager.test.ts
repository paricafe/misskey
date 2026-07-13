/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { assert, describe, test } from 'vitest';
import { migrateLegacyAutoSpacingPreference } from '@/preferences/manager.js';

describe('migrateLegacyAutoSpacingPreference', () => {
	test.each([
		['all', true],
		['special', true],
		[null, false],
	] as const)('migrates %s to %s while preserving scope and metadata', (legacy, expected) => {
		const scope = { server: 'example.com', account: 'user' };
		const meta = { sync: false };
		const migrated = migrateLegacyAutoSpacingPreference({
			autoSpacingBehaviour: [[scope, legacy, meta]],
		});

		assert.deepStrictEqual(migrated.autoSpacing, [[scope, expected, meta]]);
		assert.strictEqual(migrated.autoSpacing?.[0]?.[0], scope);
		assert.strictEqual(migrated.autoSpacing?.[0]?.[2], meta);
	});

	test('keeps existing new records instead of legacy records', () => {
		const current = [[{}, false, { sync: true }]] as [Record<string, never>, boolean, { sync: boolean }][];
		const migrated = migrateLegacyAutoSpacingPreference({
			autoSpacing: current,
			autoSpacingBehaviour: [[{}, 'all', {}]],
		});

		assert.strictEqual(migrated.autoSpacing, current);
	});
});
