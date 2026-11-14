/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import cluster from 'node:cluster';
import process from 'node:process';
import { envOption } from '@/env.js';
import {
	findLegacyLogError,
	normalizeLogAttributes,
	normalizeLogValue,
	serializeLogError,
	type LogNormalizationProfile,
} from './LogNormalizer.js';
import type { LogBackend } from './LogBackend.js';
import type {
	AccessLogConfiguration,
	AccessLogRecord,
	AccessLogRecordInput,
	AccessLogStatusClass,
	LogLevel,
	LogLevelSetting,
	LogRecord,
	LogRecordInput,
	LogTraceContext,
	LogTraceContextProvider,
} from './types.js';

export type LogProcessInfo = {
	readonly processId: number;
	readonly isPrimary: boolean;
	readonly workerId: number | null;
};

export type LogManagerDependencies = {
	readonly now: () => Date;
	readonly getProcessInfo: () => LogProcessInfo;
	readonly isQuiet: () => boolean;
	readonly isVerbose: () => boolean;
	readonly getNodeEnv: () => string | undefined;
};

export type LogManagerOptions = {
	readonly normalizationProfile?: LogNormalizationProfile;
};

export type LogManagerConfiguration = {
	readonly level?: LogLevelSetting;
	readonly domains?: Readonly<Record<string, LogLevelSetting>> | null;
	readonly access?: AccessLogConfiguration;
};

export type ResolvedAccessLogConfiguration = {
	readonly statusClasses: readonly AccessLogStatusClass[];
	readonly bodies: {
		readonly request: boolean;
		readonly response: boolean;
		readonly maxBytes: number;
	};
};

const logLevelOrder: Readonly<Record<LogLevel, number>> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	fatal: 4,
};

const validLogLevels = new Set<LogLevelSetting>(['debug', 'info', 'warn', 'error', 'fatal', 'off']);
const validAccessStatusClasses = new Set<AccessLogStatusClass>(['2xx', '3xx', '4xx', '5xx']);
const defaultAccessBodyMaxBytes = 16 * 1024;
const maxAccessBodyBytes = 128 * 1024;

function validateLogLevel(value: unknown, path: string): LogLevelSetting | undefined {
	if (typeof value === 'undefined') return undefined;
	if (typeof value !== 'string' || !validLogLevels.has(value as LogLevelSetting)) {
		throw new Error(`${path} must be one of debug, info, warn, error, fatal, or off`);
	}
	return value as LogLevelSetting;
}

function validateDomainName(domain: string): void {
	if (domain.length === 0 || domain.trim() !== domain || domain.split('.').some(segment => segment.length === 0)) {
		throw new Error(`logging.domains contains an invalid domain name: ${JSON.stringify(domain)}`);
	}
}

function createDisabledAccessLogConfiguration(): ResolvedAccessLogConfiguration {
	return {
		statusClasses: [],
		bodies: {
			request: false,
			response: false,
			maxBytes: defaultAccessBodyMaxBytes,
		},
	};
}

function resolveAccessConfiguration(configuration: unknown, nodeEnv: string | undefined): {
	readonly access: ResolvedAccessLogConfiguration;
	readonly warnings: readonly string[];
} {
	if (configuration == null) return { access: createDisabledAccessLogConfiguration(), warnings: [] };
	if (typeof configuration !== 'object' || Array.isArray(configuration)) {
		throw new Error('logging.access must be an object');
	}

	const raw = configuration as {
		statusClasses?: unknown;
		bodies?: unknown;
	};
	let statusClasses: AccessLogStatusClass[] = [];
	if (typeof raw.statusClasses !== 'undefined') {
		if (!Array.isArray(raw.statusClasses)) {
			throw new Error('logging.access.statusClasses must be an array');
		}
		statusClasses = [...new Set(raw.statusClasses.map((statusClass, index) => {
			if (typeof statusClass !== 'string' || !validAccessStatusClasses.has(statusClass as AccessLogStatusClass)) {
				throw new Error(`logging.access.statusClasses[${index}] must be one of 2xx, 3xx, 4xx, or 5xx`);
			}
			return statusClass as AccessLogStatusClass;
		}))];
	}

	let request = false;
	let response = false;
	let maxBytes = defaultAccessBodyMaxBytes;
	if (typeof raw.bodies !== 'undefined') {
		if (typeof raw.bodies !== 'object' || raw.bodies === null || Array.isArray(raw.bodies)) {
			throw new Error('logging.access.bodies must be an object');
		}
		const bodies = raw.bodies as { request?: unknown; response?: unknown; maxBytes?: unknown };
		if (typeof bodies.request !== 'undefined' && typeof bodies.request !== 'boolean') {
			throw new Error('logging.access.bodies.request must be a boolean');
		}
		if (typeof bodies.response !== 'undefined' && typeof bodies.response !== 'boolean') {
			throw new Error('logging.access.bodies.response must be a boolean');
		}
		const configuredMaxBytes = bodies.maxBytes;
		if (typeof configuredMaxBytes !== 'undefined' && (typeof configuredMaxBytes !== 'number' || !Number.isSafeInteger(configuredMaxBytes) || configuredMaxBytes <= 0 || configuredMaxBytes > maxAccessBodyBytes)) {
			throw new Error(`logging.access.bodies.maxBytes must be a positive integer no greater than ${maxAccessBodyBytes}`);
		}
		request = bodies.request ?? false;
		response = bodies.response ?? false;
		maxBytes = typeof configuredMaxBytes === 'number' ? configuredMaxBytes : defaultAccessBodyMaxBytes;
	}

	if (nodeEnv === 'production' && (request || response)) {
		return {
			access: {
				statusClasses,
				bodies: { request: false, response: false, maxBytes },
			},
			warnings: ['logging.access.bodies is disabled in production mode'],
		};
	}

	return {
		access: { statusClasses, bodies: { request, response, maxBytes } },
		warnings: [],
	};
}

function resolveConfiguration(configuration: LogManagerConfiguration | undefined, nodeEnv: string | undefined): {
	readonly level: LogLevelSetting | undefined;
	readonly domains: readonly (readonly [string, LogLevelSetting])[];
	readonly access: ResolvedAccessLogConfiguration;
	readonly warnings: readonly string[];
} {
	if (configuration == null) return { level: undefined, domains: [], access: createDisabledAccessLogConfiguration(), warnings: [] };

	const level = validateLogLevel(configuration.level, 'logging.level');
	const access = resolveAccessConfiguration(configuration.access, nodeEnv);
	if (configuration.domains == null) return { level, domains: [], ...access };
	if (typeof configuration.domains !== 'object' || configuration.domains === null || Array.isArray(configuration.domains)) {
		throw new Error('logging.domains must be an object');
	}

	const domains = Object.entries(configuration.domains).map(([domain, value]) => {
		validateDomainName(domain);
		const level = validateLogLevel(value, `logging.domains.${domain}`);
		if (typeof level === 'undefined') {
			throw new Error(`logging.domains.${domain} must be configured`);
		}
		return [domain, level] as const;
	}).sort((left, right) => right[0].length - left[0].length);

	return { level, domains, ...access };
}

const defaultDependencies: LogManagerDependencies = {
	now: () => new Date(),
	getProcessInfo: () => ({
		processId: process.pid,
		isPrimary: cluster.isPrimary,
		workerId: cluster.isPrimary ? null : (cluster.worker?.id ?? null),
	}),
	isQuiet: () => envOption.quiet,
	isVerbose: () => envOption.verbose,
	getNodeEnv: () => process.env.NODE_ENV,
};

export class LogManager {
	private backend: LogBackend;
	private readonly dependencies: LogManagerDependencies;
	private normalizationProfile: LogNormalizationProfile;
	private traceContextProvider: LogTraceContextProvider | undefined;
	private configuredLevel: LogLevelSetting | undefined;
	private configuredDomains: readonly (readonly [string, LogLevelSetting])[];
	private accessConfiguration: ResolvedAccessLogConfiguration;
	private shutdownPromise: Promise<void> | undefined;

	constructor(
		backend: LogBackend,
		dependencies: Partial<LogManagerDependencies> = {},
		options: LogManagerOptions = {},
	) {
		this.backend = backend;
		this.dependencies = {
			...defaultDependencies,
			...dependencies,
		};
		this.normalizationProfile = options.normalizationProfile ?? 'standard';
		this.traceContextProvider = undefined;
		this.configuredLevel = undefined;
		this.configuredDomains = [];
		this.accessConfiguration = createDisabledAccessLogConfiguration();
	}

	public setBackend(backend: LogBackend): void {
		this.backend = backend;
	}

	public configure(configuration?: LogManagerConfiguration): readonly string[] {
		const resolved = resolveConfiguration(configuration, this.dependencies.getNodeEnv());
		this.configuredLevel = resolved.level;
		this.configuredDomains = resolved.domains;
		this.accessConfiguration = resolved.access;
		return resolved.warnings;
	}

	public getAccessLogConfiguration(): ResolvedAccessLogConfiguration {
		return this.accessConfiguration;
	}

	public setNormalizationProfile(profile: LogNormalizationProfile): void {
		this.normalizationProfile = profile;
	}

	public setTraceContextProvider(provider?: LogTraceContextProvider): void {
		this.traceContextProvider = provider;
	}

	public getActiveTraceContext(): LogTraceContext | undefined {
		return this.traceContextProvider?.();
	}

	public shutdown(): Promise<void> {
		if (this.shutdownPromise != null) return this.shutdownPromise;

		this.shutdownPromise = (async () => {
			try {
				await this.backend.flush?.();
			} finally {
				await this.backend.close?.();
			}
		})();

		return this.shutdownPromise;
	}

	private getDefaultLevel(): LogLevel {
		if (this.dependencies.isVerbose()) return 'debug';
		return this.dependencies.getNodeEnv() === 'production' ? 'info' : 'debug';
	}

	private getThreshold(loggerName: string): LogLevelSetting {
		let threshold: LogLevelSetting | undefined;
		for (const [domain, level] of this.configuredDomains) {
			if (loggerName === domain || loggerName.startsWith(`${domain}.`)) {
				threshold = level;
				break;
			}
		}

		threshold ??= this.configuredLevel ?? this.getDefaultLevel();

		return threshold === 'off' || !this.dependencies.isVerbose() ? threshold : 'debug';
	}

	private shouldWrite(input: LogRecordInput, loggerName: string): boolean {
		const threshold = this.getThreshold(loggerName);
		if (threshold === 'off') return false;
		return logLevelOrder[input.level] >= logLevelOrder[threshold];
	}

	public write(input: LogRecordInput): void {
		if (this.dependencies.isQuiet()) return;

		const loggerName = input.context.map(segment => segment.name).join('.');
		if (!this.shouldWrite(input, loggerName)) return;

		const processInfo = this.dependencies.getProcessInfo();
		const context = [...input.context];
		const { attributes, error: inputError, ...inputWithoutStructuredValues } = input;
		const normalizedAttributes = typeof attributes !== 'undefined'
			? normalizeLogAttributes(attributes, { profile: this.normalizationProfile })
			: undefined;
		const error = inputError ?? findLegacyLogError(input.compatibility?.data);
		const normalizedError = typeof error !== 'undefined'
			? serializeLogError(error, { profile: this.normalizationProfile })
			: undefined;
		const traceContext = this.traceContextProvider?.();
		const record = {
			...inputWithoutStructuredValues,
			context,
			timestamp: this.dependencies.now().toISOString(),
			loggerName,
			processId: processInfo.processId,
			isPrimary: processInfo.isPrimary,
			workerId: processInfo.workerId,
			...(traceContext ?? {}),
			...(normalizedAttributes ? { attributes: normalizedAttributes } : {}),
			...(normalizedError ? { error: normalizedError } : {}),
		} as LogRecord;

		this.backend.write(record);
	}

	public shouldWriteAccess(statusCode: number): boolean {
		if (this.dependencies.isQuiet()) return false;
		const statusClass = `${Math.floor(statusCode / 100)}xx` as AccessLogStatusClass;
		return validAccessStatusClasses.has(statusClass) && this.accessConfiguration.statusClasses.includes(statusClass);
	}

	public isAccessLogEnabled(): boolean {
		return !this.dependencies.isQuiet() && this.accessConfiguration.statusClasses.length > 0;
	}

	public writeAccess(input: AccessLogRecordInput): void {
		if (!this.shouldWriteAccess(input.statusCode)) return;

		const processInfo = this.dependencies.getProcessInfo();
		const { requestBody, responseBody, traceContext, ...inputWithoutOptionalValues } = input;
		const bodyOptions = {
			profile: this.normalizationProfile,
			limits: { maxBytes: this.accessConfiguration.bodies.maxBytes },
		} as const;
		const normalizedRequestBody = this.accessConfiguration.bodies.request && typeof requestBody !== 'undefined'
			? normalizeLogValue(requestBody, bodyOptions)
			: undefined;
		const normalizedResponseBody = this.accessConfiguration.bodies.response && typeof responseBody !== 'undefined'
			? normalizeLogValue(responseBody, bodyOptions)
			: undefined;
		const resolvedTraceContext = traceContext;
		const record: AccessLogRecord = {
			type: 'access',
			...inputWithoutOptionalValues,
			timestamp: this.dependencies.now().toISOString(),
			processId: processInfo.processId,
			isPrimary: processInfo.isPrimary,
			workerId: processInfo.workerId,
			...(typeof normalizedRequestBody !== 'undefined' ? { requestBody: normalizedRequestBody } : {}),
			...(typeof normalizedResponseBody !== 'undefined' ? { responseBody: normalizedResponseBody } : {}),
			...(resolvedTraceContext ?? {}),
		};

		this.backend.writeAccess?.(record);
	}
}
