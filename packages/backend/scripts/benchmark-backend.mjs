/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { rolldown } from 'rolldown';
import { version as summalyVersion } from '@misskey-dev/summaly';

const backend = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({
	options: {
		scenario: { type: 'string', default: 'streaming' },
		samples: { type: 'string', default: '5' },
		size: { type: 'string', default: '1000' },
		iterations: { type: 'string', default: '2000' },
		role: { type: 'string', default: 'server' },
		output: { type: 'string' },
		'cpu-profile': { type: 'string' },
		'source-ref': { type: 'string' },
		'allow-test-database-reset': { type: 'boolean', default: false },
	},
});

if (!['streaming', 'timeline', 'application'].includes(values.scenario)) throw new Error('Unknown scenario');
for (const key of ['samples', 'size', 'iterations']) {
	const value = Number(values[key]);
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
}
if (!['server', 'queue', 'split', 'combined'].includes(values.role)) throw new Error('Unknown role');
if (values.scenario === 'application' && !values['allow-test-database-reset']) {
	throw new Error('The application scenario resets the local test database; pass --allow-test-database-reset');
}

const cache = join(backend, 'node_modules', '.cache');
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, 'backend-performance-'));
try {
	const plugins = [];
	if (values['source-ref']) {
		// Compare production source from another revision with the same harness,
		// dependencies and fixtures, without changing the working tree.
		const revision = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${values['source-ref']}^{commit}`], { cwd: backend, encoding: 'utf8' }).trim();
		values['source-ref'] = revision;
		const snapshot = join(directory, 'snapshot');
		await mkdir(snapshot);
		const archive = join(directory, 'source.tar');
		await writeFile(archive, execFileSync('git', ['archive', revision, 'packages/backend/src', 'packages/backend/tsconfig.json'], { cwd: join(backend, '../..'), maxBuffer: 32 * 1024 * 1024 }));
		execFileSync('tar', ['-xf', archive, '-C', snapshot]);
		plugins.push({
			name: 'benchmark-source-revision',
			async resolveId(id) {
				if (id.startsWith('@/')) return this.resolve(join(snapshot, 'packages/backend/src', id.slice(2)), undefined, { skipSelf: true });
			},
		});
	}
	const bundle = await rolldown({
		cwd: backend,
		input: './test/performance/benchmark.ts',
		tsconfig: './tsconfig.json',
		platform: 'node',
		transform: {
			define: { _SUMMALY_VERSION_: JSON.stringify(summalyVersion) },
			// Historical sources live under node_modules/.cache, where automatic
			// tsconfig discovery differs from the normal source directory.
			decorator: { legacy: true, emitDecoratorMetadata: true },
			jsx: { runtime: 'automatic', importSource: '@kitajs/html' },
		},
		plugins,
		external: id => !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('@/'),
	});
	try {
		await bundle.write({ dir: directory, format: 'esm', sourcemap: true });
	} finally {
		await bundle.close();
	}
	const flags = ['--expose-gc'];
	if (values['cpu-profile']) {
		await mkdir(values['cpu-profile'], { recursive: true });
		flags.push('--cpu-prof', `--cpu-prof-dir=${values['cpu-profile']}`);
	}
	const child = spawn(process.execPath, [...flags, join(directory, 'benchmark.js'), JSON.stringify(values)], {
		cwd: backend,
		stdio: 'inherit',
		env: { ...process.env, NODE_ENV: 'test' },
	});
	const forwardSignal = signal => child.kill(signal);
	const onInterrupt = () => forwardSignal('SIGINT');
	const onTerminate = () => forwardSignal('SIGTERM');
	process.on('SIGINT', onInterrupt);
	process.on('SIGTERM', onTerminate);
	try {
		process.exitCode = await new Promise((resolve, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
		});
	} finally {
		process.off('SIGINT', onInterrupt);
		process.off('SIGTERM', onTerminate);
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
