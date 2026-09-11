/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** JSON at the public HTTP boundary. Domain code must validate fields before use. */
export type Json = Record<string, any>;

export type NativeRequestContext = {
	ip?: string;
	userAgent?: string;
	signal?: AbortSignal;
};

export type NativeTransportRequest = {
	url: string;
	method: 'POST';
	headers: Record<string, string>;
	body: string | Uint8Array;
	context?: NativeRequestContext;
};

export type NativeTransportResponse = {
	status: number;
	body: string | Uint8Array;
	headers?: Record<string, string>;
};

/** An HTTP exchange; adapters can implement it without importing a web framework here. */
export type NativeTransport = (request: NativeTransportRequest) => Promise<NativeTransportResponse>;

export type NativeClientOptions = {
	baseUrl: string;
	publicUrl: string;
	transport?: NativeTransport;
};

export type StatusOptions = {
	viewerId?: string | null;
	allowLocalOnly?: boolean;
	votersCount?: number | ReadonlyMap<string, number>;
	maxDepth?: number;
};
