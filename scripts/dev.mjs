/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

/** @type {Set<import('execa').ResultPromise>} */
const childProcesses = new Set();
/** @type {Set<import('execa').ResultPromise>} */
const persistentChildProcesses = new Set();
let shuttingDown = false;
let persistentChildProcessesStarted = false;
let persistentChildProcessFailed = false;
/** @type {Promise<void> | null} */
let shutdownPromise = null;

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('execa').Options} options
 * @returns {import('execa').ResultPromise}
 */
function spawnChildProcess(command, args, options) {
	const isWindows = process.platform === 'win32';
	const shouldForceColor = (process.stdout.isTTY || process.stderr.isTTY)
		&& process.env.FORCE_COLOR == null
		&& process.env.NO_COLOR == null;
	const pnpmPath = _dirname + '/../node_modules/pnpm/bin/pnpm.mjs';
	const windowsCommand = [process.execPath, pnpmPath, ...args]
		.map(argument => `"${argument}"`)
		.join(' ');
	const executable = isWindows && command === 'pnpm' ? process.env.ComSpec ?? 'cmd.exe' : command;
	const executableArgs = isWindows && command === 'pnpm'
		? ['/d', '/s', '/c', `start "" /b /wait ${windowsCommand}`]
		: args;
	const childProcess = execa(executable, executableArgs, isWindows ? {
		...options,
		windowsVerbatimArguments: true,
		windowsHide: false,
		env: shouldForceColor ? { FORCE_COLOR: '1' } : undefined,
		stdout: 'pipe',
		stderr: 'pipe',
		buffer: false,
	} : options);

	if (isWindows) {
		if (options.stdout != null) childProcess.stdout?.pipe(options.stdout, { end: false });
		if (options.stderr != null) childProcess.stderr?.pipe(options.stderr, { end: false });
	}

	childProcesses.add(childProcess);
	return childProcess;
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('execa').Options} options
 * @returns {Promise<import('execa').Result>}
 */
async function runChildProcess(command, args, options) {
	const childProcess = spawnChildProcess(command, args, options);

	try {
		return await childProcess;
	} finally {
		childProcesses.delete(childProcess);
	}
}

/**
 * @returns {void}
 */
function shutdownIfAllPersistentChildProcessesStopped() {
	if (shuttingDown || !persistentChildProcessesStarted || persistentChildProcesses.size > 0) return;

	void shutdown(persistentChildProcessFailed ? 1 : 0);
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import('execa').Options} options
 * @returns {void}
 */
function startChildProcess(command, args, options) {
	const childProcess = spawnChildProcess(command, args, options);
	persistentChildProcesses.add(childProcess);

	void childProcess.then(() => {
		childProcesses.delete(childProcess);
		persistentChildProcesses.delete(childProcess);
		shutdownIfAllPersistentChildProcessesStopped();
	}, error => {
		childProcesses.delete(childProcess);
		persistentChildProcesses.delete(childProcess);
		if (!shuttingDown) {
			persistentChildProcessFailed = true;
			console.error(error);
			shutdownIfAllPersistentChildProcessesStopped();
		}
	});
}

/**
 * @param {import('execa').ResultPromise} childProcess
 * @returns {Promise<void>}
 */
async function stopChildProcess(childProcess) {
	if (process.platform === 'win32' && childProcess.pid != null) {
		const result = await execa('taskkill', ['/pid', childProcess.pid.toString(), '/t', '/f'], {
			reject: false,
		});
		if (result.failed) childProcess.kill();
	} else {
		childProcess.kill();
	}

	await childProcess.catch(() => {});
}

/**
 * @param {number} exitCode
 * @returns {Promise<void>}
 */
function shutdown(exitCode) {
	if (shutdownPromise != null) return shutdownPromise;

	shuttingDown = true;
	shutdownPromise = (async () => {
		await Promise.allSettled([...childProcesses].map(stopChildProcess));
		process.exit(exitCode);
	})();

	return shutdownPromise;
}

process.on('SIGINT', () => {
	void shutdown(0);
});

process.on('SIGTERM', () => {
	void shutdown(0);
});

try {
	await runChildProcess('pnpm', ['clean'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	await runChildProcess('pnpm', ['--filter', 'i18n', 'build'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	await Promise.all([
		runChildProcess('pnpm', ['build-pre'], {
			cwd: _dirname + '/../',
			stdout: process.stdout,
			stderr: process.stderr,
		}),
		runChildProcess('pnpm', ['build-assets'], {
			cwd: _dirname + '/../',
			stdout: process.stdout,
			stderr: process.stderr,
		}),
		runChildProcess('pnpm', ['--filter', 'backend...', '--filter=!backend', 'build'], {
			cwd: _dirname + '/../',
			stdout: process.stdout,
			stderr: process.stderr,
		}),
		runChildProcess('pnpm', ['--filter', 'icons-subsetter', 'build'], {
			cwd: _dirname + '/../',
			stdout: process.stdout,
			stderr: process.stderr,
		}),
		runChildProcess('pnpm', ['--filter', 'misskey-js', 'build'], {
			cwd: _dirname + '/../',
			stdout: process.stdout,
			stderr: process.stderr,
		}),
	]);

	startChildProcess('pnpm', ['build-pre', '--watch'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['build-assets', '--watch'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['--filter', 'backend', 'dev'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['--filter', 'frontend', 'watch'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['--filter', 'frontend-embed', 'watch'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['--filter', 'sw', 'watch'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['--filter', 'misskey-js', 'watch', '--no-clean'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['--filter', 'i18n', 'watch', '--no-clean'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['--filter', 'misskey-reversi', 'watch', '--no-clean'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	startChildProcess('pnpm', ['--filter', 'misskey-bubble-game', 'watch', '--no-clean'], {
		cwd: _dirname + '/../',
		stdout: process.stdout,
		stderr: process.stderr,
	});

	persistentChildProcessesStarted = true;
	shutdownIfAllPersistentChildProcessesStopped();
} catch (error) {
	if (!shuttingDown) {
		console.error(error);
		await shutdown(1);
	}
}
