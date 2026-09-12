/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import cluster from 'node:cluster';

export async function shutdownClusterWorkers(): Promise<void> {
	const workers = Object.values(cluster.workers ?? {}).filter(worker => worker != null);
	const results = await Promise.allSettled(workers.map(worker => new Promise<void>((resolve, reject) => {
		if (worker.isDead()) return resolve();
		const onExit = (code: number, signal: string) => {
			if (code === 0 && !signal) resolve();
			else reject(new Error(`Worker ${worker.id} failed to shut down cleanly (${signal || code})`));
		};
		worker.once('exit', onExit);
		// Worker.kill() disconnects IPC first. Send the signal to the child process
		// directly so it can drain while the primary stays alive and awaits exit.
		try {
			worker.process.kill('SIGTERM');
		} catch (error) {
			worker.off('exit', onExit);
			reject(error);
		}
	})));
	const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
	if (errors.length > 0) throw new AggregateError(errors, 'Cluster workers failed to shut down cleanly');
}

export function forceStopClusterWorkers(): void {
	for (const worker of Object.values(cluster.workers ?? {})) {
		if (worker && !worker.isDead()) worker.process.kill('SIGKILL');
	}
}
