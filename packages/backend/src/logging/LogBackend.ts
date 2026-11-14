/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { AccessLogRecord, LogRecord } from './types.js';

export interface LogBackend {
	write(record: LogRecord): void;

	writeAccess?(record: AccessLogRecord): void;

	flush?(): void | Promise<void>;

	close?(): void | Promise<void>;
}
