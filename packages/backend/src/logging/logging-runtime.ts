/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { LogManager } from './LogManager.js';
import { BootstrapConsoleBackend } from './BootstrapConsoleBackend.js';
import { JsonConsoleBackend } from './JsonConsoleBackend.js';
import { PrettyConsoleBackend } from './PrettyConsoleBackend.js';
import type { LogManagerConfiguration } from './LogManager.js';
import type { LogTraceContextProvider, LogFormat } from './types.js';
import type { LogBackend } from './LogBackend.js';

export const logManager = new LogManager(new BootstrapConsoleBackend());

function createLoggingBackend(format: unknown): LogBackend {
	if (format == null || format === 'pretty') return new PrettyConsoleBackend();
	if (format === 'json') return new JsonConsoleBackend();
	throw new Error('logging.format must be either pretty or json');
}

export function configureLogging(configuration?: LogManagerConfiguration & { readonly format?: LogFormat }): void {
	const backend = createLoggingBackend(configuration?.format);
	const warnings = logManager.configure(configuration);
	logManager.setBackend(backend);
	for (const message of warnings) {
		logManager.write({
			level: 'warn',
			message,
			context: [{ name: 'logging' }],
		});
	}
}

export function setLogTraceContextProvider(provider?: LogTraceContextProvider): void {
	logManager.setTraceContextProvider(provider);
}

export function shutdownLogging(): Promise<void> {
	return logManager.shutdown();
}
