/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonApiIntegrationService } from './MastodonApiIntegrationService.js';

function createService(enabled: boolean) {
	const register = vi.fn();
	const attach = vi.fn();
	const detach = vi.fn().mockResolvedValue(undefined);
	const createServer = vi.fn();
	const service = new MastodonApiIntegrationService(
		{ enableMastodonApi: enabled } as never,
		{ createServer } as never,
		{ attach, detach } as never,
	);
	return { service, register, attach, detach, createServer };
}

describe('MastodonApiIntegrationService', () => {
	test('registers REST and manages streaming when Mastodon API is enabled', async () => {
		const { service, register, attach, detach, createServer } = createService(true);
		const server = {};

		service.register({ register } as never);
		service.attach(server as never);
		await service.detach();

		expect(register).toHaveBeenCalledWith(createServer);
		expect(attach).toHaveBeenCalledWith(server);
		expect(detach).toHaveBeenCalledTimes(1);
	});

	test('does nothing when Mastodon API is disabled', async () => {
		const { service, register, attach, detach } = createService(false);

		service.register({ register } as never);
		service.attach({} as never);
		await service.detach();

		expect(register).not.toHaveBeenCalled();
		expect(attach).not.toHaveBeenCalled();
		expect(detach).not.toHaveBeenCalled();
	});
});
