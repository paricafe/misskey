/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { NestFactory } from '@nestjs/core';
import { init } from 'slacc';
import { NestLogger } from '@/NestLogger.js';
import { envOption } from '@/env.js';
import type { Config } from '@/config.js';
import { manageApplication } from './application-lifecycle.js';
import type { DynamicModule, Type } from '@nestjs/common';

let slaccInitialized = false;

export function initExtraThreadPool(config: Config) {
	if (slaccInitialized) return;

	const threadPoolSize = Math.max(config.threadPoolSize ?? 1, 1);

	init(threadPoolSize);

	slaccInitialized = true;
}

type ApplicationMode = 'server' | 'queue' | 'combined';

async function startApplication(mode: ApplicationMode) {
	const managed = await manageApplication(async () => {
		let module: Type<unknown> | DynamicModule;
		if (mode === 'server') {
			module = (await import('../MainModule.js')).MainModule;
		} else if (mode === 'queue') {
			module = (await import('../queue/QueueProcessorModule.js')).QueueProcessorModule;
		} else {
			const [{ MainModule }, { QueueProcessorModule }] = await Promise.all([
				import('../MainModule.js'), import('../queue/QueueProcessorModule.js'),
			]);
			module = { module: MainModule, imports: [QueueProcessorModule] };
		}

		const app = await NestFactory.createApplicationContext(module, {
			logger: new NestLogger(),
		});

		const serverService = mode !== 'queue' ? app.get((await import('../server/ServerService.js')).ServerService) : undefined;
		const queueService = mode !== 'server' ? app.get((await import('../queue/QueueProcessorService.js')).QueueProcessorService) : undefined;
		await serverService?.launch();
		queueService?.start();

		if (!envOption.noDaemons && (queueService != null || process.env.NODE_ENV !== 'test')) {
			const { ChartManagementService } = await import('../core/chart/ChartManagementService.js');
			app.get(ChartManagementService).start();
			if (serverService != null && process.env.NODE_ENV !== 'test') {
				const { QueueStatsService } = await import('../daemons/QueueStatsService.js');
				const { ServerStatsService } = await import('../daemons/ServerStatsService.js');
				app.get(QueueStatsService).start();
				app.get(ServerStatsService).start();
			}
		}

		return {
			app,
			drain: async () => {
				// Both consumers must finish before their shared database/Redis close,
				// even if one consumer reports a drain failure.
				const results = await Promise.allSettled([serverService?.dispose(), queueService?.stop()]);
				const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
				if (errors.length > 0) throw new AggregateError(errors, 'Application drain failed');
			},
			close: () => app.close(),
		};
	});
	return managed.app;
}

export function server() {
	return startApplication('server');
}

export function jobQueue() {
	return startApplication('queue');
}

/** Share CoreModule, caches and connection pools in a single-process deployment. */
export function serverAndQueue() {
	return startApplication('combined');
}
