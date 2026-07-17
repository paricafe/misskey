/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import { MastodonOAuthApplicationTokens1784113507739 } from '../../migration/1784113507739-mastodon-oauth-application-tokens.js';
import { MiMastodonOAuthToken } from '@/models/MastodonOAuthToken.js';

describe('Mastodon OAuth application token migration', () => {
	test('drops and restores only the userId not-null constraint', async () => {
		const query = vi.fn().mockResolvedValue(undefined);
		const migration = new MastodonOAuthApplicationTokens1784113507739();

		await migration.up({ query } as never);
		expect(query).toHaveBeenCalledTimes(1);
		expect(query).toHaveBeenNthCalledWith(1, 'ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" DROP NOT NULL');

		query.mockClear();
		await migration.down({ query } as never);
		expect(query).toHaveBeenNthCalledWith(1, 'DELETE FROM "mastodon_oauth_token" WHERE "userId" IS NULL');
		expect(query).toHaveBeenNthCalledWith(2, 'ALTER TABLE "mastodon_oauth_token" ALTER COLUMN "userId" SET NOT NULL');
	});

	test('marks the entity userId column nullable', () => {
		const column = getMetadataArgsStorage().columns.find(value => (
			value.target === MiMastodonOAuthToken && value.propertyName === 'userId'
		));
		expect(column?.options.nullable).toBe(true);
	});
});
