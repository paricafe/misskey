/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Module } from '@nestjs/common';
import { describe, expect, test, vi } from 'vitest';

async function setup(options: { failServerDrain?: boolean; queueDrain?: Promise<void> } = {}) {
	vi.resetModules();
	const calls: string[] = [];
	class ServerToken {}
	class QueueToken {}
	class SharedModule {}
	class HttpModule {}
	class QueueModule {}
	Module({
		providers: [{
			provide: 'shared',
			useFactory: () => {
				calls.push('shared-created');
				return { onApplicationShutdown: () => { calls.push('shared-close'); } };
			},
		}],
		exports: ['shared'],
	})(SharedModule);
	Module({
		imports: [SharedModule],
		providers: [{
			provide: ServerToken,
			useValue: {
				launch: async () => { calls.push('server-start'); },
				dispose: async () => {
					calls.push('server-drain');
					if (options.failServerDrain) throw new Error('server drain failed');
				},
			},
		}],
	})(HttpModule);
	Module({
		imports: [SharedModule],
		providers: [{
			provide: QueueToken,
			useValue: {
				start: () => { calls.push('queue-start'); },
				stop: async () => {
					calls.push('queue-drain');
					await options.queueDrain;
					calls.push('queue-drained');
				},
			},
		}],
	})(QueueModule);
	vi.doMock('@/MainModule.js', () => ({ MainModule: HttpModule }));
	vi.doMock('@/queue/QueueProcessorModule.js', () => ({ QueueProcessorModule: QueueModule }));
	vi.doMock('@/server/ServerService.js', () => ({ ServerService: ServerToken }));
	vi.doMock('@/queue/QueueProcessorService.js', () => ({ QueueProcessorService: QueueToken }));
	const boot = await import('@/boot/common.js');
	const { shutdownApplications } = await import('@/boot/application-lifecycle.js');
	return { calls, boot, shutdownApplications };
}

describe('application roles', () => {
	test.each(['server', 'jobQueue', 'serverAndQueue'] as const)('%s starts only its consumers and closes shared dependencies once', async mode => {
		const { calls, boot, shutdownApplications } = await setup();
		try {
			await boot[mode]();
			expect(calls.filter(call => call === 'shared-created')).toHaveLength(1);
			expect(calls.includes('server-start')).toBe(mode !== 'jobQueue');
			expect(calls.includes('queue-start')).toBe(mode !== 'server');
		} finally {
			await shutdownApplications();
		}
		expect(calls.filter(call => call === 'shared-close')).toHaveLength(1);
		expect(calls.at(-1)).toBe('shared-close');
	});

	test('independently launched roles keep their own context', async () => {
		const { calls, boot, shutdownApplications } = await setup();
		try {
			await boot.server();
			await boot.jobQueue();
			expect(calls.filter(call => call === 'shared-created')).toHaveLength(2);
		} finally {
			await shutdownApplications();
		}
		expect(calls.filter(call => call === 'shared-close')).toHaveLength(2);
	});

	test('waits for both consumers before closing dependencies when one drain fails', async () => {
		let finishQueue!: () => void;
		const queueDrain = new Promise<void>(resolve => { finishQueue = resolve; });
		const { calls, boot, shutdownApplications } = await setup({ failServerDrain: true, queueDrain });
		await boot.serverAndQueue();
		const shutdown = expect(shutdownApplications()).rejects.toThrow('Application shutdown failed');
		try {
			await vi.waitFor(() => expect(calls).toContain('queue-drain'));
			expect(calls).not.toContain('shared-close');
		} finally {
			finishQueue();
			await shutdown;
		}
		expect(calls.slice(-2)).toEqual(['queue-drained', 'shared-close']);
	});
});
