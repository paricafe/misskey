/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Worker } from 'node:cluster';

const INITIAL_RESTART_DELAY_MS = 1_000;
const MAX_RESTART_DELAY_MS = 30_000;
const STABLE_WORKER_MS = 60_000;
const MAX_STARTUP_FAILURES = 5;

type WorkerSupervisorOptions = {
	fork(): Worker;
	isStopping(): boolean;
	onRestart(workerId: number, delayMs: number): void;
	onFatal(error: Error): void;
};

/** One slot owns its initial readiness and every subsequent replacement. */
export function superviseWorker(options: WorkerSupervisorOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		let ready = false;
		let stopped = false;
		let startupFailures = 0;
		let restartDelay = INITIAL_RESTART_DELAY_MS;

		const fail = (error: Error) => {
			stopped = true;
			reject(error);
			options.onFatal(error);
		};

		const spawn = () => {
			if (stopped || options.isStopping()) { resolve(); return; }
			let worker: Worker;
			try {
				worker = options.fork();
			} catch (error) {
				fail(new Error('Failed to fork a worker', { cause: error }));
				return;
			}
			const startedAt = Date.now();
			const onMessage = (message: unknown) => {
				if (stopped || options.isStopping()) return;
				if (message === 'listenFailed') {
					fail(new Error(`Worker ${worker.id} could not listen; see the preceding server error.`));
				} else if (message === 'ready') {
					ready = true;
					resolve();
				}
			};
			worker.on('message', onMessage);
			worker.once('exit', () => {
				worker.off('message', onMessage);
				if (stopped || options.isStopping()) { resolve(); return; }
				if (!ready && ++startupFailures >= MAX_STARTUP_FAILURES) {
					fail(new Error(`Worker startup failed ${startupFailures} times before becoming ready.`));
					return;
				}
				if (Date.now() - startedAt >= STABLE_WORKER_MS) restartDelay = INITIAL_RESTART_DELAY_MS;
				options.onRestart(worker.id, restartDelay);
				setTimeout(spawn, restartDelay);
				restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY_MS);
			});
		};
		spawn();
	});
}
