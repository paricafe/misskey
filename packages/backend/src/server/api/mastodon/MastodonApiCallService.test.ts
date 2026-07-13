/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { MastodonScopeService } from './MastodonScopeService.js';
import { MastodonApiCallService } from './MastodonApiCallService.js';

describe(MastodonApiCallService, () => {
	test('invokes an existing endpoint with mapped permissions', async () => {
		const exec = vi.fn();
		const moduleRef = { get: vi.fn().mockReturnValue({ exec }) };
		const invoke = vi.fn().mockResolvedValue({ id: 'user-id' });
		const service = new MastodonApiCallService(
			moduleRef as never,
			{ invoke } as never,
			new MastodonScopeService(),
		);
		const auth = {
			user: { id: 'user-id' },
			token: { id: 'token-id', scopes: ['write:statuses'] },
		};
		const request = { method: 'POST' };

		await expect(service.invoke('notes/create', { text: 'hello' }, auth as never, request as never)).resolves.toEqual({ id: 'user-id' });
		expect(moduleRef.get).toHaveBeenCalledWith('ep:notes/create', { strict: false });
		expect(invoke).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'notes/create', exec }),
			auth.user,
			expect.objectContaining({ id: 'token-id', permission: ['write:drive', 'write:notes', 'write:votes'] }),
			{ text: 'hello' },
			null,
			request,
		);
	});

	test('rejects an endpoint outside the native endpoint list', async () => {
		const service = new MastodonApiCallService(
			{ get: vi.fn() } as never,
			{ invoke: vi.fn() } as never,
			new MastodonScopeService(),
		);

		await expect(service.invoke('does/not/exist', {}, {} as never, {} as never)).rejects.toMatchObject({ statusCode: 500 });
	});
});
