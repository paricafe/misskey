/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import cluster from 'node:cluster';
import chalk from 'chalk';
import chalkTemplate from 'chalk-template';
import Logger from '@/logger.js';
import { loadConfig } from '@/config.js';
import type { Config } from '@/config.js';
import { configureLogging, shutdownLogging } from '@/logging/logging-runtime.js';
import type { LogFormat } from '@/logging/types.js';
import { showMachineInfo } from '@/misc/show-machine-info.js';
import { envOption } from '@/env.js';
import { initTelemetry, shutdownTelemetry } from '@/core/telemetry/telemetry-registry.js';
import { initExtraThreadPool, jobQueue, server, serverAndQueue } from './common.js';
import { installShutdownSignalHandlers, isShutdownInProgress } from './shutdown-handler.js';
import { shutdownApplications } from './application-lifecycle.js';
import { forceStopClusterWorkers, shutdownClusterWorkers } from './cluster-shutdown.js';
import { superviseWorker } from './worker-supervisor.js';
import { prepareUnixSocket } from './unix-socket.js';

const logger = new Logger('core', 'cyan');
const bootLogger = logger.createSubLogger('boot', 'magenta');

const themeColor = chalk.hex('#f7c3de');

function greet(props: { version: string; format: LogFormat }) {
	if (!envOption.quiet && props.format === 'json') {
		bootLogger.info('Welcome to Misskey!');
		bootLogger.info(`Misskey v${props.version}`, null, true);
		bootLogger.info('Misskey is an open-source decentralized microblogging platform.');
		bootLogger.info('If you like Misskey, please consider donating to support dev. https://misskey-hub.net/docs/donate/');
		return;
	}

	if (!envOption.quiet) {
		const v = `v${props.version}`;
		console.log(themeColor('  _____ _         _           '));
		console.log(themeColor(' |     |_|___ ___| |_ ___ _ _ '));
		console.log(themeColor(' | | | | |_ -|_ -| \'_| -_| | |'));
		console.log(themeColor(' |_|_|_|_|___|___|_,_|___|_  |'));
		console.log(' ' + chalk.gray(v) + themeColor('                        |___|\n'.substring(v.length)));

		console.log(' Misskey is an open-source decentralized microblogging platform.');
		console.log(chalk.rgb(255, 136, 0)(' If you like Misskey, please consider donating to support dev. https://misskey-hub.net/docs/donate/'));

		console.log('');
		console.log(chalkTemplate`--- ${os.hostname()} {gray (PID: ${process.pid.toString()})} ---`);
	}

	bootLogger.info('Welcome to Misskey!');
	bootLogger.info(`Misskey v${props.version}`, null, true);
}

export async function masterMain() {
	let config!: Config;

	try {
		config = loadConfigBoot();
		logger.info(`Start main process... pid: ${process.pid}`);
		bootLogger.createSubLogger('config').succ('Loaded');
		greet({ version: config.version, format: config.logging?.format ?? 'pretty' });
		showEnvironment();
		await showMachineInfo(bootLogger);
		showNodejsVersion();
		if (config.pidFile) fs.writeFileSync(config.pidFile, process.pid.toString());
	} catch (e) {
		bootLogger.error('Fatal error occurred during initialization: ' + e, null, true);
		process.exit(1);
	}

	bootLogger.succ('Misskey initialized');

	initExtraThreadPool(config);

	try {
		await initTelemetry(config);
	} catch (e) {
		bootLogger.error(e instanceof Error ? e : new Error(String(e)), null, true);
		process.exit(1);
	}
	installShutdownSignalHandlers({
		shutdownTasks: [async () => {
			const results = await Promise.allSettled([shutdownApplications(), shutdownClusterWorkers()]);
			const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
			if (errors.length > 0) throw new AggregateError(errors, 'Application shutdown failed');
		}],
		finalizeTasks: [shutdownTelemetry, shutdownLogging],
		onTimeout: forceStopClusterWorkers,
		onRegistered: message => bootLogger.info(message),
	});

	bootLogger.info(
		`mode: [disableClustering: ${envOption.disableClustering}, onlyServer: ${envOption.onlyServer}, onlyQueue: ${envOption.onlyQueue}]`,
	);

	if (!envOption.disableClustering) {
		if (envOption.onlyServer) {
			if (config.socket) await prepareUnixSocket(config.socket);
		} else if (envOption.onlyQueue) {
			await jobQueue();
		} else {
			await server();
		}

		await spawnWorkers(config.clusterLimit);
	} else {
		if (envOption.onlyServer) {
			await server();
		} else if (envOption.onlyQueue) {
			await jobQueue();
		} else {
			await serverAndQueue();
		}
	}

	if (envOption.onlyQueue) {
		bootLogger.succ('Queue started', null, true);
	} else {
		bootLogger.succ(config.socket ? `Now listening on socket ${config.socket} on ${config.url}` : `Now listening on port ${config.port} on ${config.url}`, null, true);
	}
}

function showEnvironment(): void {
	const env = process.env.NODE_ENV;
	const logger = bootLogger.createSubLogger('env');
	logger.info(typeof env === 'undefined' ? 'NODE_ENV is not set' : `NODE_ENV: ${env}`);

	if (env !== 'production') {
		logger.warn('The environment is not in production mode.');
		logger.warn('DO NOT USE FOR PRODUCTION PURPOSE!', null, true);
	}
}

function showNodejsVersion(): void {
	const nodejsLogger = bootLogger.createSubLogger('nodejs');

	nodejsLogger.info(`Version ${process.version} detected.`);
}

function loadConfigBoot(): Config {
	const configLogger = bootLogger.createSubLogger('config');
	let config;

	try {
		config = loadConfig();
		configureLogging(config.logging);
	} catch (exception) {
		if (typeof exception === 'string') {
			configLogger.error(exception);
			process.exit(1);
		} else if ((exception as any).code === 'ENOENT') {
			configLogger.error('Configuration file not found', null, true);
			process.exit(1);
		}
		throw exception;
	}

	return config;
}

async function spawnWorkers(limit = 1) {
	if (isShutdownInProgress()) return;
	const workers = Math.min(limit, os.cpus().length);
	bootLogger.info(`Starting ${workers} worker${workers === 1 ? '' : 's'}...`);
	await Promise.all([...Array(workers)].map(spawnWorker));
	bootLogger.succ('All workers started');
}

function spawnWorker(): Promise<void> {
	return superviseWorker({
		fork: () => cluster.fork(),
		isStopping: isShutdownInProgress,
		onRestart: (workerId, delayMs) => bootLogger.error(`Worker ${workerId} exited; restarting in ${delayMs}ms.`),
		onFatal: error => {
			bootLogger.error(error);
			process.exit(1);
		},
	});
}
