/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { apiUrl } from '@@/js/config.js';
import type { App } from 'vue';
import type * as Misskey from 'misskey-js';

const PEER_IDENTIFYING_HEADER_SNIPPETS = ['forwarded', '-ip', 'remote-', 'via', '-user'];

export async function initTelemetry(instance: Misskey.entities.MetaDetailed, app: App): Promise<void> {
	if (!instance.sentryForFrontend) return;

	const Sentry = await import('@sentry/vue');

	Sentry.init({
		app,
		integrations: [
			...(instance.sentryForFrontend.vueIntegration !== undefined ? [
				Sentry.vueIntegration(instance.sentryForFrontend.vueIntegration ?? undefined),
			] : []),
			...(instance.sentryForFrontend.browserTracingIntegration !== undefined ? [
				Sentry.browserTracingIntegration(instance.sentryForFrontend.browserTracingIntegration ?? undefined),
			] : []),
			...(instance.sentryForFrontend.replayIntegration !== undefined ? [
				Sentry.replayIntegration(instance.sentryForFrontend.replayIntegration ?? undefined),
			] : []),
		],

		tracesSampleRate: 1.0,

		...(instance.sentryForFrontend.browserTracingIntegration !== undefined ? {
			tracePropagationTargets: [apiUrl],
		} : {}),

		...(instance.sentryForFrontend.replayIntegration !== undefined ? {
			replaysSessionSampleRate: 0.1,
			replaysOnErrorSampleRate: 1.0,
		} : {}),

		dataCollection: {
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
		},

		...instance.sentryForFrontend.options,
	});
}
