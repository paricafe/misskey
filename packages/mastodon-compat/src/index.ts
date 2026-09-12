/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { NativeClient, NativeError } from './native-client.js';
import { EntityConverter } from './entities.js';
import { CompatStore } from './store.js';
import { dispatchHandler, handlesOAuth, registerOAuth } from './oauth.js';
import { formParameters, HttpError, parameters } from './parameters.js';
import { registerRoutes } from './routes.js';
import { registerMediaSearch } from './media-search.js';
import { registerFeatures } from './features.js';
import { registerNotifications } from './notifications-v2.js';
import { attachStreaming } from './streaming.js';
import type { NativeTransport } from './types.js';

export { NativeClient, NativeError, EntityConverter, CompatStore };
export { createPostgresStore } from './store.js';
export type { NativeTransport } from './types.js';

export interface GatewayOptions {
	publicUrl: string;
	nativeUrl: string;
	store: CompatStore;
	maxFileSize?: number;
	transport?: NativeTransport;
}

function dependencies(options: GatewayOptions) {
	const store = options.store;
	const native = new NativeClient({ baseUrl: options.nativeUrl, publicUrl: options.publicUrl, transport: options.transport });
	return { store, native, entities: new EntityConverter(options.publicUrl), publicUrl: options.publicUrl, nativeUrl: options.nativeUrl };
}

function registerPruning(app: FastifyInstance, store: CompatStore): () => Promise<void> {
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;
	let pending: Promise<void> | undefined;
	const prune = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		pending = store.prune().catch(error => {
			app.log.warn({ err: error }, 'Failed to prune expired compatibility state');
		}).finally(() => {
			if (!stopped) {
				timer = setTimeout(() => { void prune(); }, 60000);
				timer.unref();
			}
		});
		return pending;
	};
	app.addHook('onReady', async () => { await prune(); });
	return async () => {
		stopped = true;
		clearTimeout(timer);
		await pending;
	};
}

async function setup(app: FastifyInstance, options: GatewayOptions, deps: ReturnType<typeof dependencies>, embedded: boolean): Promise<void> {
	await app.register(cors, { origin: '*', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], exposedHeaders: ['Link', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'] });
	await app.register(multipart, { limits: { fileSize: options.maxFileSize ?? 32 * 1024 * 1024, files: 2, fields: 128, fieldSize: 65536 } });
	app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, value, done) => {
		try { done(null, formParameters(String(value))); } catch (error) { done(error as Error); }
	});
	app.addHook('preValidation', async request => {
		request.query = parameters(request.query);
		if (!request.isMultipart()) request.body = parameters(request.body);
		else if (!['/api/v1/media', '/api/v2/media', '/api/v1/media/:id', '/api/v1/accounts/update_credentials', '/api/v1/apps', '/oauth/token', '/oauth/revoke'].includes(request.routeOptions.url ?? '')) {
			const body: Record<string, unknown> = Object.create(null);
			for await (const part of request.parts()) {
				if (part.type === 'file') { part.file.resume(); throw new HttpError(422, 'Files are not accepted here'); }
				if (part.valueTruncated) throw new HttpError(422, 'Parameter is too large');
				body[part.fieldname] = body[part.fieldname] === undefined ? part.value : [body[part.fieldname], part.value].flat();
			}
			request.body = parameters(body);
		}
	});
	app.addHook('onRequest', async (request, reply) => {
		reply.header('Cache-Control', 'private, no-store');
		if (request.method === 'POST' && new URL(request.url, options.publicUrl).pathname === '/api/v1/apps') {
			const now = Date.now();
			await deps.store.transaction(async () => {
				const counter = await deps.store.getOperation<{ count: number; expires: number }>('registration-rate', request.ip, now) ?? { count: 0, expires: now + 3600000 };
				if (counter.count >= 100) { reply.header('Retry-After', Math.ceil((counter.expires - now) / 1000)); throw new HttpError(429, 'Too many application registrations'); }
				await deps.store.putOperation('registration-rate', request.ip, { ...counter, count: counter.count + 1 }, counter.expires);
			});
		}
	});
	app.setErrorHandler((error, _request, reply) => {
		const typed = error as Error & { statusCode?: number; code?: string };
		const status = error instanceof NativeError
			? (/^NO_SUCH_|^CONTENT_RESTRICTED_BY_/u.test(error.code) ? 404 : /BLOCKED|PERMISSION_DENIED|FORBIDDEN/u.test(error.code) ? 403 : error.status === 400 ? 422 : error.status)
			: typed.statusCode ?? 500;
		if (error instanceof NativeError) for (const [name, value] of Object.entries(error.headers)) if (/^(x-ratelimit-|retry-after$)/iu.test(name)) reply.header(name, value);
		if (status === 401) reply.header('WWW-Authenticate', 'Bearer realm="Mastodon"');
		reply.code(status).send({ error: status >= 500 ? 'The upstream service could not complete this request' : typed.message });
	});
	if (!embedded) registerOAuth(app, deps);
	else for (const [method, url] of [['POST', '/api/v1/apps'], ['GET', '/api/v1/apps/verify_credentials'], ['GET', '/mastodon/oauth/callback'], ['POST', '/oauth/revoke']] as const) app.route({ method, url, handler: (request, reply) => dispatchHandler(request, reply, deps) });
	const routes = registerRoutes(app, deps);
	registerMediaSearch(routes);
	registerFeatures(routes);
	registerNotifications(routes);
}

/** A standalone HTTP/WebSocket server; native Misskey remains a separate upstream. */
export async function createGateway(options: GatewayOptions): Promise<FastifyInstance> {
	const app = Fastify({ bodyLimit: 1024 * 1024 });
	const deps = dependencies(options);
	try { await setup(app, options, deps, false); } catch (error) { await deps.store.close(); throw error; }
	const streaming = attachStreaming(app.server, deps);
	const stopPruning = registerPruning(app, deps.store);
	app.addHook('preClose', async () => { await Promise.all([stopPruning(), streaming.close()]); });
	app.addHook('onClose', async () => { await deps.store.close(); });
	return app;
}

/** Install protocol routes; only OAuth's two shared URLs need dispatch before native handlers. */
export function installGateway(app: FastifyInstance, options: GatewayOptions): { close(): Promise<void> } {
	const deps = dependencies(options);
	app.addHook('onRoute', route => {
		if (!['/oauth/authorize', '/oauth/token', '/oauth/token/'].includes(route.url)) return;
		const original = route.handler;
		route.handler = function(request, reply) {
			return handlesOAuth(request) ? dispatchHandler(request, reply, deps) : original.call(this, request, reply);
		};
	});
	// Native OAuth already parses JSON and URL-encoded forms. Normalize multipart token
	// forms before that parser, keeping the native OAuth implementation independent.
	app.addHook('preParsing', async (request, _reply, payload) => {
		if (request.method !== 'POST' || new URL(request.url, 'http://localhost').pathname.replace(/\/$/u, '') !== '/oauth/token' || !request.headers['content-type']?.startsWith('multipart/form-data')) return payload;
		const chunks: Buffer[] = []; let size = 0;
		for await (const chunk of payload) { size += chunk.length; if (size > 65536) throw new HttpError(413, 'OAuth body is too large'); chunks.push(Buffer.from(chunk)); }
		const data = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': request.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
		const body: Record<string, string> = Object.create(null);
		for (const [key, value] of data.entries()) { if (typeof value !== 'string' || body[key] !== undefined || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new HttpError(422, 'Invalid OAuth form'); body[key] = value; }
		const encoded = JSON.stringify(body); request.headers['content-type'] = 'application/json'; request.headers['content-length'] = String(Buffer.byteLength(encoded));
		return Readable.from([encoded]);
	});
	app.register(async scope => setup(scope, options, deps, true));
	const streaming = attachStreaming(app.server, deps);
	const stopPruning = registerPruning(app, deps.store);
	app.addHook('preClose', async () => { await Promise.all([stopPruning(), streaming.close()]); });
	app.addHook('onClose', async () => { await deps.store.close(); });
	return { close: async () => { await Promise.all([stopPruning(), streaming.close()]); } };
}
