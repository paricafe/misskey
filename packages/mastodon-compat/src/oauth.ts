/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {} from '@fastify/multipart';
import { CompatStore, hashCredential, type AuthorizationCode, type CompatClient, type Grant } from './store.js';
import { allowsScope, normalizeScopes, toNativePermissions } from './scopes.js';

const OOB = 'urn:ietf:wg:oauth:2.0:oob';
const STATE_TTL = 10 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
type Parameters = Record<string, unknown>;

export interface OAuthDependencies {
	store: CompatStore;
	native: { call<T>(endpoint: string, body: Record<string, never>): Promise<T> };
	publicUrl: string;
	nativeUrl: string;
	now?: () => number;
}

interface AuthorizationState {
	clientId: string;
	redirectUri: string;
	scopes: string[];
	session: string;
	clientState?: string;
	codeChallenge?: string;
}

export class OAuthError extends Error {
	constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

const pathname = (request: FastifyRequest): string => new URL(request.url, 'http://localhost').pathname.replace(/\/$/u, '');
const object = (value: unknown): Parameters => value && typeof value === 'object' && !Array.isArray(value) ? value as Parameters : {};
const field = (body: Parameters, name: string): string | undefined => typeof body[name] === 'string' ? body[name] as string : undefined;

function required(body: Parameters, name: string): string {
	const value = field(body, name);
	if (!value) throw new OAuthError(400, 'invalid_request', `${name} is required`);
	return value;
}

function scopes(value: unknown, defaults?: readonly string[]): string[] {
	try { return normalizeScopes(value, defaults); } catch {
		throw new OAuthError(400, 'invalid_scope', 'The requested scope is invalid');
	}
}

function requireSubset(requested: readonly string[], allowed: readonly string[]): void {
	if (requested.some(scope => !allowsScope(allowed, scope))) throw new OAuthError(400, 'invalid_scope', 'The requested scope exceeds the application permissions');
}

function basicCredentials(header: string | undefined): { id: string; secret: string } | undefined {
	if (!header || !/^Basic\s/iu.test(header)) return undefined;
	try {
		const encoded = header.replace(/^Basic\s+/iu, '');
		if (!/^[A-Za-z\d+/]+={0,2}$/u.test(encoded)) throw new Error();
		const decoded = Buffer.from(encoded, 'base64').toString('utf8');
		const colon = decoded.indexOf(':');
		if (colon < 0) throw new Error();
		const decode = (value: string): string => decodeURIComponent(value.replace(/\+/gu, ' '));
		return { id: decode(decoded.slice(0, colon)), secret: decode(decoded.slice(colon + 1)) };
	} catch {
		throw new OAuthError(401, 'invalid_client', 'Invalid client authentication');
	}
}

async function authenticatedClient(request: FastifyRequest, body: Parameters, store: CompatStore): Promise<CompatClient> {
	const basic = basicCredentials(request.headers.authorization);
	const id = basic?.id ?? field(body, 'client_id');
	const secret = basic?.secret ?? field(body, 'client_secret');
	if (basic && (body.client_id !== undefined || body.client_secret !== undefined)) {
		throw new OAuthError(400, 'invalid_request', 'Use one client authentication method');
	}
	const client = id && secret ? await store.verifyClient(id, secret) : undefined;
	if (!client) throw new OAuthError(401, 'invalid_client', 'Invalid client authentication');
	return client;
}

export async function getAuthorization(request: FastifyRequest, store: CompatStore): Promise<Grant | undefined> {
	const header = request.headers.authorization;
	if (!header) return undefined;
	const match = /^Bearer\s+(\S+)$/iu.exec(header);
	const grant = match?.[1].startsWith('mc_') ? await store.getGrant(match[1]) : undefined;
	if (!grant) throw new OAuthError(401, 'invalid_token', 'A valid compatibility access token is required');
	return grant;
}

/** For embedding alongside native OAuth. Call after body parsing, before dispatch. */
export function handlesOAuth(request: FastifyRequest): boolean {
	const route = pathname(request);
	if (route === '/mastodon/oauth/callback' || route === '/api/v1/apps' || route === '/api/v1/apps/verify_credentials') return true;
	if (!['/oauth/authorize', '/oauth/token', '/oauth/revoke', '/oauth/userinfo'].includes(route)) return false;
	const body = object(request.body);
	const query = object(request.query);
	if ([body.client_id, query.client_id, body.token].some(value => typeof value === 'string' && value.startsWith('mc_'))) return true;
	if (/^Bearer\s+mc_/iu.test(request.headers.authorization ?? '')) return true;
	try { return basicCredentials(request.headers.authorization)?.id.startsWith('mc_') ?? false; } catch { return false; }
}

async function readBody(request: FastifyRequest): Promise<Parameters> {
	if (!request.isMultipart?.()) return object(request.body);
	const body: Parameters = {};
	for await (const part of request.parts({ limits: { fields: 64, parts: 64, files: 0, fieldSize: 16 * 1024 } })) {
		if (part.type === 'file') {
			part.file.resume();
			throw new OAuthError(422, 'invalid_request', 'Files are not accepted by OAuth endpoints');
		}
		if (part.valueTruncated) throw new OAuthError(422, 'invalid_request', 'OAuth parameter is too large');
		const previous = body[part.fieldname];
		body[part.fieldname] = previous === undefined ? part.value : Array.isArray(previous) ? [...previous, part.value] : [previous, part.value];
	}
	return body;
}

function redirectUris(value: unknown): string[] {
	const entries = Array.isArray(value) ? value : [value];
	if (entries.some(uri => typeof uri !== 'string')) throw new OAuthError(422, 'invalid_request', 'redirect_uris is required');
	const result = [...new Set((entries as string[]).flatMap(uri => uri.split(/\s+/u)).filter(Boolean))];
	if (!result.length || result.length > 10) throw new OAuthError(422, 'invalid_request', 'Between one and ten redirect URIs are required');
	for (const uri of result) {
		if (uri === OOB) continue;
		try {
			const parsed = new URL(uri);
			if (uri.length > 2048 || parsed.hash || parsed.username || parsed.password || ['javascript:', 'data:', 'file:', 'vbscript:', 'about:', 'urn:'].includes(parsed.protocol)) throw new Error();
		} catch { throw new OAuthError(422, 'invalid_request', 'Invalid redirect URI'); }
	}
	return result;
}

function application(client: CompatClient): Record<string, unknown> {
	return { id: client.id, name: client.name, website: client.website ?? null, scopes: client.scopes, redirect_uris: client.redirectUris, redirect_uri: client.redirectUris.join('\n') };
}

async function registerApplication(body: Parameters, deps: OAuthDependencies): Promise<Record<string, unknown>> {
	const name = field(body, 'client_name')?.trim();
	if (!name || name.length > 256) throw new OAuthError(422, 'invalid_request', 'A valid client_name is required');
	const website = field(body, 'website');
	if (website && (website.length > 2048 || !/^https?:\/\//iu.test(website))) throw new OAuthError(422, 'invalid_request', 'Invalid application website');
	const { client, clientSecret } = await deps.store.createClient({ name, website, redirectUris: redirectUris(body.redirect_uris ?? body['redirect_uris[]']), scopes: scopes(body.scopes) }, deps.now?.());
	return { ...application(client), client_id: client.id, client_secret: clientSecret };
}

async function beginAuthorization(query: Parameters, reply: FastifyReply, deps: OAuthDependencies): Promise<unknown> {
	const client = await deps.store.getClient(required(query, 'client_id'));
	if (!client) throw new OAuthError(400, 'invalid_client', 'Unknown application');
	const redirectUri = required(query, 'redirect_uri');
	if (!client.redirectUris.includes(redirectUri)) throw new OAuthError(400, 'invalid_request', 'The redirect URI is not registered');
	if (query.response_type !== 'code') throw new OAuthError(400, 'unsupported_response_type', 'Only authorization_code is supported');
	const requested = scopes(query.scope, client.scopes);
	requireSubset(requested, client.scopes);
	const forceLogin = field(query, 'force_login');
	if (forceLogin && !['0', 'false', 'f', 'off'].includes(forceLogin.toLowerCase())) throw new OAuthError(400, 'unsupported_parameter', 'force_login is not supported by the native MiAuth consent page');
	// MiAuth uses the user's native UI language. OAuth's optional lang hint is not enforced.
	const challenge = field(query, 'code_challenge');
	if ((query.code_challenge !== undefined && !challenge) || (challenge && (!/^[A-Za-z\d_-]{43}$/u.test(challenge) || query.code_challenge_method !== 'S256')) || (!challenge && query.code_challenge_method !== undefined)) {
		throw new OAuthError(400, 'invalid_request', 'PKCE requires an S256 code challenge');
	}
	const now = deps.now?.() ?? Date.now();
	await deps.store.prune(now);
	const state = randomBytes(32).toString('base64url');
	const session = randomUUID();
	const pending: AuthorizationState = { clientId: client.id, redirectUri, scopes: requested, session, clientState: field(query, 'state'), codeChallenge: challenge };
	await deps.store.putOperation('oauth_state', hashCredential(state), pending, now + STATE_TTL);
	const callback = new URL('/mastodon/oauth/callback', deps.publicUrl);
	callback.searchParams.set('state', state);
	const destination = new URL(`/miauth/${session}`, deps.publicUrl);
	destination.searchParams.set('name', client.name);
	destination.searchParams.set('permission', toNativePermissions(requested).join(','));
	destination.searchParams.set('callback', callback.toString());
	return reply.redirect(destination.toString());
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function authorizationResult(reply: FastifyReply, state: AuthorizationState, result: { code: string } | { error: string; error_description: string }): unknown {
	if (state.redirectUri === OOB) {
		const accepted = 'code' in result;
		const content = accepted ? `<label>Authorization code<input readonly value="${escapeHtml(result.code)}"></label>` : `<p>${escapeHtml(result.error_description)}</p>`;
		return reply.type('text/html; charset=utf-8').header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
			.send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Application authorization</title><body><h1>${accepted ? 'Authorization complete' : 'Authorization denied'}</h1>${content}</body></html>`);
	}
	const url = new URL(state.redirectUri);
	for (const [key, value] of Object.entries(result)) url.searchParams.set(key, value);
	if (state.clientState !== undefined) url.searchParams.set('state', state.clientState);
	return reply.redirect(url.toString());
}

async function callback(query: Parameters, reply: FastifyReply, deps: OAuthDependencies): Promise<unknown> {
	const rawState = required(query, 'state');
	const now = deps.now?.() ?? Date.now();
	const state = await deps.store.takeOperation<AuthorizationState>('oauth_state', hashCredential(rawState), now);
	if (!state) throw new OAuthError(400, 'invalid_request', 'The authorization state has expired or was already used');
	if (query.session !== undefined && query.session !== state.session) throw new OAuthError(400, 'invalid_request', 'The MiAuth session does not match');
	let result: { ok?: boolean; token?: string; user?: { id?: string } };
	try { result = await deps.native.call(`miauth/${state.session}/check`, {}); } catch {
		return authorizationResult(reply, state, { error: 'server_error', error_description: 'The native authorization result could not be checked' });
	}
	if (!result.ok || typeof result.token !== 'string' || !result.token || typeof result.user?.id !== 'string' || !result.user.id) {
		return authorizationResult(reply, state, { error: 'access_denied', error_description: 'The application was not authorized' });
	}
	const code = await deps.store.issueCode({ clientId: state.clientId, redirectUri: state.redirectUri, scopes: state.scopes, userId: result.user.id, nativeToken: result.token, codeChallenge: state.codeChallenge }, now + CODE_TTL);
	return authorizationResult(reply, state, { code });
}

function verifyPkce(code: AuthorizationCode, body: Parameters): void {
	if (!code.codeChallenge) return;
	const verifier = field(body, 'code_verifier');
	if (!verifier || !/^[A-Za-z\d._~-]{43,128}$/u.test(verifier)) throw new OAuthError(400, 'invalid_grant', 'Invalid PKCE verifier');
	const expected = Buffer.from(code.codeChallenge);
	const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new OAuthError(400, 'invalid_grant', 'Invalid PKCE verifier');
}

async function token(request: FastifyRequest, body: Parameters, deps: OAuthDependencies): Promise<Record<string, unknown>> {
	const client = await authenticatedClient(request, body, deps.store);
	const now = deps.now?.() ?? Date.now();
	let issued: { token: string; grant: Grant };
	if (body.grant_type === 'client_credentials') {
		const requested = scopes(body.scope, ['read']);
		requireSubset(requested, client.scopes);
		issued = await deps.store.createGrant({ clientId: client.id, scopes: requested, kind: 'app' }, now);
	} else if (body.grant_type === 'authorization_code') {
		const raw = required(body, 'code');
		issued = await deps.store.transaction(async () => {
			const code = await deps.store.getCode(raw, now);
			if (!code || code.clientId !== client.id || code.redirectUri !== field(body, 'redirect_uri')) throw new OAuthError(400, 'invalid_grant', 'Invalid authorization code or redirect URI');
			verifyPkce(code, body);
			const requested = scopes(body.scope, code.scopes);
			requireSubset(requested, code.scopes);
			await deps.store.deleteCode(raw);
			return await deps.store.createGrant({ clientId: client.id, scopes: requested, kind: 'user', userId: code.userId, nativeToken: code.nativeToken }, now);
		});
	} else {
		throw new OAuthError(400, 'unsupported_grant_type', 'Only authorization_code and client_credentials are supported');
	}
	return { access_token: issued.token, token_type: 'Bearer', scope: issued.grant.scopes.join(' '), created_at: Math.floor(issued.grant.createdAt / 1000) };
}

async function revoke(request: FastifyRequest, body: Parameters, deps: OAuthDependencies): Promise<Record<string, never>> {
	const client = await authenticatedClient(request, body, deps.store);
	const raw = field(body, 'token');
	if (!raw) throw new OAuthError(403, 'access_denied', 'A token is required');
	const grant = await deps.store.getGrant(raw);
	if (grant && grant.clientId !== client.id) throw new OAuthError(403, 'access_denied', 'The token belongs to another application');
	await deps.store.revokeGrant(raw, client.id);
	return {};
}

/** The same dispatcher can be mounted independently or called by an existing server's route wrapper. */
export async function dispatchHandler(request: FastifyRequest, reply: FastifyReply, deps: OAuthDependencies): Promise<unknown> {
	reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').header('Referrer-Policy', 'no-referrer');
	try {
		const route = pathname(request);
		if (request.method === 'POST' && route === '/api/v1/apps') return reply.send(await registerApplication(await readBody(request), deps));
		if (request.method === 'GET' && route === '/api/v1/apps/verify_credentials') {
			const grant = await getAuthorization(request, deps.store);
			const client = grant && await deps.store.getClient(grant.clientId);
			if (!client) throw new OAuthError(401, 'invalid_token', 'An application token is required');
			return reply.send(application(client));
		}
		if (request.method === 'GET' && route === '/oauth/authorize') return await beginAuthorization(object(request.query), reply, deps);
		if (request.method === 'GET' && route === '/mastodon/oauth/callback') return await callback(object(request.query), reply, deps);
		if (request.method === 'POST' && route === '/oauth/token') return reply.send(await token(request, await readBody(request), deps));
		if (request.method === 'POST' && route === '/oauth/revoke') return reply.send(await revoke(request, await readBody(request), deps));
		throw new OAuthError(404, 'not_found', 'Unknown OAuth endpoint');
	} catch (error) {
		if (error instanceof OAuthError) {
			if (error.statusCode === 401) reply.header('WWW-Authenticate', error.code === 'invalid_client' ? 'Basic realm="OAuth"' : 'Bearer realm="Mastodon"');
			return reply.code(error.statusCode).send({ error: error.code, error_description: error.message });
		}
		throw error;
	}
}

export function registerOAuth(fastify: FastifyInstance, deps: OAuthDependencies): void {
	if (!fastify.hasContentTypeParser('application/x-www-form-urlencoded')) {
		fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
			const parsed: Parameters = {};
			for (const [key, value] of new URLSearchParams(String(body))) {
				const previous = parsed[key];
				parsed[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value];
			}
			done(null, parsed);
		});
	}
	for (const [method, url] of [
		['POST', '/api/v1/apps'], ['GET', '/api/v1/apps/verify_credentials'], ['GET', '/oauth/authorize'],
		['GET', '/mastodon/oauth/callback'], ['POST', '/oauth/token'], ['POST', '/oauth/revoke'],
	] as const) {
		fastify.route({ method, url, handler: (request, reply) => dispatchHandler(request, reply, deps) });
	}
}
