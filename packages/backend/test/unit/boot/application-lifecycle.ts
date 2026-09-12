/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';

describe('application shutdown coordination', () => {
	test('drains every context before closing any dependencies, including initialization in progress', async () => {
		vi.resetModules();
		const { manageApplication, shutdownApplications } = await import('@/boot/application-lifecycle.js');
		const calls: string[] = [];
		let finishRequest!: () => void;
		let finishInitialization!: () => void;
		const httpRequest = new Promise<void>(resolve => { finishRequest = resolve; });
		const initialization = new Promise<void>(resolve => { finishInitialization = resolve; });
		await manageApplication(async () => ({
			drain: async () => { calls.push('stop-http'); await httpRequest; calls.push('http-drained'); },
			close: async () => { calls.push('close-http-dependencies'); },
		}));
		const queue = manageApplication(async () => {
			await initialization;
			return {
				drain: async () => { calls.push('stop-queue'); },
				close: async () => { calls.push('close-queue-dependencies'); },
			};
		});
		const shutdown = shutdownApplications();
		expect(shutdownApplications()).toBe(shutdown);
		await vi.waitFor(() => expect(calls).toEqual(['stop-http']));
		finishInitialization();
		await queue;
		await vi.waitFor(() => expect(calls).toContain('stop-queue'));
		expect(calls).toEqual(['stop-http', 'stop-queue']);
		finishRequest();
		await shutdown;
		expect(calls).toEqual(['stop-http', 'stop-queue', 'http-drained', 'close-http-dependencies', 'close-queue-dependencies']);
	});

	test('attempts cleanup of the remaining contexts after one fails', async () => {
		vi.resetModules();
		const { manageApplication, shutdownApplications } = await import('@/boot/application-lifecycle.js');
		const close = vi.fn().mockResolvedValue(undefined);
		await manageApplication(async () => ({ drain: async () => { throw new Error('drain failed'); }, close }));
		await manageApplication(async () => ({ drain: async () => {}, close }));
		await expect(shutdownApplications()).rejects.toThrow('Application shutdown failed');
		expect(close).toHaveBeenCalledTimes(2);
	});

	test('runs Nest business flush hooks before its global database shutdown hook', async () => {
		vi.resetModules();
		const { manageApplication, shutdownApplications } = await import('@/boot/application-lifecycle.js');
		const calls: string[] = [];
		class DependenciesModule {}
		class BusinessModule {}
		class ApplicationModule {}
		const context = await NestFactory.createApplicationContext({
			module: ApplicationModule,
			imports: [{
				module: DependenciesModule,
				global: true,
				providers: [{ provide: 'db', useValue: { onApplicationShutdown: () => { calls.push('db-close'); } } }],
			}, {
				module: BusinessModule,
				providers: [{ provide: 'buffer', useValue: { onApplicationShutdown: () => { calls.push('flush-buffer'); } } }],
			}],
		}, { logger: false });
		await manageApplication(async () => ({ drain: async () => { calls.push('drain'); }, close: () => context.close() }));
		await shutdownApplications();
		expect(calls).toEqual(['drain', 'flush-buffer', 'db-close']);
	});
});
