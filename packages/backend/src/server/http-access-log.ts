/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Buffer } from 'node:buffer';
import type { FastifyInstance } from 'fastify';
import { logManager } from '@/logging/logging-runtime.js';
import type { LogManager } from '@/logging/LogManager.js';
import type { LogTraceContext } from '@/logging/types.js';

type AccessRequestState = {
	traceContext?: LogTraceContext;
	errorType?: string;
	requestBody?: unknown;
	responseBody?: unknown;
};

type CapturedBody = {
	value: unknown;
};

function getMediaType(value: string | string[] | number | undefined): string | undefined {
	const first = Array.isArray(value) ? value[0] : value;
	return typeof first === 'string' ? first.split(';', 1)[0].trim().toLowerCase() : undefined;
}

function isSupportedMediaType(value: string | undefined): boolean {
	return value === 'application/json'
		|| (value?.startsWith('application/') === true && value.endsWith('+json'))
		|| value === 'application/x-www-form-urlencoded'
		|| (value?.startsWith('text/') === true && value !== 'text/event-stream');
}

function isJsonMediaType(value: string | undefined): boolean {
	return value === 'application/json'
		|| (value?.startsWith('application/') === true && value.endsWith('+json'));
}

function isStream(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	try {
		const candidate = value as {
			pipe?: unknown;
			getReader?: unknown;
			[Symbol.asyncIterator]?: unknown;
		};
		return typeof candidate.pipe === 'function'
			|| typeof candidate.getReader === 'function'
			|| typeof candidate[Symbol.asyncIterator] === 'function';
	} catch {
		return true;
	}
}

function parseJsonBody(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function parseFormBody(value: string): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
	for (const [key, item] of new URLSearchParams(value)) {
		const previous = result[key];
		result[key] = typeof previous === 'undefined'
			? item
			: Array.isArray(previous) ? [...previous, item] : [previous, item];
	}
	return result;
}

function captureBody(value: unknown, contentType: string | string[] | number | undefined): CapturedBody | undefined {
	const mediaType = getMediaType(contentType);
	if (!isSupportedMediaType(mediaType) || isStream(value)) return undefined;

	if (isJsonMediaType(mediaType)) {
		if (typeof value === 'string') return { value: parseJsonBody(value) };
		if (Buffer.isBuffer(value)) return { value: parseJsonBody(value.toString('utf8')) };
		return { value };
	}

	if (mediaType === 'application/x-www-form-urlencoded') {
		if (typeof value === 'string') return { value: parseFormBody(value) };
		if (Buffer.isBuffer(value)) return { value: parseFormBody(value.toString('utf8')) };
	}
	if (typeof value === 'string') return { value };
	if (Buffer.isBuffer(value)) return { value: value.toString('utf8') };
	if (typeof value === 'object' && value !== null) return { value };
	return undefined;
}

function getErrorType(error: unknown): string {
	if (typeof error === 'object' && error !== null && typeof (error as { name?: unknown }).name === 'string') {
		const name = (error as { name: string }).name;
		if (name.length > 0) return name;
	}
	return 'Error';
}

function getResponseSize(value: string | string[] | number | undefined): number | null {
	const first = Array.isArray(value) ? value[0] : value;
	const size = typeof first === 'number' ? first : typeof first === 'string' && /^\d+$/.test(first) ? Number(first) : NaN;
	return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

export function registerHttpAccessLog(fastify: FastifyInstance, manager: LogManager = logManager): void {
	if (!manager.isAccessLogEnabled()) return;

	const states = new WeakMap<object, AccessRequestState>();

	fastify.addHook('onRequest', (request, _reply, done) => {
		states.set(request, {
			traceContext: manager.getActiveTraceContext(),
		});
		done();
	});

	fastify.addHook('onError', (request, _reply, error, done) => {
		const state = states.get(request) ?? {};
		state.errorType = getErrorType(error);
		states.set(request, state);
		done();
	});

	fastify.addHook('onSend', (request, reply, payload, done) => {
		if (!manager.shouldWriteAccess(reply.statusCode)) {
			done(null, payload);
			return;
		}

		const bodyConfiguration = manager.getAccessLogConfiguration().bodies;
		const state = states.get(request) ?? {};
		if (bodyConfiguration.request && !('requestBody' in state)) {
			const captured = captureBody(request.body, request.headers['content-type']);
			if (captured !== undefined) state.requestBody = captured.value;
		}
		if (bodyConfiguration.response && !('responseBody' in state)) {
			const captured = captureBody(payload, reply.getHeader('content-type'));
			if (captured !== undefined) state.responseBody = captured.value;
		}
		states.set(request, state);
		done(null, payload);
	});

	fastify.addHook('onResponse', (request, reply, done) => {
		const state = states.get(request);
		const input = {
			method: request.method,
			route: request.routeOptions.url ?? null,
			statusCode: reply.statusCode,
			durationMs: reply.elapsedTime,
			responseSizeBytes: getResponseSize(reply.getHeader('content-length')),
			...(state?.errorType !== undefined ? { errorType: state.errorType } : {}),
			...(state != null && 'requestBody' in state ? { requestBody: state.requestBody } : {}),
			...(state != null && 'responseBody' in state ? { responseBody: state.responseBody } : {}),
			...(state?.traceContext !== undefined ? { traceContext: state.traceContext } : {}),
		};
		manager.writeAccess(input);
		states.delete(request);
		done();
	});
}
