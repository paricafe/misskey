/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ConsoleLogger, LOG_LEVELS } from '@nestjs/common';
import Logger from '@/logger.js';
import type { LogLevel as NestLogLevel } from '@nestjs/common';
import type { LogLevel as MisskeyLogLevel } from '@/logging/types.js';

const logger = new Logger('core', 'cyan');
const nestLogger = logger.createSubLogger('nest', 'green');

const levelMap: Record<NestLogLevel, MisskeyLogLevel> = {
	verbose: 'debug',
	debug: 'debug',
	log: 'info',
	warn: 'warn',
	error: 'error',
	fatal: 'fatal',
};

export class NestLogger extends ConsoleLogger {
	constructor() {
		super({
			colors: false,
			compact: true,
			logLevels: process.env.NODE_ENV === 'production'
				? LOG_LEVELS.filter(level => level !== 'debug' && level !== 'verbose')
				: [...LOG_LEVELS],
		});
	}

	protected override printMessages(
		messages: unknown[],
		context = '',
		logLevel: NestLogLevel = 'log',
		_writeStreamType?: 'stdout' | 'stderr',
		errorStack?: unknown,
		params?: Record<string, any>,
	): void {
		for (const message of messages) {
			const body = message instanceof Error
				? message.toString()
				: String(this.stringifyMessage(message, logLevel));

			const error = message instanceof Error
				? message
				: typeof errorStack === 'string'
					? { name: 'Error', message: body, stack: errorStack }
					: undefined;

			nestLogger.write({
				level: levelMap[logLevel],
				message: context === '' ? body : `${context}: ${body}`,
				...(error != null ? { error } : {}),
				...(params != null ? { attributes: params } : {}),
			});
		}
	}

	protected override printStackTrace(): void {
	}
}
