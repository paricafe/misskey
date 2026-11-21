/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { MiCredentialRevocation } from '@/models/CredentialRevocation.js';
import { MiAccessToken } from '@/models/AccessToken.js';
import Logger from '@/logger.js';
import type { EntityManager, FindOptionsWhere } from 'typeorm';

const logger = new Logger('credential-revocation');

@Injectable()
export class CredentialRevocationService implements OnApplicationShutdown {
	private timer?: NodeJS.Timeout;
	private draining?: Promise<void>;
	private stopping = false;

	constructor(
		@Inject(DI.db) private db: DataSource,
		private events: GlobalEventService,
	) {}

	public start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.dispatch(), 5000);
		this.timer.unref();
		void this.dispatch();
	}

	public async deleteAccessTokens(manager: EntityManager, where: FindOptionsWhere<MiAccessToken>): Promise<void> {
		const removed = await manager.createQueryBuilder().delete().from(MiAccessToken).where(where).returning(['id', 'userId']).execute();
		const rows = removed.raw as Pick<MiAccessToken, 'id' | 'userId'>[];
		if (rows.length) await manager.insert(MiCredentialRevocation, rows.map(row => ({
			event: 'accessTokenRevoked' as const, userId: row.userId, credentialId: row.id,
		})));
	}

	public dispatch(): Promise<void> {
		this.draining ??= this.drain().catch(() => {
			logger.warn('Could not deliver credential revocations. Pending events will be retried.');
		}).finally(() => { this.draining = undefined; });
		return this.draining;
	}

	private async drain(): Promise<void> {
		while (!this.stopping) {
			const delivered = await this.db.transaction(async manager => {
				const row = await manager.createQueryBuilder(MiCredentialRevocation, 'event')
					.orderBy('event.id', 'ASC').setLock('pessimistic_write').setOnLocked('skip_locked').take(1).getOne();
				if (!row) return false;
				await this.events.publishCredentialRevocation(row);
				await manager.delete(MiCredentialRevocation, row.id);
				return true;
			});
			if (!delivered) return;
		}
	}

	public async onApplicationShutdown(): Promise<void> {
		this.stopping = true;
		clearInterval(this.timer);
		await this.draining;
	}
}
