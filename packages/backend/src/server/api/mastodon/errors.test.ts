/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { ApiError } from '@/server/api/error.js';
import { MastodonApiError, sendMastodonError } from './errors.js';

function replyMock() {
	const reply = {
		header: vi.fn(),
		code: vi.fn(),
		send: vi.fn(),
	};
	return reply;
}

describe('Mastodon error translation', () => {
	test('maps native missing entities to 404', () => {
		const reply = replyMock();
		sendMastodonError(reply as never, new ApiError({
			message: 'No such note.', code: 'NO_SUCH_NOTE', id: 'error-id',
		}));

		expect(reply.code).toHaveBeenCalledWith(404);
		expect(reply.send).toHaveBeenCalledWith({ error: 'No such note.' });
	});

	test('does not label OAuth client authentication failures as bearer-token failures', () => {
		const reply = replyMock();
		sendMastodonError(reply as never, new MastodonApiError(401, 'invalid_client', 'Bad client', true));

		expect(reply.header).not.toHaveBeenCalledWith('WWW-Authenticate', expect.anything());
		expect(reply.send).toHaveBeenCalledWith({ error: 'invalid_client', error_description: 'Bad client' });
	});

	test('preserves native rate-limit reset information as Retry-After', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
		try {
			const reply = replyMock();
			sendMastodonError(reply as never, new ApiError({
				message: 'Rate limit exceeded.',
				code: 'RATE_LIMIT_EXCEEDED',
				id: 'rate-limit',
				httpStatusCode: 429,
			}, { resetMs: Date.now() + 2500 }));

			expect(reply.code).toHaveBeenCalledWith(429);
			expect(reply.header).toHaveBeenCalledWith('Retry-After', '3');
		} finally {
			vi.useRealTimers();
		}
	});
});
