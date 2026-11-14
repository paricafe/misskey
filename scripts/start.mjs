/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const originalCwd = process.cwd();
const backendDir = resolve(import.meta.dirname, '../packages/backend');
const require = createRequire(resolve(backendDir, 'package.json'));

const forwardedSignals = ['SIGTERM', 'SIGHUP'];
let stopRequested = false;

process.on('SIGINT', () => {
	stopRequested = true;
});

const moduleOptions = new Set([
	'--import',
	'--require',
	'-r',
	'--loader',
	'--experimental-loader',
]);

const pathOptions = new Set([
	'--env-file',
	'--env-file-if-exists',
	'--redirect-warnings',
	'--diagnostic-dir',
	'--report-dir',
	'--report-directory',
	'--cpu-prof-dir',
	'--heap-prof-dir',
	'--icu-data-dir',
	'--openssl-config',
	'--tls-keylog',
]);

/**
 * @param {string} name
 * @param {string} value
 */
function resolveOptionValue(name, value) {
	if (moduleOptions.has(name)) {
		if (!/^\.\.?[\\/]/.test(value)) return value;
		const path = resolve(originalCwd, value);
		return name === '--require' || name === '-r' ? path : pathToFileURL(path).href;
	}
	if (pathOptions.has(name) && !isAbsolute(value)) return resolve(originalCwd, value);
	return value;
}

/**
 * @param {string[]} args
 */
function resolveOptionArgs(args) {
	return args.map((arg, i) => {
		const eq = arg.indexOf('=');
		if (arg.startsWith('--') && eq !== -1) {
			const name = arg.slice(0, eq);
			return `${name}=${resolveOptionValue(name, arg.slice(eq + 1))}`;
		}
		const prev = args[i - 1];
		if (prev != null && (moduleOptions.has(prev) || pathOptions.has(prev))) return resolveOptionValue(prev, arg);
		return arg;
	});
}

/**
 * @param {string} nodeOptions
 */
function resolveNodeOptions(nodeOptions) {
	const tokens = [];
	let token = null;
	let inQuote = false;
	for (let i = 0; i < nodeOptions.length; i++) {
		const c = nodeOptions[i];
		if (c === ' ' && !inQuote) {
			if (token != null) tokens.push(token);
			token = null;
			continue;
		}
		token ??= { raw: '', value: '', quoted: false };
		if (inQuote && c === '\\' && i + 1 < nodeOptions.length) {
			token.raw += c + nodeOptions[i + 1];
			token.value += nodeOptions[++i];
		} else if (c === '"') {
			inQuote = !inQuote;
			token.quoted = true;
			token.raw += c;
		} else {
			token.raw += c;
			token.value += c;
		}
	}
	if (token != null) tokens.push(token);

	const resolved = resolveOptionArgs(tokens.map(t => t.value));
	return tokens.map((t, i) => {
		if (resolved[i] === t.value) return t.raw;
		return t.quoted || /[\s"\\]/.test(resolved[i]) ? `"${resolved[i].replace(/[\\"]/g, '\\$&')}"` : resolved[i];
	}).join(' ');
}

if (process.env.NODE_OPTIONS) {
	process.env.NODE_OPTIONS = resolveNodeOptions(process.env.NODE_OPTIONS);
}

/**
 * @param {import('node:child_process').ChildProcess} child
 * @returns {() => void}
 */
function forwardSignals(child) {
	const handlers = forwardedSignals.map(signal => {
		const handler = () => {
			stopRequested = true;
			child.kill(signal);
		};
		process.on(signal, handler);
		return [signal, handler];
	});
	return () => {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	};
}

/**
 * @param {string[]} args
 */
async function runStep(args) {
	const child = spawn(process.execPath, args, {
		cwd: backendDir,
		stdio: 'inherit',
	});
	const stopForwarding = forwardSignals(child);

	const onSigint = () => {
		setTimeout(() => {
			if (child.exitCode == null && child.signalCode == null) child.kill('SIGINT');
		}, 100);
	};
	process.on('SIGINT', onSigint);

	const code = await new Promise((res, rej) => {
		child.once('error', rej);
		child.once('exit', res);
	}).finally(() => {
		stopForwarding();
		process.off('SIGINT', onSigint);
	});
	if (stopRequested || code !== 0) process.exit(code ?? 1);
}

if (process.argv.includes('--migrate')) {
	await runStep([require.resolve('typeorm/cli.js'), 'migration:run', '-d', 'ormconfig.js']);
}

await runStep(['./scripts/check_connect.js']);

const execArgv = resolveOptionArgs(process.execArgv);

process.chdir(backendDir);

const entryArgs = [...execArgv, './built/entry.js'];

try {
	process.execve(process.execPath, [process.execPath, ...entryArgs], process.env);
} catch {
}

const inspector = await import('node:inspector');
if (inspector.url() != null) inspector.close();

const child = spawn(process.execPath, entryArgs, { stdio: 'inherit' });
forwardSignals(child);

child.on('exit', (code, signal) => {
	if (signal != null) {
		process.removeAllListeners(signal);
		process.kill(process.pid, signal);
	} else {
		process.exit(code ?? 1);
	}
});
