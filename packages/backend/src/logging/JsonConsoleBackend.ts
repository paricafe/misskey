/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { LogBackend } from './LogBackend.js';
import type { AccessLogRecord, LogRecord } from './types.js';

export type JsonConsoleBackendDependencies = {
	readonly output: (line: string) => void;
};

type JsonLogRecord = {
	readonly timestamp: string;
	readonly level: LogRecord['level'];
	readonly message: string;
	readonly loggerName: string;
	readonly eventName?: string;
	readonly attributes?: LogRecord['attributes'];
	readonly error?: LogRecord['error'];
	readonly processId: number;
	readonly isPrimary: boolean;
	readonly workerId: number | null;
	readonly trace_id?: string;
	readonly span_id?: string;
	readonly trace_flags?: number;
};

type JsonAccessLogRecord = {
	readonly type: 'access';
	readonly timestamp: string;
	readonly method: string;
	readonly route: string | null;
	readonly statusCode: number;
	readonly durationMs: number;
	readonly responseSizeBytes: number | null;
	readonly errorType?: string;
	readonly requestBody?: AccessLogRecord['requestBody'];
	readonly responseBody?: AccessLogRecord['responseBody'];
	readonly processId: number;
	readonly isPrimary: boolean;
	readonly workerId: number | null;
	readonly trace_id?: string;
	readonly span_id?: string;
	readonly trace_flags?: number;
};

const defaultDependencies: JsonConsoleBackendDependencies = {
	output: line => console.log(line),
};

function createJsonLogRecord(record: LogRecord): JsonLogRecord {
	return {
		timestamp: record.timestamp,
		level: record.level,
		message: record.message,
		loggerName: record.loggerName,
		...(record.eventName != null ? { eventName: record.eventName } : {}),
		...(record.attributes != null ? { attributes: record.attributes } : {}),
		...(record.error != null ? { error: record.error } : {}),
		processId: record.processId,
		isPrimary: record.isPrimary,
		workerId: record.workerId,
		...(record.traceId != null ? { trace_id: record.traceId } : {}),
		...(record.spanId != null ? { span_id: record.spanId } : {}),
		...(record.traceFlags != null ? { trace_flags: record.traceFlags } : {}),
	};
}

function createJsonAccessLogRecord(record: AccessLogRecord): JsonAccessLogRecord {
	return {
		type: 'access',
		timestamp: record.timestamp,
		method: record.method,
		route: record.route,
		statusCode: record.statusCode,
		durationMs: record.durationMs,
		responseSizeBytes: record.responseSizeBytes,
		...(record.errorType != null ? { errorType: record.errorType } : {}),
		...(record.requestBody !== undefined ? { requestBody: record.requestBody } : {}),
		...(record.responseBody !== undefined ? { responseBody: record.responseBody } : {}),
		processId: record.processId,
		isPrimary: record.isPrimary,
		workerId: record.workerId,
		...(record.traceId != null ? { trace_id: record.traceId } : {}),
		...(record.spanId != null ? { span_id: record.spanId } : {}),
		...(record.traceFlags != null ? { trace_flags: record.traceFlags } : {}),
	};
}

export class JsonConsoleBackend implements LogBackend {
	private readonly dependencies: JsonConsoleBackendDependencies;

	constructor(dependencies: Partial<JsonConsoleBackendDependencies> = {}) {
		this.dependencies = {
			...defaultDependencies,
			...dependencies,
		};
	}

	public write(record: LogRecord): void {
		this.dependencies.output(JSON.stringify(createJsonLogRecord(record)));
	}

	public writeAccess(record: AccessLogRecord): void {
		this.dependencies.output(JSON.stringify(createJsonAccessLogRecord(record)));
	}
}
