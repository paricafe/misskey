/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { LogTraceContext } from '@/logging/types.js';
import type * as SentryNode from '@sentry/node';
import type { NodeOptions } from '@sentry/node';
import type { SentryBackendConfig, TelemetryAdapter, TelemetryCaptureMessageOptions } from './TelemetryAdapter.js';

const DEFAULT_SHUTDOWN_TIMEOUT = 5000;

type SentryIntegrationsOption = NonNullable<NodeOptions['integrations']>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SentryIntegrationFactory = Extract<SentryIntegrationsOption, (integrations: any[]) => any[]>;
type SentryIntegration = Parameters<SentryIntegrationFactory>[0][number];
type SentryNodeOptions = NodeOptions;
type SentryDataCollection = NonNullable<NodeOptions['dataCollection']>;

const PEER_IDENTIFYING_HEADER_SNIPPETS = ['forwarded', '-ip', 'remote-', 'via', '-user'];

export const DEFAULT_SENTRY_DATA_COLLECTION: SentryDataCollection = {
	userInfo: false,
	cookies: false,
	urlQueryParams: false,
	httpHeaders: {
		request: { deny: PEER_IDENTIFYING_HEADER_SNIPPETS },
		response: { deny: PEER_IDENTIFYING_HEADER_SNIPPETS },
	},
	httpBodies: [],
	databaseQueryData: false,
	genAI: { inputs: false, outputs: false },
};

type BuildSentryIntegrationsOptions = {
	disabledIntegrations?: string[];
	enableNodeProfiling: boolean;
	nodeProfilingIntegration?: () => SentryIntegration;
	warn?: (message: string) => void;
};

export function buildSentryIntegrations(options: BuildSentryIntegrationsOptions): SentryIntegrationFactory {
	return (defaults) => {
		const disabledIntegrations = new Set(options.disabledIntegrations ?? []);
		const defaultIntegrationNames = new Set(defaults.map((integration) => integration.name));
		const unknownIntegrations = [...disabledIntegrations].filter((name) => !defaultIntegrationNames.has(name));

		if (unknownIntegrations.length > 0) {
			(options.warn ?? console.warn)(`Unknown Sentry integration configured in sentryForBackend.disabledIntegrations: ${unknownIntegrations.join(', ')}`);
		}

		return [
			...defaults.filter((integration) => !disabledIntegrations.has(integration.name)),
			...(options.enableNodeProfiling && options.nodeProfilingIntegration != null ? [options.nodeProfilingIntegration()] : []),
		];
	};
}

export function buildSentryNodeOptions(
	config: SentryBackendConfig,
	nodeProfilingIntegration?: () => SentryIntegration,
	warn?: (message: string) => void,
): SentryNodeOptions {
	if ('sendDefaultPii' in config.options) {
		(warn ?? console.warn)('sentryForBackend.options.sendDefaultPii was removed in Sentry SDK v11 and is ignored. Use sentryForBackend.options.dataCollection instead (`dataCollection: {}` collects everything, as `sendDefaultPii: true` did).');
	}

	return {
		tracePropagationTargets: [],

		tracesSampleRate: 1.0,

		profileSessionSampleRate: 1.0,
		profileLifecycle: 'trace',

		maxBreadcrumbs: 0,

		dataCollection: DEFAULT_SENTRY_DATA_COLLECTION,

		...config.options,

		integrations: buildSentryIntegrations({
			disabledIntegrations: config.disabledIntegrations,
			enableNodeProfiling: config.enableNodeProfiling,
			nodeProfilingIntegration,
			warn,
		}),
	};
}

export class SentryTelemetryAdapter implements TelemetryAdapter {
	private constructor(
		private readonly Sentry: typeof SentryNode,
	) {
	}

	public static async create(config: SentryBackendConfig, warn?: (message: string) => void): Promise<SentryTelemetryAdapter> {
		const Sentry = await import('@sentry/node');
		const { nodeProfilingIntegration } = await import('@sentry/profiling-node');

		Sentry.init(buildSentryNodeOptions(config, nodeProfilingIntegration, warn));

		return new SentryTelemetryAdapter(Sentry);
	}

	public captureMessage(message: string, opts: TelemetryCaptureMessageOptions): void {
		this.Sentry.captureMessage(message, {
			level: opts.level,
			...(opts.userId != null ? { user: { id: opts.userId } } : {}),
			extra: opts.extra,
		});
	}

	public getActiveTraceContext(): LogTraceContext | undefined {
		const activeSpan = this.Sentry.getActiveSpan();
		if (activeSpan == null) return undefined;

		const { traceId, spanId, traceFlags } = activeSpan.spanContext();
		return { traceId, spanId, traceFlags };
	}

	public startSpan<T>(name: string, fn: () => T): T {
		return this.Sentry.startSpan({ name }, fn);
	}

	public async shutdown(): Promise<void> {
		await this.Sentry.close(DEFAULT_SHUTDOWN_TIMEOUT);
	}
}
