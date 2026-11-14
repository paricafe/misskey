/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Config } from '@/config.js';
import type { LogTraceContext } from '@/logging/types.js';

export type SentryBackendConfig = NonNullable<Config['sentryForBackend']>;

export interface TelemetryCaptureMessageOptions {
	level: 'error';

	userId?: string;

	extra?: Record<string, unknown>;
}

export interface TelemetryAdapter {
	captureMessage(message: string, opts: TelemetryCaptureMessageOptions): void;

	getActiveTraceContext?(): LogTraceContext | undefined;

	startSpan<T>(name: string, fn: () => T): T;

	shutdown(): Promise<void>;
}
