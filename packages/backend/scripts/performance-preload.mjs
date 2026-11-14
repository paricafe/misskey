/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import cluster from 'node:cluster';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

const intervalMs = Number(process.env.MK_PERFORMANCE_INTERVAL_MS ?? 5000);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 2 ** 31 - 1) {
	throw new Error('MK_PERFORMANCE_INTERVAL_MS must be a positive timer interval');
}

function role() {
	const onlyServer = Boolean(process.env.MK_ONLY_SERVER);
	const onlyQueue = Boolean(process.env.MK_ONLY_QUEUE);
	const noCluster = Boolean(process.env.MK_DISABLE_CLUSTERING) || process.env.NODE_ENV === 'test';
	if (!cluster.isPrimary) return onlyServer ? 'server' : 'queue';
	if (onlyServer) return noCluster ? 'server' : 'supervisor';
	if (onlyQueue) return 'queue';
	return noCluster ? 'server+queue' : 'server';
}

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let previousTime = performance.now();
let previousCpu = process.cpuUsage();
let previousUtilization = performance.eventLoopUtilization();
let gcCount = 0;
let gcDurationMs = 0;
const observer = new PerformanceObserver(list => {
	for (const entry of list.getEntries()) {
		gcCount++;
		gcDurationMs += entry.duration;
	}
});
observer.observe({ entryTypes: ['gc'] });

const timer = setInterval(() => {
	const now = performance.now();
	const elapsedMs = now - previousTime;
	const cpu = process.cpuUsage();
	const utilization = performance.eventLoopUtilization();
	process.stderr.write(JSON.stringify({
		type: 'performance',
		timestamp: new Date().toISOString(),
		pid: process.pid,
		role: role(),
		intervalMs: elapsedMs,
		cpuPercent: ((cpu.user - previousCpu.user) + (cpu.system - previousCpu.system)) / (elapsedMs * 10),
		memory: process.memoryUsage(),
		eventLoopUtilization: performance.eventLoopUtilization(utilization, previousUtilization).utilization,
		eventLoopDelayP95Ms: delay.count > 0 ? delay.percentile(95) / 1e6 : null,
		eventLoopDelayMaxMs: delay.count > 0 ? delay.max / 1e6 : null,
		gc: { count: gcCount, durationMs: gcDurationMs },
	}) + '\n');
	previousTime = now;
	previousCpu = cpu;
	previousUtilization = utilization;
	gcCount = 0;
	gcDurationMs = 0;
	delay.reset();
}, intervalMs);
timer.unref();

process.once('exit', () => {
	clearInterval(timer);
	observer.disconnect();
	delay.disable();
});
