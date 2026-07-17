/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import { MastodonApiServerService } from './MastodonApiServerService.js';
import { MastodonStreamingApiServerService } from './MastodonStreamingApiServerService.js';
import type * as http from 'node:http';
import type { FastifyInstance } from 'fastify';

@Injectable()
export class MastodonApiIntegrationService {
	private streamingAttached = false;

	constructor(
		@Inject(DI.config)
		private config: Config,

		private mastodonApiServerService: MastodonApiServerService,
		private mastodonStreamingApiServerService: MastodonStreamingApiServerService,
	) {}

	public register(fastify: FastifyInstance): void {
		if (!this.config.enableMastodonApi) return;
		fastify.register(this.mastodonApiServerService.createServer);
	}

	public attach(server: http.Server): void {
		if (!this.config.enableMastodonApi) return;
		this.mastodonStreamingApiServerService.attach(server);
		this.streamingAttached = true;
	}

	public async detach(): Promise<void> {
		if (!this.streamingAttached) return;
		this.streamingAttached = false;
		await this.mastodonStreamingApiServerService.detach();
	}
}
