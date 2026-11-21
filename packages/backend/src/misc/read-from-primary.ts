/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { EntityManager } from 'typeorm';

export async function readFromPrimary<T>(manager: EntityManager, read: (primary: EntityManager) => Promise<T>): Promise<T> {
	if (manager.queryRunner?.getReplicationMode() === 'master') return read(manager);
	const runner = manager.dataSource.createQueryRunner('master');
	try {
		return await read(runner.manager);
	} finally {
		await runner.release();
	}
}
