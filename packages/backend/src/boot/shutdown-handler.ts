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
	/** The process-like object that receives the signal handlers. */
	process?: ShutdownSignalProcess;
	/** Shutdown tasks, executed in array order. */
	shutdownTasks: readonly ShutdownTask[];
	/** Final flushes, given a reserved deadline even when draining times out. */
	finalizeTasks?: readonly ShutdownTask[];
	/** Workers reserve time for their primary to observe exit and flush its logs. */
	timeoutMs?: number;
	/** Last-resort cleanup of child processes when draining exceeds its deadline. */
	onTimeout?: () => void;
	/** Process termination function. */
	exit?: (code: number) => void;
	/** Optional boot logger hook used after signal handlers are registered. */
	onRegistered?: (message: string) => void;
};

let shuttingDown = false;

/**
 * Register the process-level shutdown signals.
 *
 * Boot owns signal coordination and receives shutdown tasks through callbacks
 * so individual domains do not depend on each other.
 *
 * Boot closes its registered Nest contexts explicitly. Do not additionally call
 * enableShutdownHooks(): that would race this coordinated shutdown sequence.
 */
export function installShutdownSignalHandlers(options: ShutdownHandlerOptions): void {
	// テストではprocess/exitを差し替え、本番では実processにSIGTERM/SIGINT handlerを登録する。
	const processLike = options.process ?? process;
	const exit = options.exit ?? ((code: number) => process.exit(code));

	const handleSignal = async () => {
		// 同時に複数signalが来てもflushを二重実行せず、cluster refork抑止用の状態もここで立てる。
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
								// 1つの終了処理の失敗で後続タスクを妨げないよう、stderrへフォールバックする。
								try {
									console.error('Shutdown task failed:', error);
								} catch {
									// stderrの出力自体が失敗しても、残りの終了処理とexitは継続する。
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
								// stderrの出力自体が失敗してもexitは継続する。
							}
							try {
								options.onTimeout?.();
							} catch {
								// Last-resort cleanup must not prevent the final exit.
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

		// 既存挙動と同じく、終了処理後はプロセスを終了する。
		exit(failed ? 1 : 0);
	};

	// Keep listeners installed: a process-group signal and the primary's forwarded
	// signal can reach the same worker while its first shutdown is still draining.
	processLike.on('SIGTERM', handleSignal);
	processLike.on('SIGINT', handleSignal);

	options.onRegistered?.('Registered coordinated SIGTERM/SIGINT graceful shutdown handler.');
}

export function isShutdownInProgress(): boolean {
	// masterのcluster exit handlerが、意図したshutdown中のworker終了を再forkしないために参照する。
	return shuttingDown;
}
