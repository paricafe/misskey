/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import RevokeTokenEndpoint from './endpoints/i/revoke-token.js';

function setup() {
	const findOne = vi.fn().mockResolvedValue({ id: 'target' });
	const manager = { withRepository: () => ({ findOne }) };
	const tokens = { manager: { transaction: async (run: (tx: unknown) => Promise<void>) => run(manager) } };
	const outbox = { deleteAccessTokens: vi.fn(), dispatch: vi.fn() };
	return { endpoint: new RevokeTokenEndpoint(tokens as never, outbox as never), outbox, manager };
}

describe('access token revocation events', () => {
	test('queues a deletion for the owner and asks the dispatcher to send it after commit', async () => {
		const { endpoint, outbox, manager } = setup();
		await endpoint.exec({ tokenId: 'target' }, { id: 'alice' } as never, null);
		expect(outbox.deleteAccessTokens).toHaveBeenCalledExactlyOnceWith(manager, { id: 'target', userId: 'alice' });
		expect(outbox.dispatch).toHaveBeenCalledOnce();
		expect(outbox.deleteAccessTokens.mock.invocationCallOrder[0]).toBeLessThan(outbox.dispatch.mock.invocationCallOrder[0]);
	});

	test.each([null, ''])('prefers tokenId when both tokenId and an empty token (%s) are present', async token => {
		const { endpoint, outbox, manager } = setup();
		await endpoint.exec({ tokenId: 'target', token }, { id: 'alice' } as never, null);
		expect(outbox.deleteAccessTokens).toHaveBeenCalledWith(manager, { id: 'target', userId: 'alice' });
	});

	test('does not revoke another app token or dispatch a rolled-back change', async () => {
		const { endpoint, outbox } = setup();
		await expect(endpoint.exec({ tokenId: 'target' }, { id: 'alice' } as never, { id: 'other' } as never)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
		expect(outbox.deleteAccessTokens).not.toHaveBeenCalled();
		outbox.deleteAccessTokens.mockRejectedValue(new Error('database unavailable'));
		await expect(endpoint.exec({ tokenId: 'target' }, { id: 'alice' } as never, null)).rejects.toThrow('database unavailable');
		expect(outbox.dispatch).not.toHaveBeenCalled();
	});

	test('returns success after commit while the event publisher is unavailable', async () => {
		const { endpoint, outbox } = setup();
		outbox.dispatch.mockReturnValue(new Promise<void>(() => {}));
		await endpoint.exec({ tokenId: 'target' }, { id: 'alice' } as never, null);
		expect(outbox.dispatch).toHaveBeenCalledOnce();
	});
});
