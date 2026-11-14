/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { bindThis } from '@/decorators.js';
import { logManager } from './logging/logging-runtime.js';
import type { LogEntryInput, LogLevel, LoggerContext, LogWriteInput } from './logging/types.js';
import type { Keyword } from 'color-convert';

type LegacyData = Record<string, any> | null;

// eslint-disable-next-line import/no-default-export
export default class Logger {
	private context: readonly LoggerContext[];

	constructor(context: string, color?: Keyword) {
		this.context = [{
			name: context,
			color,
		}];
	}

	@bindThis
	public createSubLogger(context: string, color?: Keyword): Logger {
		const logger = new Logger(context, color);
		logger.context = [...this.context, ...logger.context];
		return logger;
	}

	@bindThis
	private log(level: LogLevel, message: string, data?: unknown, important = false, legacyLevel?: 'success', error?: unknown): void {
		logManager.write({
			level,
			message,
			context: this.context,
			...(typeof error !== 'undefined' ? { error } : {}),
			compatibility: {
				legacyLevel,
				important,
				data,
			},
		});
	}

	@bindThis
	private logStructured(level: LogLevel, input: LogEntryInput): void {
		this.write({
			...input,
			level,
		});
	}

	@bindThis
	public write(input: LogWriteInput): void {
		logManager.write({
			...input,
			context: this.context,
		});
	}

	public error(input: LogEntryInput): void;
	public error(error: Error, data?: LegacyData, important?: boolean): void;
	public error(message: string, data?: LegacyData, important?: boolean): void;
	public error(errorOrMessage: string | Error, data?: LegacyData, important?: boolean): void;
	@bindThis
	public error(x: LogEntryInput | string | Error, data?: LegacyData, important = false): void {
		if (x instanceof Error) {
			data = data ?? {};
			data.e = x;
			this.log('error', x.toString(), data, important, undefined, x);
		} else if (typeof x === 'string') {
			this.log('error', x, data, important);
		} else {
			this.logStructured('error', x);
		}
	}

	public warn(input: LogEntryInput): void;
	public warn(message: string): void;
	public warn(message: string, data?: LegacyData, important?: boolean): void;
	@bindThis
	public warn(inputOrMessage: LogEntryInput | string, data?: LegacyData, important = false): void {
		if (typeof inputOrMessage === 'string') {
			this.log('warn', inputOrMessage, data, important);
		} else {
			this.logStructured('warn', inputOrMessage);
		}
	}

	@bindThis
	public succ(message: string, data?: Record<string, any> | null, important = false): void {
		this.log('info', message, data, important, 'success');
	}

	public debug(input: LogEntryInput): void;
	public debug(message: string): void;
	public debug(message: string, data?: LegacyData, important?: boolean): void;
	@bindThis
	public debug(inputOrMessage: LogEntryInput | string, data?: LegacyData, important = false): void {
		if (typeof inputOrMessage === 'string') {
			this.log('debug', inputOrMessage, data, important);
		} else {
			this.logStructured('debug', inputOrMessage);
		}
	}

	public info(input: LogEntryInput): void;
	public info(message: string): void;
	public info(message: string, data?: LegacyData, important?: boolean): void;
	@bindThis
	public info(inputOrMessage: LogEntryInput | string, data?: LegacyData, important = false): void {
		if (typeof inputOrMessage === 'string') {
			this.log('info', inputOrMessage, data, important);
		} else {
			this.logStructured('info', inputOrMessage);
		}
	}

	public fatal(input: LogEntryInput): void;
	public fatal(message: string): void;
	@bindThis
	public fatal(inputOrMessage: LogEntryInput | string): void {
		if (typeof inputOrMessage === 'string') {
			this.logStructured('fatal', { message: inputOrMessage });
		} else {
			this.logStructured('fatal', inputOrMessage);
		}
	}
}
