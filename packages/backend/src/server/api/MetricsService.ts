/*
 * SPDX-FileCopyrightText: syuilo and misskey-project and yumechi
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from "@nestjs/common";
import * as prom from 'prom-client';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { bindThis } from "@/decorators.js";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";

export function metricGauge<K extends string>(conf: prom.GaugeConfiguration<K>) : prom.Gauge<K> | null {
	if (!process.env.RUN_MODE) {
		return null;
	}

	return new prom.Gauge(conf);
}

export function metricCounter<K extends string>(conf: prom.CounterConfiguration<K>) : prom.Counter<K> | null {
	if (!process.env.RUN_MODE) {
		return null;
	}

	return new prom.Counter(conf);
}

export function metricHistogram<K extends string>(conf: prom.HistogramConfiguration<K>) : prom.Histogram<K> | null {
	if (!process.env.RUN_MODE) {
		return null;
	}

	return new prom.Histogram(conf);
}

@Injectable()
export class MetricsService {
	private workerRegistry: prom.AggregatorRegistry<prom.PrometheusContentType> | null = null;
    constructor(
		@Inject(DI.config)
		private config: Config,
     ) {}

	@bindThis
	public setWorkerRegistry(workerRegistry: prom.AggregatorRegistry<prom.PrometheusContentType>) {
		this.workerRegistry = workerRegistry;
	}

    @bindThis
    public createServer(fastify: FastifyInstance, options: FastifyPluginOptions, done: (err?: Error) => void) {
        if (this.config.prometheusMetrics?.enable) {
			const token = this.config.prometheusMetrics.scrapeToken;
			fastify.get('/metrics', async (request, reply) => {
				if (token) {
					const bearer = request.headers.authorization;

					if (!bearer) {
						reply.code(401);
						return;
					}

					const [type, t] = bearer.split(' ');

					if (type !== 'Bearer' || t !== token) {
						reply.code(403);
						return;
					}
				}
				
				try {
					reply.header('Content-Type', prom.register.contentType);
					reply.send(await prom.register.metrics());
				} catch (err) {
					reply.code(500);
				}
			});

			fastify.get('/metrics/cluster', async (request, reply) => {
				if (token) {
					const bearer = request.headers.authorization;

					if (!bearer) {
						reply.code(401);
						return;
					}

					const [type, t] = bearer.split(' ');

					if (type !== 'Bearer' || t !== token) {
						reply.code(403);
						return;
					}
				}

				if (!this.workerRegistry) {
					reply.code(404);
					return;
				}
				
				try {
					reply.header('Content-Type', this.workerRegistry.contentType);
					reply.send(await this.workerRegistry.clusterMetrics());
				} catch (err) {
					reply.code(500);
				}
			});
		}

		done();
    }
}
