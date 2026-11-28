/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiCallService } from './ApiCallService.js';

describe('ApiCallService access token account status enforcement', () => {
	const services: ApiCallService[] = [];

	afterEach(() => {
		while (services.length > 0) services.pop()!.onApplicationShutdown();
	});

	function createService(user: Record<string, unknown>, token: Record<string, unknown> | null) {
		const service = new ApiCallService(
			{ enableIpLogging: false, rootUserId: 'root' } as never,
			{ enableIpRateLimit: false } as never,
			{} as never,
			{ authenticate: vi.fn().mockResolvedValue([user, token]) } as never,
			{} as never,
			{} as never,
			{ logger: { warn: vi.fn(), write: vi.fn() } } as never,
			{ startSpan: (_name: string, fn: () => unknown) => fn(), captureMessage: vi.fn() } as never,
		);
		services.push(service);
		return service;
	}

	function createReply() {
		const state: { statusCode: number; payload: unknown; headers: Record<string, string> } = { statusCode: 200, payload: undefined, headers: {} };
		const reply = {
			code(code: number) { state.statusCode = code; return reply; },
			header(name: string, value: string) { state.headers[name] = value; return reply; },
			send(payload: unknown) { state.payload = payload; return reply; },
		};
		return { reply, state };
	}

	const pingEndpoint = {
		name: 'ping',
		meta: { requireCredential: false },
		params: { type: 'object', properties: {}, required: [] },
		exec: vi.fn().mockResolvedValue({ pong: 1 }),
	};

	test('rejects suspended and deleted app tokens even on requireCredential: false endpoints', async () => {
		for (const [flags, code] of [
			[{ isSuspended: true, isDeleted: false }, 'YOUR_ACCOUNT_SUSPENDED'],
			[{ isSuspended: false, isDeleted: true }, 'YOUR_ACCOUNT_DELETED'],
		] as const) {
			const service = createService({ id: 'u1', ...flags }, { id: 'tok1', permission: [] });
			const { reply, state } = createReply();
			await service.handleRequest(
				pingEndpoint as never,
				{ headers: { authorization: 'Bearer app-token' }, body: {}, query: {}, ip: '127.0.0.1' } as never,
				reply as never,
			);
			expect(state.statusCode).toBe(403);
			expect((state.payload as { error: { code: string } }).error.code).toBe(code);
		}
	});

	test('allows active app tokens with empty permissions and native web session calls on ping', async () => {
		const activeApp = createService({ id: 'u1', isSuspended: false, isDeleted: false }, { id: 'tok1', permission: [] });
		const first = createReply();
		await activeApp.handleRequest(
			pingEndpoint as never,
			{ headers: { authorization: 'Bearer app-token' }, body: {}, query: {}, ip: '127.0.0.1' } as never,
			first.reply as never,
		);
		expect(first.state.statusCode).toBe(200);
		expect(first.state.payload).toEqual({ pong: 1 });

		const suspendedWeb = createService({ id: 'u1', isSuspended: true, isDeleted: false }, null);
		const second = createReply();
		await suspendedWeb.handleRequest(
			pingEndpoint as never,
			{ headers: { authorization: 'Bearer native-web-token' }, body: {}, query: {}, ip: '127.0.0.1' } as never,
			second.reply as never,
		);
		expect(second.state.statusCode).toBe(200);
	});
});
