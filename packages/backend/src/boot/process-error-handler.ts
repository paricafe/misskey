/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { LogWriteInput } from '@/logging/types.js';

export type ProcessErrorHandlerProcess = {
	on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
	on(event: 'uncaughtException', listener: (error: Error) => void): unknown;
};

export type ProcessErrorHandlerLogger = {
	write(input: LogWriteInput): void;
};

export type ProcessErrorHandlerOptions = {
	readonly process?: ProcessErrorHandlerProcess;
	readonly logger: ProcessErrorHandlerLogger;
	readonly quiet: boolean;
};

function writeProcessError(
	logger: ProcessErrorHandlerLogger,
	eventName: 'process.unhandled_rejection' | 'process.uncaught_exception',
	message: string,
	error: unknown,
): void {
	try {
		logger.write({
			level: 'error',
			eventName,
			message,
			error,
		});
	} catch {
	}
}

export function installProcessErrorHandlers(options: ProcessErrorHandlerOptions): void {
	const processLike: ProcessErrorHandlerProcess = options.process ?? (process as unknown as ProcessErrorHandlerProcess);

	if (!options.quiet) {
		processLike.on('unhandledRejection', reason => {
			writeProcessError(options.logger, 'process.unhandled_rejection', 'Unhandled promise rejection', reason);
		});
	}

	processLike.on('uncaughtException', error => {
		writeProcessError(options.logger, 'process.uncaught_exception', 'Uncaught exception', error);
	});
}
