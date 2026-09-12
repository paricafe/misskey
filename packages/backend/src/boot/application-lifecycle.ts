/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isShutdownInProgress } from './shutdown-handler.js';

type ManagedApplication = {
	drain(): Promise<void>;
	close(): Promise<void>;
};

const applications = new Set<Promise<ManagedApplication>>();
let shutdown: Promise<void> | undefined;

/** Track initialization too, so a signal during startup cannot orphan a context. */
export function manageApplication<T extends ManagedApplication>(initialize: () => Promise<T>): Promise<T> {
	if (isShutdownInProgress()) throw new Error('Cannot start an application during shutdown');
	const application = initialize();
	applications.add(application);
	return application;
}

export function shutdownApplications(): Promise<void> {
	shutdown ??= (async () => {
		const running: ManagedApplication[] = [];
		// Every context must stop accepting work before any context releases its
		// dependencies. In non-cluster mode the HTTP and queue contexts coexist.
		const drained = await Promise.allSettled([...applications].map(async initializing => {
			const application = await initializing;
			running.push(application);
			await application.drain();
		}));
		const closed = await Promise.allSettled(running.map(application => application.close()));
		const errors = [...drained, ...closed].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
		if (errors.length > 0) throw new AggregateError(errors, 'Application shutdown failed');
	})();
	return shutdown;
}
