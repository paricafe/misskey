/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { TelemetryService } from '@/core/telemetry/TelemetryService.js';

type QueueTelemetryService = Pick<TelemetryService, 'startSpan'>;

export function runQueueJob<T>(
	telemetryService: QueueTelemetryService,
	spanName: string,
	processJob: () => T | Promise<T>,
	onError: (error: Error) => void,
): Promise<T> {
	return telemetryService.startSpan(spanName, async (): Promise<T> => {
		try {
			return await processJob();
		} catch (error) {
			const normalizedError = error instanceof Error ? error : new Error(String(error));
			try {
				onError(normalizedError);
			} catch {
			}
			throw error;
		}
	});
}
