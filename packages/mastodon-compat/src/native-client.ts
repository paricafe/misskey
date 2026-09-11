/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Json, NativeClientOptions, NativeRequestContext, NativeTransport, NativeTransportRequest, NativeTransportResponse } from './types.js';

export class NativeError extends Error {
	readonly status: number;
	readonly code: string;
	readonly headers: Record<string, string>;

	constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
		super(message);
		this.name = 'NativeError';
		this.status = status;
		this.code = code;
		this.headers = headers;
	}
}

const endpointPattern = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/u;

function httpUrl(value: string): URL {
	const url = new URL(value);
	if (!['https:', 'http:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
		throw new TypeError('Native and public URLs must be HTTP(S) URLs without credentials, a query, or a fragment');
	}
	return url;
}

async function fetchTransport(request: NativeTransportRequest): Promise<NativeTransportResponse> {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: typeof request.body === 'string' ? request.body : Buffer.from(request.body),
		signal: request.context?.signal,
		// A native credential must never be forwarded to a redirect target.
		redirect: 'manual',
	});
	return {
		status: response.status,
		body: await response.text(),
		headers: Object.fromEntries(response.headers.entries()),
	};
}

export class NativeClient {
	readonly baseUrl: string;
	readonly publicUrl: string;
	private readonly transport: NativeTransport;

	constructor(options: NativeClientOptions) {
		this.baseUrl = httpUrl(options.baseUrl).toString();
		this.publicUrl = httpUrl(options.publicUrl).toString();
		this.transport = options.transport ?? fetchTransport;
	}

	async call<T>(endpoint: string, body: Json = {}, token?: string, context?: NativeRequestContext): Promise<T> {
		const url = this.endpointUrl(endpoint);
		if (body == null || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('The native request body must be an object');
		// The adapter owns authentication. A payload copied from a client must not select another credential.
		const payload: Json = { ...body };
		delete payload.i;
		const headers = this.headers(token, context);
		headers['content-type'] = 'application/json';
		return await this.exchange<T>({ url, method: 'POST', headers, body: JSON.stringify(payload), context });
	}

	async upload(file: Blob, name: string, fields: Json, token: string, context?: NativeRequestContext): Promise<Json> {
		if (token === '') throw new NativeError(401, 'CREDENTIAL_REQUIRED', 'An upload requires a native credential');
		const form = new FormData();
		for (const [key, value] of Object.entries(fields)) {
			if (key === 'i' || key === 'file' || value === undefined) continue;
			form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
		}
		form.append('file', file, name);
		const url = this.endpointUrl('drive/files/create');
		const encoded = new Request(url, { method: 'POST', body: form });
		const headers = this.headers(token, context);
		headers['content-type'] = encoded.headers.get('content-type')!;
		return await this.exchange<Json>({
			url,
			method: 'POST',
			headers,
			body: new Uint8Array(await encoded.arrayBuffer()),
			context,
		});
	}

	/** Uses the native streaming endpoint. The caller must keep token-bearing URLs out of logs. */
	socketUrl(token?: string): string {
		const url = new URL('/streaming', this.baseUrl);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		if (token != null && token !== '') url.searchParams.set('i', token);
		return url.toString();
	}

	private endpointUrl(endpoint: string): string {
		if (!endpointPattern.test(endpoint)) throw new TypeError('Invalid native endpoint');
		return new URL(`/api/${endpoint}`, this.baseUrl).toString();
	}

	private headers(token?: string, context?: NativeRequestContext): Record<string, string> {
		const headers: Record<string, string> = { accept: 'application/json' };
		if (token != null && token !== '') {
			if (/[\r\n]/u.test(token)) throw new TypeError('Invalid native credential');
			headers.authorization = `Bearer ${token}`;
		}
		if (context?.userAgent != null) headers['user-agent'] = context.userAgent.replace(/[\r\n]/gu, '').slice(0, 1024);
		// IP is transport context, not an untrusted forwarded header. An in-process host adapter can preserve it.
		return headers;
	}

	private async exchange<T>(request: NativeTransportRequest): Promise<T> {
		let response: NativeTransportResponse;
		try {
			request.context?.signal?.throwIfAborted();
			response = await this.transport(request);
		} catch (error) {
			if (error instanceof NativeError) throw error;
			if (request.context?.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
				throw new NativeError(499, 'REQUEST_ABORTED', 'The native request was cancelled');
			}
			// Writes are deliberately never retried: a disconnected response may already have committed.
			throw new NativeError(502, 'NATIVE_CONNECTION_FAILED', 'The native API request failed');
		}
		const text = typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body);
		let payload: any;
		if (text.trim() !== '') {
			try {
				payload = JSON.parse(text);
			} catch {
				if (response.status >= 200 && response.status < 300) throw new NativeError(502, 'INVALID_NATIVE_RESPONSE', 'The native API returned an invalid JSON response');
			}
		}
		if (response.status < 200 || response.status >= 300 || payload?.error != null) {
			const error = payload?.error;
			throw new NativeError(
				response.status >= 200 && response.status < 300 ? 502 : response.status,
				typeof error?.code === 'string' ? error.code : 'NATIVE_HTTP_ERROR',
				typeof error?.message === 'string' ? error.message : 'The native API rejected the request',
				response.headers,
			);
		}
		return payload as T;
	}
}

export type { NativeClientOptions, NativeRequestContext, NativeTransport, NativeTransportRequest, NativeTransportResponse } from './types.js';
