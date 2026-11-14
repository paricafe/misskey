/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import fastify from 'fastify';
import httpSignature from '@peertube/http-signature';
import { ActivityPubServerService } from './ActivityPubServerService.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

function createServer(enqueue: () => Promise<unknown>) {
	vi.spyOn(httpSignature, 'parseRequest').mockReturnValue({ params: { headers: ['host', 'digest'] } } as never);
	const service = Object.create(ActivityPubServerService.prototype) as ActivityPubServerService;
	Object.assign(service, { meta: { federation: 'all' }, config: { host: 'local.example' }, queueService: { inbox: enqueue } });
	const server = fastify();
	server.post('/inbox', async (request, reply) => {
		request.rawBody = JSON.stringify(request.body);
		await (service as unknown as { inbox(request: FastifyRequest, reply: FastifyReply): Promise<void> }).inbox(request, reply);
	});
	const payload = JSON.stringify({ actor: 'https://remote.example/users/alice', type: 'Create' });
	const request = {
		method: 'POST' as const,
		url: '/inbox',
		payload,
		headers: {
			host: 'local.example',
			'content-type': 'application/json',
			digest: `SHA-256=${createHash('sha256').update(payload).digest('base64')}`,
		},
	};
	return { server, request };
}

describe('ActivityPub inbox durability', () => {
	test('acknowledges an activity only after enqueue succeeds', async () => {
		const pending = Promise.withResolvers<void>();
		const enqueue = vi.fn(() => pending.promise);
		const { server, request } = createServer(enqueue);
		let responded = false;
		const response = server.inject(request).then(result => {
			responded = true;
			return result;
		});
		try {
			await vi.waitFor(() => expect(enqueue).toHaveBeenCalledOnce());
			expect(responded).toBe(false);
			pending.resolve();
			expect((await response).statusCode).toBe(202);
		} finally {
			pending.resolve();
			await server.close();
		}
	});

	test('returns a retryable HTTP error when enqueue fails', async () => {
		const { server, request } = createServer(async () => { throw new Error('Redis unavailable'); });
		try {
			expect((await server.inject(request)).statusCode).toBe(500);
		} finally {
			await server.close();
		}
	});
});
