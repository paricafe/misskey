/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { prepareUnixSocket } from '@/boot/unix-socket.js';

describe('UNIX socket ownership', () => {
	const directories: string[] = [];
	const temporary = async () => {
		const directory = await mkdtemp(join(tmpdir(), 'misskey-socket-'));
		directories.push(directory);
		return directory;
	};
	afterEach(async () => {
		await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
	});

	test('leaves regular files untouched', async () => {
		const socket = join(await temporary(), 'server.sock');
		await writeFile(socket, 'keep');
		await expect(prepareUnixSocket(socket)).rejects.toMatchObject({ code: 'EEXIST' });
		expect(await readFile(socket, 'utf8')).toBe('keep');
	});

	test('refuses to remove an active listener', async () => {
		const socket = join(await temporary(), 'server.sock');
		const server = createServer(connection => connection.end('ok'));
		server.listen(socket);
		await once(server, 'listening');
		try {
			await expect(prepareUnixSocket(socket)).rejects.toMatchObject({ code: 'EADDRINUSE' });
			expect(existsSync(socket)).toBe(true);
			const connection = createConnection(socket);
			const [data] = await once(connection, 'data');
			expect(data.toString()).toBe('ok');
			connection.destroy();
		} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
	});

	test('cleans a stale socket left by a crashed process', async () => {
		const socket = join(await temporary(), 'server.sock');
		const child = spawn(process.execPath, ['--input-type=module', '-e', 'import net from "node:net"; net.createServer().listen(process.argv[1], () => process.stdout.write("ready"));', socket], { stdio: ['ignore', 'pipe', 'pipe'] });
		try {
			await once(child.stdout, 'data');
			const exited = once(child, 'exit');
			child.kill('SIGKILL');
			await exited;
			expect(existsSync(socket)).toBe(true);
			await prepareUnixSocket(socket);
			expect(existsSync(socket)).toBe(false);
			await expect(prepareUnixSocket(socket)).resolves.toBeUndefined();
		} finally { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); }
	});

	test.skipIf(process.platform === 'win32')('keeps the shared listener reachable when a worker is replaced', async () => {
		const directory = await temporary();
		const socket = join(directory, 'cluster.sock');
		const source = await readFile(new URL('../../../src/boot/unix-socket.ts', import.meta.url), 'utf8');
		const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
		const fixture = join(directory, 'cluster.mjs');
		await writeFile(fixture, `
			import cluster from 'node:cluster';
			import net from 'node:net';
			import { prepareUnixSocket, listenOnUnixSocket } from ${JSON.stringify(moduleUrl)};
			const socketPath = ${JSON.stringify(socket)};
			if (cluster.isPrimary) {
				await prepareUnixSocket(socketPath);
				cluster.on('message', (_worker, message) => process.send(message));
				const first = cluster.fork();
				cluster.fork();
				process.on('message', message => {
					if (message === 'replace') {
						first.once('exit', () => cluster.fork());
						first.process.kill('SIGKILL');
					}
					if (message === 'stop') cluster.disconnect(() => process.exit(0));
				});
			} else {
				const server = net.createServer(connection => connection.end('ok'));
				await listenOnUnixSocket(socketPath, path => new Promise((resolve, reject) => {
					server.once('error', reject);
					server.listen(path, resolve);
				}));
				process.send('ready');
			}
		`);
		const child = spawn(process.execPath, [fixture], { detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
		const exited = once(child, 'exit');
		const messages: unknown[] = [];
		child.on('message', message => messages.push(message));
		let stderr = '';
		child.stderr?.on('data', chunk => { stderr += chunk; });
		const request = async () => {
			const connection = createConnection(socket);
			try { expect((await once(connection, 'data'))[0].toString()).toBe('ok'); } finally { connection.destroy(); }
		};
		try {
			await expect.poll(() => messages.length, { timeout: 5000 }).toBe(2);
			await request();
			child.send('replace');
			await expect.poll(() => messages.length, { timeout: 5000 }).toBe(3);
			expect(existsSync(socket)).toBe(true);
			await request();
			child.send('stop');
			expect(await exited, stderr).toEqual([0, null]);
		} finally {
			if (child.exitCode == null && child.signalCode == null) process.kill(-child.pid!, 'SIGKILL');
			await exited;
		}
	}, 15000);
});
