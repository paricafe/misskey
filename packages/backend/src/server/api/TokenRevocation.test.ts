/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import RevokeTokenEndpoint from './endpoints/i/revoke-token.js';

function setup() {
	const tokens = { findOneBy: vi.fn().mockResolvedValue({ id: 'target', userId: 'alice' }), delete: vi.fn().mockResolvedValue({ affected: 1 }) };
	const events = { publishInternalEvent: vi.fn() };
	return { endpoint: new RevokeTokenEndpoint(tokens as never, events as never), tokens, events };
}

describe('access token revocation events', () => {
	test('publishes the owner and token ID after the token is deleted', async () => {
		const { endpoint, tokens, events } = setup();
		await endpoint.exec({ tokenId: 'target' }, { id: 'alice' } as never, null);
		expect(tokens.delete).toHaveBeenCalledExactlyOnceWith({ id: 'target' });
		expect(events.publishInternalEvent).toHaveBeenCalledExactlyOnceWith('accessTokenRevoked', { id: 'target', userId: 'alice' });
		expect(tokens.delete.mock.invocationCallOrder[0]).toBeLessThan(events.publishInternalEvent.mock.invocationCallOrder[0]);
	});

	test('does not revoke another app token or announce an unsuccessful deletion', async () => {
		const { endpoint, tokens, events } = setup();
		await expect(endpoint.exec({ tokenId: 'target' }, { id: 'alice' } as never, { id: 'other' } as never)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
		expect(tokens.delete).not.toHaveBeenCalled();
		tokens.delete.mockRejectedValue(new Error('database unavailable'));
		await expect(endpoint.exec({ tokenId: 'target' }, { id: 'alice' } as never, null)).rejects.toThrow('database unavailable');
		expect(events.publishInternalEvent).not.toHaveBeenCalled();
	});

	test('does not finish before the revocation is published to other workers', async () => {
		const { endpoint, events } = setup();
		let publish!: () => void;
		events.publishInternalEvent.mockImplementation(() => new Promise<void>(resolve => { publish = resolve; }));
		let finished = false;
		const request = endpoint.exec({ tokenId: 'target' }, { id: 'alice' } as never, null).then(() => { finished = true; });
		await vi.waitFor(() => expect(events.publishInternalEvent).toHaveBeenCalledOnce());
		expect(finished).toBe(false);
		publish();
		await request;
		expect(finished).toBe(true);
	});
});
