/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import cluster from 'node:cluster';
import { lstat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';

const socketError = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Only the primary may remove a stale socket, before it creates a listener. */
export async function prepareUnixSocket(socketPath: string): Promise<void> {
	if (cluster.isWorker) return;
	const stat = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	});
	if (!stat) return;
	if (!stat.isSocket()) throw socketError('The configured socket path is not a socket', 'EEXIST');

	const connection = createConnection(socketPath);
	try {
		const active = await new Promise<boolean>((resolve, reject) => {
			connection.once('connect', () => resolve(true));
			connection.once('error', (error: NodeJS.ErrnoException) => {
				if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
				else reject(error);
			});
			connection.setTimeout(1_000, () => reject(socketError('Timed out checking the configured socket', 'ETIMEDOUT')));
		});
		if (active) throw socketError('The configured socket is already accepting connections', 'EADDRINUSE');
	} finally {
		connection.destroy();
	}

	const current = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	});
	if (!current) return;
	if (stat.ino !== current.ino || stat.dev !== current.dev) throw socketError('The configured socket changed during startup', 'EADDRINUSE');
	await unlink(socketPath);
}

export async function listenOnUnixSocket(socketPath: string, listen: (socketPath: string) => Promise<unknown>): Promise<void> {
	await prepareUnixSocket(socketPath);
	await listen(socketPath);
}
