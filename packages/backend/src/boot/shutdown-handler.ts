/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readyRef } from './ready.js';

type ShutdownSignalProcess = {
	on(event: 'SIGTERM' | 'SIGINT', listener: () => Promise<void>): unknown;
};

const SHUTDOWN_TIMEOUT_MS = 10_000;
const FINALIZATION_TIMEOUT_MS = 2_000;

export type ShutdownTask = () => Promise<void>;

export type ShutdownHandlerOptions = {
	process?: ShutdownSignalProcess;
	shutdownTasks: readonly ShutdownTask[];
	finalizeTasks?: readonly ShutdownTask[];
	timeoutMs?: number;
	onTimeout?: () => void;
	exit?: (code: number) => void;
	onRegistered?: (message: string) => void;
};

let shuttingDown = false;

export function installShutdownSignalHandlers(options: ShutdownHandlerOptions): void {
	const processLike = options.process ?? process;
	const exit = options.exit ?? ((code: number) => process.exit(code));

	const handleSignal = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		readyRef.value = false;

		let failed = false;
		const runTasks = async (tasks: readonly ShutdownTask[], timeoutMs: number) => {
			let timedOut = false;
			let timeout: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					(async () => {
						for (const shutdownTask of tasks) {
							if (timedOut) return;
							try {
								await shutdownTask();
							} catch (error) {
								failed = true;
								try {
									console.error('Shutdown task failed:', error);
								} catch {
								}
							}
						}
					})(),
					new Promise<void>(resolve => {
						timeout = setTimeout(() => {
							timedOut = true;
							failed = true;
							try {
								console.error(`Shutdown tasks timed out after ${timeoutMs}ms.`);
							} catch {
							}
							try {
								options.onTimeout?.();
							} catch {
							}
							resolve();
						}, timeoutMs);
					}),
				]);
			} finally {
				if (timeout != null) clearTimeout(timeout);
			}
		};
		const finalizers = options.finalizeTasks ?? [];
		await runTasks(options.shutdownTasks, (options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS) - (finalizers.length > 0 ? FINALIZATION_TIMEOUT_MS : 0));
		if (finalizers.length > 0) await runTasks(finalizers, FINALIZATION_TIMEOUT_MS);

		exit(failed ? 1 : 0);
	};

	processLike.on('SIGTERM', handleSignal);
	processLike.on('SIGINT', handleSignal);

	options.onRegistered?.('Registered coordinated SIGTERM/SIGINT graceful shutdown handler.');
}

export function isShutdownInProgress(): boolean {
	return shuttingDown;
}
