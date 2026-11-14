/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Logger from '@/logger.js';
import { setLogTraceContextProvider } from '@/logging/logging-runtime.js';
import { SentryTelemetryAdapter } from './adapters/SentryTelemetryAdapter.js';
import type { Config } from '@/config.js';
import type { TelemetryAdapter, TelemetryCaptureMessageOptions } from './adapters/TelemetryAdapter.js';

const logger = new Logger('telemetry');

const adapters: TelemetryAdapter[] = [];

export async function initTelemetry(config: Config): Promise<void> {
	if (config.sentryForBackend) {
		const adapter = await SentryTelemetryAdapter.create(config.sentryForBackend, message => logger.warn(message));
		adapters.push(adapter);
		setLogTraceContextProvider(() => adapter.getActiveTraceContext?.());
	}
}

export function captureMessage(message: string, opts: TelemetryCaptureMessageOptions): void {
	for (const adapter of adapters) {
		adapter.captureMessage(message, opts);
	}
}

export function startSpan<T>(name: string, fn: () => T): T {
	if (adapters.length === 0) return fn();
	if (adapters.length === 1) return adapters[0].startSpan(name, fn);

	const wrapped = adapters.reduceRight<() => T>(
		(inner, adapter) => () => adapter.startSpan(name, inner),
		fn,
	);
	return wrapped();
}

export async function shutdownTelemetry(): Promise<void> {
	await Promise.allSettled(adapters.map(adapter => adapter.shutdown()));
}
