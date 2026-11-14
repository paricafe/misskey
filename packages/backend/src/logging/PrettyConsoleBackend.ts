/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import chalk from 'chalk';
import { default as convertColor } from 'color-convert';
import { format as dateFormat } from 'date-fns';
import { envOption } from '@/env.js';
import type { LogBackend } from './LogBackend.js';
import type { AccessLogRecord, LogAttributeValue, LogRecord } from './types.js';

export type PrettyConsoleBackendDependencies = {
	readonly output: (...args: unknown[]) => void;
	readonly withLogTime: () => boolean;
};

const defaultDependencies: PrettyConsoleBackendDependencies = {
	output: (...args) => console.log(...args),
	withLogTime: () => envOption.withLogTime,
};

function toPrettyLogValue(value: LogAttributeValue): LogAttributeValue {
	if (Array.isArray(value)) return value.map(item => toPrettyLogValue(item));
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toPrettyLogValue(child)]));
	}
	return value;
}

export class PrettyConsoleBackend implements LogBackend {
	private readonly dependencies: PrettyConsoleBackendDependencies;

	constructor(dependencies: Partial<PrettyConsoleBackendDependencies> = {}) {
		this.dependencies = {
			...defaultDependencies,
			...dependencies,
		};
	}

	public write(record: LogRecord): void {
		const legacyLevel = record.compatibility?.legacyLevel;
		const important = record.level === 'fatal' || (record.compatibility?.important ?? false);
		const presentationLevel = record.level === 'fatal' ? 'error' : (legacyLevel ?? record.level);
		const label =
			presentationLevel === 'error' ? important ? chalk.bgRed.white('ERR ') : chalk.red('ERR ') :
			presentationLevel === 'warn' ? chalk.yellow('WARN') :
			presentationLevel === 'success' ? important ? chalk.bgGreen.white('DONE') : chalk.green('DONE') :
			presentationLevel === 'debug' ? chalk.gray('VERB') :
			presentationLevel === 'info' ? chalk.blue('INFO') :
			null;
		const contexts = record.context.map(context => context.color
			? chalk.rgb(...convertColor.keyword.rgb(context.color))(context.name)
			: chalk.white(context.name));
		const message =
			presentationLevel === 'error' ? chalk.red(record.message) :
			presentationLevel === 'warn' ? chalk.yellow(record.message) :
			presentationLevel === 'success' ? chalk.green(record.message) :
			presentationLevel === 'debug' ? chalk.gray(record.message) :
			presentationLevel === 'info' ? record.message :
			null;
		const worker = record.isPrimary ? '*' : record.workerId;

		let log = `${label} ${worker}\t[${contexts.join(' ')}]\t${message}`;
		if (this.dependencies.withLogTime()) {
			log = chalk.gray(dateFormat(new Date(record.timestamp), 'HH:mm:ss')) + ' ' + log;
		}

		const args: unknown[] = [important ? chalk.bold(log) : log];
		if (record.compatibility?.data != null) {
			args.push(record.compatibility.data);
		} else if (record.eventName != null || record.attributes != null || record.error != null) {
			args.push({
				...(record.eventName != null ? { eventName: record.eventName } : {}),
				...(record.attributes != null ? { attributes: record.attributes } : {}),
				...(record.error != null ? { error: record.error } : {}),
			});
		}
		this.dependencies.output(...args);
	}

	public writeAccess(record: AccessLogRecord): void {
		const statusLevel = record.statusCode >= 500 ? 'error' : record.statusCode >= 400 ? 'warn' : 'info';
		const label =
			statusLevel === 'error' ? chalk.red('ERR ') :
			statusLevel === 'warn' ? chalk.yellow('WARN') :
			chalk.blue('INFO');
		const worker = record.isPrimary ? '*' : record.workerId;
		const route = record.route ?? '-';
		const size = record.responseSizeBytes == null ? '-' : `${record.responseSizeBytes}B`;
		const message = `${record.method} ${route} ${record.statusCode} ${record.durationMs.toFixed(2)}ms ${size}`;
		let log = `${label} ${worker}\t[access]\t${message}`;
		if (this.dependencies.withLogTime()) {
			log = chalk.gray(dateFormat(new Date(record.timestamp), 'HH:mm:ss')) + ' ' + log;
		}

		const details = {
			...(record.errorType != null ? { errorType: record.errorType } : {}),
			...(record.requestBody !== undefined ? { requestBody: toPrettyLogValue(record.requestBody) } : {}),
			...(record.responseBody !== undefined ? { responseBody: toPrettyLogValue(record.responseBody) } : {}),
		};
		const args: unknown[] = [log];
		if (Object.keys(details).length > 0) args.push(details);
		this.dependencies.output(...args);
	}
}
