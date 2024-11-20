/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import querystring from 'querystring';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import megalodon, { MegalodonInterface } from 'megalodon';
import { v4 as uuid } from 'uuid';
import httpLinkHeader from 'http-link-header';
import ipaddr from 'ipaddr.js';
import oauth2orize, { type OAuth2, AuthorizationError } from 'oauth2orize';
import oauth2Pkce from 'oauth2orize-pkce';
import { JSDOM } from 'jsdom';
import { mf2 } from 'microformats-parser';
import fastifyCors from '@fastify/cors';
import fastifyView from '@fastify/view';
import pug from 'pug';
import multer from 'fastify-multer';
import { bindThis } from '@/decorators.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { FastifyInstance } from 'fastify';
import { MemoryKVCache } from '@/misc/cache.js';
import { LoggerService } from '@/core/LoggerService.js';
import Logger from '@/logger.js';

const kinds = [
    'read:account',
    'write:account',
    'read:blocks',
    'write:blocks',
    'read:drive',
    'write:drive',
    'read:favorites',
    'write:favorites',
    'read:following',
    'write:following',
    'read:messaging',
    'write:messaging',
    'read:mutes',
    'write:mutes',
    'write:notes',
    'read:notifications',
    'write:notifications',
    'read:reactions',
    'write:reactions',
    'write:votes',
    'read:pages',
    'write:pages',
    'write:page-likes',
    'read:page-likes',
    'read:user-groups',
    'write:user-groups',
    'read:channels',
    'write:channels',
    'read:gallery',
    'write:gallery',
    'read:gallery-likes',
    'write:gallery-likes',
];

function validateClientId(raw: string): URL {
    try {
        const url = new URL(raw);

        const allowedProtocols = process.env.NODE_ENV === 'test' ? ['http:', 'https:'] : ['https:'];
        if (!allowedProtocols.includes(url.protocol)) {
            throw new AuthorizationError('client_id must be a valid HTTPS URL', 'invalid_request');
        }

        const segments = url.pathname.split('/');
        if (segments.includes('.') || segments.includes('..')) {
            throw new AuthorizationError('client_id must not contain dot path segments', 'invalid_request');
        }

        if (url.hash) {
            throw new AuthorizationError('client_id must not contain a fragment component', 'invalid_request');
        }

        if (url.username || url.password) {
            throw new AuthorizationError('client_id must not contain a username or a password', 'invalid_request');
        }

        if (!url.hostname.match(/\.\w+$/) && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
            throw new AuthorizationError('client_id must have a domain name as a host name', 'invalid_request');
        }

        return url;
    } catch (e) {
        throw new AuthorizationError('client_id must be a valid URL', 'invalid_request');
    }
}

async function discoverClientInformation(logger: Logger, httpRequestService: HttpRequestService, id: string): Promise<ClientInformation> {
    try {
        const res = await httpRequestService.send(id);
        const redirectUris: string[] = [];

        const linkHeader = res.headers.get('link');
        if (linkHeader) {
            redirectUris.push(...httpLinkHeader.parse(linkHeader).get('rel', 'redirect_uri').map(r => r.uri));
        }

        const text = await res.text();
        const fragment = JSDOM.fragment(text);

        redirectUris.push(...[...fragment.querySelectorAll<HTMLLinkElement>('link[rel=redirect_uri][href]')].map(el => el.href));

        let name = id;
        if (text) {
            const microformats = mf2(text, { baseUrl: res.url });
            const nameProperty = microformats.items.find(item => item.type?.includes('h-app') && item.properties.url.includes(id))?.properties.name[0];
            if (typeof nameProperty === 'string') {
                name = nameProperty;
            }
        }

        return {
            id,
            redirectUris: redirectUris.map(uri => new URL(uri, res.url).toString()),
            name: typeof name === 'string' ? name : id,
        };
    } catch (err) {
        logger.error('Error while fetching client information', { err });
        throw new AuthorizationError('Failed to fetch client information', 'invalid_request');
    }
}

function getClient(BASE_URL: string, authorization: string | undefined): MegalodonInterface {
    const accessTokenArr = authorization?.split(' ') ?? [null];
    const accessToken = accessTokenArr[accessTokenArr.length - 1];
    const generator = (megalodon as any).default;
    const client = generator('misskey', BASE_URL, accessToken) as MegalodonInterface;
    return client;
}

@Injectable()
export class OAuth2ProviderService {
    #logger: Logger;
    #server = oauth2orize.createServer();
    #clientCache = new MemoryKVCache<ClientInformation>(60 * 60 * 1000); // 1 hour

    constructor(
        @Inject(DI.config)
        private config: Config,
        private httpRequestService: HttpRequestService,
        loggerService: LoggerService,
    ) {
        this.#logger = loggerService.getLogger('oauth');
        this.#server.grant(oauth2Pkce.extensions());
    }

    // https://datatracker.ietf.org/doc/html/rfc8414.html
    // https://indieauth.spec.indieweb.org/#indieauth-server-metadata
    public generateRFC8414() {
        return {
            issuer: this.config.url,
            authorization_endpoint: new URL('/oauth/authorize', this.config.url),
            token_endpoint: new URL('/oauth/token', this.config.url),
            scopes_supported: kinds,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'client_credentials'],
            service_documentation: 'https://misskey-hub.net',
            code_challenge_methods_supported: ['S256'],
            authorization_response_iss_parameter_supported: true,
        };
    }

    @bindThis
    public async createServer(fastify: FastifyInstance): Promise<void> {
        const upload = multer({
            storage: multer.diskStorage({}),
            limits: {
                fileSize: this.config.maxFileSize || 262144000,
                files: 1,
            },
        });

        fastify.register(fastifyCors);

        fastify.register(fastifyView, {
            root: fileURLToPath(new URL('../web/views', import.meta.url)),
            engine: { pug },
            defaultContext: {
                version: this.config.version,
                config: this.config,
            },
        });

        fastify.addHook('onRequest', (request, reply, done) => {
            reply.header('Access-Control-Allow-Origin', '*');
            done();
        });

        fastify.addContentTypeParser('application/x-www-form-urlencoded', (request, payload, done) => {
            let body = '';
            payload.on('data', (data) => {
                body += data;
            });
            payload.on('end', () => {
                try {
                    const parsed = querystring.parse(body);
                    done(null, parsed);
                } catch (e: any) {
                    done(e);
                }
            });
            payload.on('error', done);
        });

        fastify.register(multer.contentParser);

        // Handle both Misskey and Mastodon OAuth flows
        fastify.get('/authorize', async (request, reply) => {
            const query: any = request.query;
            let param = "mastodon=true";
            if (query.state) param += `&state=${query.state}`;
            if (query.redirect_uri) param += `&redirect_uri=${query.redirect_uri}`;
            const client = query.client_id ? query.client_id : "";

            // Misskey OAuth validation
            if (client) {
                try {
                    const clientUrl = validateClientId(Buffer.from(client.toString(), 'base64').toString());
                    if (process.env.NODE_ENV !== 'test') {
                        const lookup = await dns.lookup(clientUrl.hostname);
                        if (ipaddr.parse(lookup.address).range() !== 'unicast') {
                            throw new AuthorizationError('client_id resolves to disallowed IP range.', 'invalid_request');
                        }
                    }

                    // Cache client information
                    const clientInfo = await this.#clientCache.fetch(
                        clientUrl.href,
                        () => discoverClientInformation(this.#logger, this.httpRequestService, clientUrl.href),
                    );

                    // Store client info for token endpoint
                    await this.#clientCache.set(`client:${query.code_challenge}`, clientInfo);
                } catch (err) {
                    reply.code(400).send({ error: err.message });
                    return;
                }
            }

            reply.redirect(
                `${Buffer.from(client.toString(), 'base64').toString()}?${param}`,
            );
        });

        fastify.get('/authorize/', (request, reply) => {
            return this.handleAuthorize(request, reply);
        });

        fastify.post('/token', { preHandler: upload.none() }, async (request, reply) => {
            const body: any = request.body || request.query;

            // Handle client_credentials grant type
            if (body.grant_type === "client_credentials") {
                const ret = {
                    access_token: uuid(),
                    token_type: "Bearer",
                    scope: "read",
                    created_at: Math.floor(new Date().getTime() / 1000),
                };
                reply.send(ret);
                return;
            }

            let client_id: any = body.client_id;
            const BASE_URL = `${request.protocol}://${request.hostname}`;
            const client = getClient(BASE_URL, '');
            let token = body.code || null;

            // Normalize client_id
            if (client_id instanceof Array) {
                client_id = client_id.toString();
            } else if (!client_id) {
                client_id = null;
            }

            // PKCE Validation for authorization_code grant
            if (body.grant_type === 'authorization_code') {
                if (!body.code_verifier) {
                    reply.code(400).send({
                        error: 'invalid_request',
                        error_description: 'code_verifier is required for authorization_code grant type'
                    });
                    return;
                }

                // Verify the stored client information matches
                const storedClientInfo = await this.#clientCache.get(`client:${body.code_verifier}`);
                if (!storedClientInfo) {
                    reply.code(400).send({
                        error: 'invalid_grant',
                        error_description: 'Invalid authorization code'
                    });
                    return;
                }
            }

            try {
                const atData = await client.fetchAccessToken(
                    client_id,
                    body.client_secret,
                    token || "",
                );
                const ret = {
                    access_token: atData.accessToken,
                    token_type: "Bearer",
                    scope: body.scope || "read write follow push",
                    created_at: Math.floor(new Date().getTime() / 1000),
                };
                reply.send(ret);
            } catch (err: any) {
                reply.code(401).send(err.response.data);
            }
        });

        fastify.all('/*', async (_request, reply) => {
            reply.code(404).send({
                error: {
                    message: 'Unknown OAuth endpoint.',
                    code: 'UNKNOWN_OAUTH_ENDPOINT',
                    id: 'aa49e620-26cb-4e28-aad6-8cbcb58db147',
                    kind: 'client',
                },
            });
        });
    }

    private async handleAuthorize(request: any, reply: any) {
        const query: any = request.query;
        let param = "mastodon=true";
        if (query.state) param += `&state=${query.state}`;
        if (query.redirect_uri) param += `&redirect_uri=${query.redirect_uri}`;
        const client = query.client_id ? query.client_id : "";
        reply.redirect(
            `${Buffer.from(client.toString(), 'base64').toString()}?${param}`,
        );
    }
}
