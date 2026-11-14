/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Keyword } from 'color-convert';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type LogLevelSetting = LogLevel | 'off';

export type LogFormat = 'pretty' | 'json';

export type AccessLogStatusClass = '2xx' | '3xx' | '4xx' | '5xx';

export type AccessLogBodyConfiguration = {
	readonly request?: boolean;
	readonly response?: boolean;
	readonly maxBytes?: number;
};

export type AccessLogConfiguration = {
	readonly statusClasses?: readonly AccessLogStatusClass[];
	readonly bodies?: AccessLogBodyConfiguration;
};

export type LogAttributeValue =
	| string
	| number
	| boolean
	| null
	| readonly LogAttributeValue[]
	| { readonly [key: string]: LogAttributeValue };

export type LogAttributes = Readonly<Record<string, LogAttributeValue>>;

export type LogTraceContext = {
	readonly traceId: string;
	readonly spanId: string;
	readonly traceFlags: number;
};

export type LogTraceContextProvider = () => LogTraceContext | undefined;

export type LogEntryInput = {
	readonly message: string;
	readonly eventName?: string;
	readonly attributes?: Readonly<Record<string, unknown>>;
	readonly error?: unknown;
};

export type LogWriteInput = LogEntryInput & {
	readonly level: LogLevel;
};

export type LoggerContext = {
	readonly name: string;
	readonly color?: Keyword;
};

export type LogCompatibility = {
	readonly legacyLevel?: 'success';
	readonly important?: boolean;
	readonly data?: unknown;
};

export type LogRecordInput = LogWriteInput & {
	readonly context: readonly LoggerContext[];
	readonly compatibility?: LogCompatibility;
};

export type SerializedError = {
	readonly type: string;
	readonly message: string;
	readonly stack?: string;
	readonly cause?: SerializedError | LogAttributeValue;
};

export type LogRecord = Omit<LogRecordInput, 'attributes' | 'error'> & {
	readonly timestamp: string;
	readonly loggerName: string;
	readonly processId: number;
	readonly isPrimary: boolean;
	readonly workerId: number | null;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly traceFlags?: number;
	readonly attributes?: LogAttributes;
	readonly error?: SerializedError;
};

export type AccessLogRecordInput = {
	readonly method: string;
	readonly route: string | null;
	readonly statusCode: number;
	readonly durationMs: number;
	readonly responseSizeBytes: number | null;
	readonly errorType?: string;
	readonly requestBody?: unknown;
	readonly responseBody?: unknown;
	readonly traceContext?: LogTraceContext;
};

export type AccessLogRecord = Omit<AccessLogRecordInput, 'requestBody' | 'responseBody' | 'traceContext'> & {
	readonly type: 'access';
	readonly timestamp: string;
	readonly processId: number;
	readonly isPrimary: boolean;
	readonly workerId: number | null;
	readonly requestBody?: LogAttributeValue;
	readonly responseBody?: LogAttributeValue;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly traceFlags?: number;
};
