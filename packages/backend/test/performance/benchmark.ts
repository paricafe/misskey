/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { Client } from 'pg';
import { WebSocket } from 'ws';
import { loadConfig } from '@/config.js';
import { StreamingApiServerService } from '@/server/api/StreamingApiServerService.js';
import { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import { FanoutTimelineEndpointService } from '@/core/FanoutTimelineEndpointService.js';
import { IdService } from '@/core/IdService.js';
import { configureLogging } from '@/logging/logging-runtime.js';
import * as boot from '@/boot/common.js';
import { shutdownApplications } from '@/boot/application-lifecycle.js';
import { DI } from '@/di-symbols.js';
import { QueueService } from '@/core/QueueService.js';
import { envOption } from '@/env.js';
import type { INestApplicationContext } from '@nestjs/common';
import type { MiNote } from '@/models/Note.js';
import type { DataSource } from 'typeorm';
import type { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver.js';
import type { Pool } from 'pg';

type Options = {
	scenario: 'streaming' | 'timeline' | 'application';
	samples: string;
	size: string;
	iterations: string;
	role: 'server' | 'queue' | 'split' | 'combined';
	output?: string;
	'source-ref'?: string;
};

const options = JSON.parse(process.argv[2]) as Options;
const samples = Number(options.samples);
const size = Number(options.size);
const iterations = Number(options.iterations);
const config = loadConfig();
envOption.quiet = false;
configureLogging({ level: 'error' });

function percentile(values: number[], fraction: number) {
	return [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

async function measure(run: () => Promise<void>) {
	const delays = monitorEventLoopDelay({ resolution: 10 });
	const gc = { count: 0, durationMs: 0 };
	const observer = new PerformanceObserver(list => {
		for (const entry of list.getEntries()) {
			gc.count++;
			gc.durationMs += entry.duration;
		}
	});
	global.gc?.();
	const before = process.memoryUsage();
	delays.enable();
	observer.observe({ entryTypes: ['gc'] });
	await setTimeout(20);
	delays.reset();
	const utilization = performance.eventLoopUtilization();
	const cpu = process.cpuUsage();
	const started = performance.now();
	try {
		await run();
		const durationMs = performance.now() - started;
		const cpuUsed = process.cpuUsage(cpu);
		const loop = performance.eventLoopUtilization(utilization);
		await setImmediate();
		return {
			durationMs,
			cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
			eventLoopUtilization: loop.utilization,
			eventLoopDelayP95Ms: delays.count > 0 ? delays.percentile(95) / 1e6 : null,
			gc,
			memoryBefore: before,
			memoryAfter: process.memoryUsage(),
		};
	} finally {
		delays.disable();
		observer.disconnect();
	}
}

async function repeat(run: () => Promise<void>) {
	await run();
	const measurements = [];
	for (let sample = 0; sample < samples; sample++) measurements.push(await measure(run));
	return { medianMs: percentile(measurements.map(m => m.durationMs), 0.5), measurements };
}

async function streaming() {
	const redis = new EventEmitter();
	const clients: WebSocket[] = [];
	let delivered = 0;
	let nextConnection = 0;
	const service = new StreamingApiServerService(redis as never, {
		registerRequestByContextId() {},
		async create() {
			const channel = `benchmark:${nextConnection++}`;
			return {
				async init() {},
				async listen(subscriber: EventEmitter) {
					subscriber.on(channel, () => { delivered++; });
					subscriber.on('broadcast', () => { delivered++; });
				},
				dispose() {},
			};
		},
	} as never, { authenticate: async () => [null, null] } as never, {} as never);
	const server = createServer();
	service.attach(server);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	assert(address && typeof address !== 'string');
	try {
		for (let offset = 0; offset < size; offset += 100) {
			await Promise.all(Array.from({ length: Math.min(100, size - offset) }, async () => {
				const client = new WebSocket(`ws://127.0.0.1:${address.port}/streaming`);
				clients.push(client);
				await once(client, 'open');
			}));
		}
		const results: Record<string, unknown> = {};
		for (const channel of ['benchmark:0', 'unsubscribed', 'broadcast']) {
			const payload = JSON.stringify({ channel, message: { type: 'benchmark', body: null } });
			results[channel] = await repeat(async () => {
				delivered = 0;
				for (let index = 0; index < iterations; index++) {
					redis.emit('message', config.host, payload);
					if (index % 100 === 0) await setImmediate();
				}
				assert.equal(delivered, channel === 'broadcast' ? size * iterations : channel === 'unsubscribed' ? 0 : iterations);
			});
		}
		return results;
	} finally {
		await service.detach();
		for (const client of clients) client.terminate();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

async function timeline() {
	assert(['127.0.0.1', 'localhost', '::1'].includes(config.redis.host), 'Use a local test Redis');
	const redis = new Redis({ ...config.redis, keyPrefix: `backend-performance:${process.pid}:` });
	const idService = new IdService(config);
	const service = new FanoutTimelineService(redis, idService);
	const key = 'list:localTimeline';
	const ids = Array.from({ length: size }, (_, index) => idService.gen(Date.now() - index * 1000));
	for (let index = 0; index + 1 < ids.length; index += 7) [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
	const notes = new Map(ids.map(id => [id, {
		id, userId: 'author', userHost: null, renoteUserId: null, replyUserId: null, user: { isSuspended: false },
	} as MiNote]));
	let queryIds: string[] = [];
	const query = {
		where(_condition: string, parameters: { noteIds: string[] }) { queryIds = parameters.noteIds; return query; },
		innerJoinAndSelect() { return query; },
		leftJoinAndSelect() { return query; },
		async getMany() { return queryIds.map(id => notes.get(id)!); },
	};
	const endpoint = new FanoutTimelineEndpointService(
		{ createQueryBuilder: () => query } as never,
		{ blockedHosts: [], ugcVisibilityForVisitor: 'all' } as never,
		{} as never, {} as never, service, { isBlockedHost: () => false } as never, {} as never,
	);
	try {
		for (let offset = 0; offset < ids.length; offset += 1000) await redis.rpush(key, ...ids.slice(offset, offset + 1000));
		const expected = [...new Set(ids)].sort().reverse().slice(0, 20);
		const result = await repeat(async () => {
			for (let index = 0; index < iterations; index++) {
				const page = await endpoint.getMiNotes({
					untilId: null, sinceId: null, limit: 20, allowPartial: false,
					useDbFallback: false, redisTimelines: ['localTimeline'], excludePureRenotes: false, dbFallback: async () => [],
				});
				assert.deepEqual(page.map(note => note.id), expected);
			}
		});
		return { pageSize: 20, ...result };
	} finally {
		await redis.del(key);
		redis.disconnect();
	}
}

async function application() {
	assert.equal(config.db.db, 'test-misskey');
	assert(['127.0.0.1', 'localhost', '::1'].includes(config.db.host), 'Use a local test PostgreSQL');
	assert(['127.0.0.1', 'localhost', '::1'].includes(config.redis.host), 'Use a local test Redis');
	boot.initExtraThreadPool(config);
	const contexts: INestApplicationContext[] = [];
	let poolTimer: NodeJS.Timeout | undefined;
	const started = performance.now();
	try {
		if (options.role === 'combined') {
			const launch = Reflect.get(boot, 'serverAndQueue') as (() => Promise<INestApplicationContext>) | undefined;
			assert(launch, 'This source revision does not support the combined context');
			contexts.push(await launch());
		} else {
			if (options.role !== 'queue') contexts.push(await boot.server());
			if (options.role !== 'server') contexts.push(await boot.jobQueue());
		}
		const startupMs = performance.now() - started;
		const pools = contexts.flatMap(context => {
			const driver = context.get<DataSource>(DI.db).driver as PostgresDriver;
			return [driver.master, ...driver.slaves] as Pool[];
		});
		const poolPeak = { total: 0, inUse: 0, waiting: 0 };
		const samplePools = () => {
			poolPeak.total = Math.max(poolPeak.total, pools.reduce((total, pool) => total + pool.totalCount, 0));
			poolPeak.inUse = Math.max(poolPeak.inUse, pools.reduce((total, pool) => total + pool.totalCount - pool.idleCount, 0));
			poolPeak.waiting = Math.max(poolPeak.waiting, pools.reduce((total, pool) => total + pool.waitingCount, 0));
		};
		samplePools();
		poolTimer = global.setInterval(samplePools, 10);
		poolTimer.unref();
		await setTimeout(200);
		global.gc?.();
		const idleMemory = process.memoryUsage();
		const db = new Client({ host: config.db.host, port: config.db.port, database: config.db.db, user: config.db.user, password: config.db.pass });
		const redis = new Redis(config.redis);
		try {
			await db.connect();
			const databaseConnections = (await db.query('SELECT state, count(*)::int FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() GROUP BY state')).rows;
			const redisClients = Number((await redis.info('clients')).match(/connected_clients:(\d+)/)?.[1]) - 1;
			const queues = [];
			for (const context of contexts) {
				const queue = context.get(QueueService);
				queues.push({ deliver: await queue.deliverQueue.getJobCounts(), inbox: await queue.inboxQueue.getJobCounts() });
			}
			if (options.role === 'queue') return { startupMs, idleMemory, databaseConnections, redisClients, poolPeak, queues };
			const base = `http://127.0.0.1:${config.port}/api/`;

			async function api(endpoint: string, body: object) {
				const response = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
				const data = await response.json();
				assert(response.ok, `Unexpected ${response.status} from ${endpoint}: ${JSON.stringify(data)}`);
				return data;
			}

			const user = await api('signup', { username: 'benchmark', password: 'benchmark-password' });
			assert(user != null && typeof user === 'object' && 'token' in user && typeof user.token === 'string');
			const token = user.token;
			for (let index = 0; index < size; index++) await api('notes/create', { i: token, text: `Benchmark note ${index}` });
			await setTimeout(200);
			const latency: number[] = [];
			let warming = true;
			const workload = await repeat(async () => {
				let next = 0;
				await Promise.all(Array.from({ length: 10 }, async () => {
					while (next++ < iterations) {
						const requestStarted = performance.now();
						const page = await api('notes/local-timeline', { limit: 20 });
						assert(Array.isArray(page));
						assert.equal(page.length, Math.min(20, size));
						if (!warming) latency.push(performance.now() - requestStarted);
					}
				}));
				warming = false;
			});
			return { startupMs, idleMemory, databaseConnections, redisClients, poolPeak, queues, concurrency: 10, requestP95Ms: percentile(latency, 0.95), requestP99Ms: percentile(latency, 0.99), ...workload };
		} finally {
			await db.end();
			redis.disconnect();
		}
	} finally {
		global.clearInterval(poolTimer);
		await shutdownApplications();
	}
}

const scenarios = { streaming, timeline, application };
const result = {
	schemaVersion: 1,
	node: process.version,
	sourceRevision: options['source-ref'] ?? 'working-tree',
	parameters: { scenario: options.scenario, samples, size, iterations, ...(options.scenario === 'application' ? { role: options.role } : {}) },
	results: await scenarios[options.scenario](),
};
const json = JSON.stringify(result, null, 2) + '\n';
if (options.output) await writeFile(options.output, json);
process.stdout.write(json, () => process.exit(0));
