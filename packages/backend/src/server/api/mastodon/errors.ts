/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { FastifyReply } from 'fastify';
import { ApiError } from '@/server/api/error.js';

export class MastodonApiError extends Error {
	constructor(
		public readonly statusCode: number,
		public readonly error: string,
		public readonly description: string,
		public readonly oauth = false,
	) {
		super(description);
		this.name = 'MastodonApiError';
	}
}

export function sendMastodonError(reply: FastifyReply, error: unknown): void {
	const mastodonError = error instanceof MastodonApiError
		? error
		: error instanceof ApiError
			? new MastodonApiError(
				error.httpStatusCode ?? (error.code.startsWith('NO_SUCH_') || error.code.endsWith('_NOT_FOUND')
					? 404
					: error.kind === 'permission'
						? 403
						: error.kind === 'client'
							? 400
							: 500),
				error.code.toLowerCase(),
				error.message,
			)
		: new MastodonApiError(500, 'server_error', 'Internal server error');

	if (mastodonError.statusCode === 401 && !mastodonError.oauth) {
		reply.header('WWW-Authenticate', 'Bearer realm="Mastodon", error="invalid_token"');
	}
	if (error instanceof ApiError && mastodonError.statusCode === 429) {
		const resetMs = typeof error.info === 'object' && error.info != null && 'resetMs' in error.info
			? error.info.resetMs
			: undefined;
		if (typeof resetMs === 'number') {
			reply.header('Retry-After', Math.max(0, Math.ceil((resetMs - Date.now()) / 1000)).toString(10));
		}
	}
	reply.code(mastodonError.statusCode);
	reply.send(mastodonError.oauth
		? { error: mastodonError.error, error_description: mastodonError.description }
		: { error: mastodonError.description });
}
