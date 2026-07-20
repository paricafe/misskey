/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import * as Redis from 'ioredis';
import { extract, parse as mfmParse } from 'mfm-js';
import { In, IsNull, MoreThan } from 'typeorm';
import { pipeline } from 'node:stream/promises';
import * as fs from 'node:fs';
import { MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { MiMeta, NoteFavoritesRepository, NotesRepository, UserNotePiningsRepository, UsersRepository } from '@/models/_.js';
import { createTemp } from '@/misc/create-temp.js';
import type { Packed } from '@/misc/json-schema.js';
import { extractMentions } from '@/misc/extract-mentions.js';
import { bindThis } from '@/decorators.js';
import { ApiError } from '@/server/api/error.js';
import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { MastodonApiCallService } from './MastodonApiCallService.js';
import { MASTODON_4_6_USER_ROUTES, type MastodonContractRoute } from './MastodonApiContract.js';
import { MastodonAuthenticateService } from './MastodonAuthenticateService.js';
import { MASTODON_COLLECTION_WINDOW_LIMIT, MastodonCollectionService, type MastodonCollectionPage } from './MastodonCollectionService.js';
import { MastodonConversationService, type MastodonConversation } from './MastodonConversationService.js';
import { MastodonEntityService } from './MastodonEntityService.js';
import { MastodonFilterService, type MastodonFilterApplyOptions, type MastodonFilterContext } from './MastodonFilterService.js';
import { MastodonMarkerService, type MastodonMarkerTimeline } from './MastodonMarkerService.js';
import { MastodonOAuthService } from './MastodonOAuthService.js';
import { MastodonNotificationService, type MastodonNotificationSource } from './MastodonNotificationService.js';
import { MastodonPaginationService } from './MastodonPaginationService.js';
import { MastodonPushSubscriptionService } from './MastodonPushSubscriptionService.js';
import { MastodonReportService } from './MastodonReportService.js';
import { MastodonScheduledStatusService } from './MastodonScheduledStatusService.js';
import { MastodonScopeService } from './MastodonScopeService.js';
import { MastodonStreamingApiServerService } from './MastodonStreamingApiServerService.js';
import { MastodonUserFeatureService, type MastodonUserTagState } from './MastodonUserFeatureService.js';
import { MastodonApiError, sendMastodonError } from './errors.js';
import type { MastodonAuth, MastodonUserAuth } from './types.js';
import type { MastodonApplicationRegistration } from './types.js';
import { digestCredential } from './utils.js';

type Dictionary = Record<string, unknown>;
type MastodonRequest = FastifyRequest<{ Body: Dictionary | undefined; Querystring: Dictionary; Params: Dictionary }>;

@Injectable()
export class MastodonApiServerService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteFavoritesRepository)
		private noteFavoritesRepository: NoteFavoritesRepository,

		@Inject(DI.userNotePiningsRepository)
		private userNotePiningsRepository: UserNotePiningsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private mastodonOAuthService: MastodonOAuthService,
		private mastodonAuthenticateService: MastodonAuthenticateService,
		private mastodonScopeService: MastodonScopeService,
		private mastodonApiCallService: MastodonApiCallService,
		private mastodonEntityService: MastodonEntityService,
		private mastodonPaginationService: MastodonPaginationService,
		private mastodonCollectionService: MastodonCollectionService,
		private mastodonConversationService: MastodonConversationService,
		private mastodonFilterService: MastodonFilterService,
		private mastodonMarkerService: MastodonMarkerService,
		private mastodonNotificationService: MastodonNotificationService,
		private mastodonScheduledStatusService: MastodonScheduledStatusService,
		private mastodonReportService: MastodonReportService,
		private mastodonPushSubscriptionService: MastodonPushSubscriptionService,
		private mastodonUserFeatureService: MastodonUserFeatureService,

		@Inject(DI.redis)
		private redis: Redis.Redis,

		private mastodonStreamingApiServerService: MastodonStreamingApiServerService,
	) {}

	@bindThis
	public createServer(fastify: FastifyInstance, _options: FastifyPluginOptions, done: (error?: Error) => void): void {
		fastify.register(cors, { origin: '*' });
		fastify.register(multipart, {
			limits: { fileSize: this.config.maxFileSize, files: 2 },
		});
		fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, parserDone) => {
			try {
				const parsed: Dictionary = {};
				for (const [key, value] of new URLSearchParams(body.toString())) {
					const current = parsed[key];
					parsed[key] = current == null ? value : Array.isArray(current) ? [...current, value] : [current, value];
				}
				parserDone(null, parsed);
			} catch (error) {
				parserDone(error as Error);
			}
		});
		fastify.addHook('onRequest', (_request, reply, hookDone) => {
			reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
			hookDone();
		});
		fastify.setErrorHandler((error, _request, reply) => sendMastodonError(reply, error));

		fastify.post<{ Body: Dictionary }>('/api/v1/apps', async request => {
			await this.assertApplicationRegistrationRate(request.ip);
			return { ...await this.mastodonOAuthService.registerApplication(request.body as MastodonApplicationRegistration), vapid_key: this.mastodonPushSubscriptionService.vapidPublicKey() };
		});
		fastify.get('/api/v1/instance', request => this.withOptionalToken(request as MastodonRequest, async () => this.instanceV1(request as MastodonRequest)));
		fastify.get('/api/v2/instance', request => this.withOptionalToken(request as MastodonRequest, async () => this.instanceV2(request as MastodonRequest)));
		fastify.get('/api/v1/instance/rules', request => this.withOptionalToken(request as MastodonRequest, async () => this.rules()));
		fastify.get('/api/v1/directory', (request, reply) => this.withOptionalToken(request as MastodonRequest, async () => {
			const query = request.query as Dictionary;
			const limit = this.integer(query.limit, 40, 1, 80);
			const offset = this.integer(query.offset, 0, 0);
			const users = await this.invokePublic('users', {
				limit,
				offset,
				sort: this.string(query.order) === 'new' ? '-createdAt' : '-updatedAt',
				state: 'alive',
				origin: this.boolean(query.local) ? 'local' : 'combined',
			}, null, request as MastodonRequest) as Packed<'UserDetailed'>[];
			const link = this.mastodonPaginationService.offsetLinkHeader(
				new URL(request.url, this.config.url).toString(),
				offset,
				limit,
				users.length === limit,
			);
			if (link != null) reply.header('Link', link);
			return users.map(user => this.mastodonEntityService.account(user));
		}));
		if (!fastify.hasRoute({ method: 'GET', url: '/api/v1/instance/peers' })) {
			fastify.get('/api/v1/instance/peers', request => this.withOptionalToken(request as MastodonRequest, async () => {
				const instances = await this.invokePublic('federation/instances', { limit: 100, offset: 0 }, null, request as MastodonRequest) as Array<{ host?: unknown }>;
				return [...new Set(instances.flatMap(instance => typeof instance.host === 'string' && instance.host.trim() !== ''
					? [instance.host.trim().toLowerCase()]
					: []))];
			}));
		}
		fastify.get('/api/v1/instance/activity', request => this.withOptionalToken(request as MastodonRequest, async () => {
			const [notes, users] = await Promise.all([
				this.invokePublic('charts/notes', { span: 'day', limit: 84 }, null, request as MastodonRequest),
				this.invokePublic('charts/users', { span: 'day', limit: 84 }, null, request as MastodonRequest),
			]);
			return this.mastodonEntityService.instanceActivity(
				notes as { local: { inc: number[] } },
				users as { local: { inc: number[] } },
			);
		}));
		fastify.get('/api/v1/instance/privacy_policy', request => this.withOptionalToken(request as MastodonRequest, async () => {
			if (this.meta.privacyPolicyUrl == null) throw new MastodonApiError(404, 'not_found', 'Record not found');
			return { updated_at: new Date(0).toISOString(), content: this.meta.privacyPolicyUrl };
		}));
		fastify.get('/api/v1/instance/extended_description', request => this.withOptionalToken(request as MastodonRequest, async () => {
			if (this.meta.description == null || this.meta.description === '') throw new MastodonApiError(404, 'not_found', 'Record not found');
			return { updated_at: new Date(0).toISOString(), content: this.meta.description };
		}));
		fastify.get('/api/v1/instance/terms_of_service', request => this.withOptionalToken(request as MastodonRequest, async () => {
			if (this.meta.termsOfServiceUrl == null) return [];
			return [{ updated_at: new Date(0).toISOString(), content: this.meta.termsOfServiceUrl }];
		}));
		fastify.get('/api/v1/custom_emojis', request => this.withOptionalToken(request as MastodonRequest, async () => {
			const response = await this.invokePublic('emojis', {}, null, request as MastodonRequest) as {
				emojis: Array<{ name: string; url: string; category?: string | null }>;
			};
			return response.emojis.map(emoji => ({
				shortcode: emoji.name,
				url: emoji.url,
				static_url: emoji.url,
				visible_in_picker: true,
				category: emoji.category ?? null,
			}));
		}));
		for (const path of ['/api/v1/trends', '/api/v1/trends/tags']) {
			fastify.get(path, (request, reply) => this.withOptionalToken(request as MastodonRequest, async () => {
				const pagination = this.offsetPagination(request.query as Dictionary, 10, 20);
				const trends = await this.invokePublic('hashtags/trend', {}, null, request as MastodonRequest) as Array<{ tag: string }>;
				return this.offsetPage(request, reply, trends.map(trend => this.mastodonEntityService.tag(trend.tag)), pagination);
			}));
		}
		fastify.get('/api/v1/trends/statuses', (request, reply) => this.withOptionalUser(request as MastodonRequest, 'read:statuses', async auth => {
			const pagination = this.offsetPagination(request.query as Dictionary, 20, 40);
			const notes = await this.invokePublic('notes/featured', { limit: pagination.readLimit }, auth, request as MastodonRequest) as Packed<'Note'>[];
			const page = this.offsetPage(request, reply, notes, pagination);
			return await this.statusesWithState(page, auth, 'public');
		}));
		fastify.get('/api/v1/trends/links', (request, reply) => this.withOptionalToken(request as MastodonRequest, async () => {
			const pagination = this.offsetPagination(request.query as Dictionary, 10, 20);
			const notes = await this.invokePublic('notes/featured', { limit: 100 }, null, request as MastodonRequest) as Packed<'Note'>[];
			const urls: string[] = [];
			const seen = new Set<string>();
			for (const note of notes) {
				if (note.text == null) continue;
				for (const node of extract(mfmParse(note.text), node => node.type === 'url' || node.type === 'link')) {
					if (node.type !== 'url' && node.type !== 'link') continue;
					const url = node.props.url;
					try {
						const parsed = new URL(url);
						if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
					} catch {
						continue;
					}
					if (seen.has(url)) continue;
					seen.add(url);
					urls.push(url);
				}
			}
			return this.offsetPage(request, reply, urls.map(url => this.mastodonEntityService.trendLink(url)), pagination);
		}));
		fastify.get('/api/v2/suggestions', request => this.withAuth(request as MastodonRequest, 'read:accounts', async auth => {
			const query = request.query as Dictionary;
			const users = await this.invoke('users/recommendation', {
				limit: this.integer(query.limit, 40, 1, 80),
				offset: this.integer(query.offset, 0, 0),
			}, auth, request as MastodonRequest) as Packed<'UserDetailed'>[];
			return users.map(user => ({
				source: 'global',
				sources: ['most_followed'],
				account: this.mastodonEntityService.account(user),
			}));
		}));
		fastify.get('/api/v1/suggestions', request => this.withAuth(request as MastodonRequest, 'read:accounts', async auth => {
			const query = request.query as Dictionary;
			const users = await this.invoke('users/recommendation', {
				limit: this.integer(query.limit, 40, 1, 80),
				offset: this.integer(query.offset, 0, 0),
			}, auth, request as MastodonRequest) as Packed<'UserDetailed'>[];
			return users.map(user => this.mastodonEntityService.account(user));
		}));
		fastify.get<{ Params: { name: string } }>('/api/v1/tags/:name', request => this.withOptionalToken(request as MastodonRequest, async () => {
			const hashtag = await this.invokePublic('hashtags/show', { tag: request.params.name }, null, request as MastodonRequest) as Packed<'Hashtag'>;
			return this.mastodonEntityService.tag(hashtag.tag);
		}));

		fastify.get('/api/v1/accounts/verify_credentials', request => this.withAuth(request as MastodonRequest, 'read:accounts', async auth => {
			const user = await this.invoke('i', {}, auth, request as MastodonRequest);
			return this.mastodonEntityService.credentialAccount(user as Packed<'MeDetailed'>);
		}));
		fastify.get('/api/v1/apps/verify_credentials', request => this.withAnyToken(request as MastodonRequest, async auth => {
			return { ...await this.mastodonOAuthService.getApplication(auth.token.clientId), vapid_key: this.mastodonPushSubscriptionService.vapidPublicKey() };
		}));
		fastify.get('/api/v1/preferences', request => this.withAuth(request as MastodonRequest, 'read:accounts', async () => ({
			'posting:default:visibility': 'public',
			'posting:default:sensitive': false,
			'posting:default:language': null,
			'reading:expand:media': 'default',
			'reading:expand:spoilers': false,
		} as Dictionary)));
		this.registerProfile(fastify);
		fastify.get('/api/v1/accounts', request => this.withToken(request as MastodonRequest, 'read:accounts', async tokenAuth => {
			const auth = tokenAuth.kind === 'user' ? tokenAuth : null;
			const users = await this.invokePublicBatch(
				'users/show',
				'userId',
				(request.query as Dictionary)['id[]'] ?? (request.query as Dictionary).id,
				auth,
				request as MastodonRequest,
			) as Packed<'UserDetailed'>[];
			return users.map(user => this.mastodonEntityService.account(user));
		}));
		fastify.get('/api/v1/accounts/search', request => this.withAuth(request as MastodonRequest, 'read:accounts', async auth => {
			const query = request.query as Dictionary;
			const q = this.string(query.q)?.trim();
			if (q == null || q === '') throw new MastodonApiError(400, 'invalid_request', 'q is required');
			const limit = this.integer(query.limit, 40, 1, 40);
			const offset = this.integer(query.offset, 0, 0);
			const users = await this.invoke('users/search', { query: q, limit, offset }, auth, request as MastodonRequest) as Packed<'UserDetailed'>[];
			return users.map(user => this.mastodonEntityService.account(user));
		}));
		fastify.get('/api/v1/accounts/lookup', request => this.withAuth(request as MastodonRequest, 'read:accounts', async auth => {
			const acct = this.string((request.query as Dictionary).acct);
			if (acct == null) throw new MastodonApiError(400, 'invalid_request', 'acct is required');
			const [username, ...hostParts] = acct.replace(/^@/u, '').split('@');
			const user = await this.invoke('users/show', { username, ...(hostParts.length > 0 ? { host: hostParts.join('@') } : {}) }, auth, request as MastodonRequest);
			return this.mastodonEntityService.account(user as Packed<'UserDetailed'>);
		}));
		fastify.get('/api/v1/accounts/relationships', request => this.withAuth(request as MastodonRequest, 'read:follows', async auth => {
			const ids = this.strings((request.query as Dictionary)['id[]'] ?? (request.query as Dictionary).id);
			const endorsedIds = new Set(await this.mastodonUserFeatureService.listEndorsementIds(auth.user.id));
			return await Promise.all(ids.map(async id => {
				const user = await this.invoke('users/show', { userId: id }, auth, request as MastodonRequest);
				return { ...this.mastodonEntityService.relationship(user as Packed<'UserDetailed'>), endorsed: endorsedIds.has(id) };
			}));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id', request => this.account(request as MastodonRequest, request.params.id));
		fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/statuses', (request, reply) => this.withOptionalUser(request as MastodonRequest, 'read:statuses', async auth => {
			const query = request.query as Dictionary;
			if (this.boolean(query.pinned)) {
				const user = await this.invokePublic('users/show', { userId: request.params.id }, auth, request as MastodonRequest) as Packed<'UserDetailed'>;
				const notes = this.filterAccountStatuses(user.pinnedNotes, query);
				return this.page(request, reply, notes, await this.statusesWithState(notes, auth, 'account'));
			}
			const nativeNotes = await this.invokePublic('users/notes', {
				userId: request.params.id,
				...this.mastodonPaginationService.toMisskey(query),
				withReplies: !this.boolean(query.exclude_replies),
				withRenotes: !this.boolean(query.exclude_reblogs),
			}, auth, request as MastodonRequest) as Packed<'Note'>[];
			const notes = this.filterAccountStatuses(nativeNotes, query);
			return this.page(request, reply, nativeNotes, await this.statusesWithState(notes, auth, 'account'));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/followers', (request, reply) => this.userPage(request as MastodonRequest, reply, 'users/followers', request.params.id));
		fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/following', (request, reply) => this.userPage(request as MastodonRequest, reply, 'users/following', request.params.id));
		fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/lists', request => this.withAuth(request as MastodonRequest, 'read:lists', async auth => {
			const lists = await this.invoke('users/lists/list', { userId: request.params.id }, auth, request as MastodonRequest) as Array<{ id: string; name: string }>;
			return lists.map(list => this.mastodonEntityService.list(list));
		}));

		this.registerRelationshipActions(fastify);
		this.registerTimelines(fastify);
		this.registerStatuses(fastify);
		this.registerNotifications(fastify);
		this.registerPushSubscriptions(fastify);
		this.registerSearch(fastify);
		this.registerLists(fastify);
		this.registerScheduledStatuses(fastify);
		this.registerAnnouncements(fastify);
		this.registerReports(fastify);
		this.registerCollections(fastify);
		this.registerConversations(fastify);
		this.registerFiltersAndMarkers(fastify);
		this.registerUserFeatures(fastify);
		this.registerCompatibilityRoutes(fastify);
		this.registerStreaming(fastify);

		done();
	}

	private registerStreaming(fastify: FastifyInstance): void {
		fastify.get('/api/v1/streaming/health', (_request, reply) => {
			reply.header('Cache-Control', 'private, no-store');
			reply.type('text/plain');
			return 'OK';
		});
		const handle = (request: FastifyRequest, reply: FastifyReply) => this.mastodonStreamingApiServerService.handleSse(request, reply);
		fastify.get('/api/v1/streaming', handle);
		fastify.get('/api/v1/streaming/*', handle);
	}

	private registerPushSubscriptions(fastify: FastifyInstance): void {
		fastify.post<{ Body: Dictionary }>('/api/v1/push/subscription', request => this.withAuth(request as MastodonRequest, 'push', async auth => {
			return await this.mastodonPushSubscriptionService.create(auth, this.bearerToken(request as MastodonRequest)!, request.body ?? {});
		}));
		fastify.get('/api/v1/push/subscription', request => this.withAuth(request as MastodonRequest, 'push', async auth => {
			return await this.mastodonPushSubscriptionService.get(auth);
		}));
		fastify.put<{ Body: Dictionary }>('/api/v1/push/subscription', request => this.withAuth(request as MastodonRequest, 'push', async auth => {
			return await this.mastodonPushSubscriptionService.update(auth, request.body ?? {});
		}));
		fastify.delete('/api/v1/push/subscription', request => this.withAuth(request as MastodonRequest, 'push', async auth => {
			return await this.mastodonPushSubscriptionService.delete(auth);
		}));
	}

	private registerRelationshipActions(fastify: FastifyInstance): void {
		const actions: Array<[string, string, string, string]> = [
			['follow', 'following/create', 'write:follows', 'userId'],
			['unfollow', 'following/delete', 'write:follows', 'userId'],
			['block', 'blocking/create', 'write:blocks', 'userId'],
			['unblock', 'blocking/delete', 'write:blocks', 'userId'],
			['mute', 'mute/create', 'write:mutes', 'userId'],
			['unmute', 'mute/delete', 'write:mutes', 'userId'],
		];
		for (const [action, endpoint, scope, idKey] of actions) {
			fastify.post<{ Params: { id: string }; Body: Dictionary }>(`/api/v1/accounts/:id/${action}`, request => this.withAuth(request as MastodonRequest, scope, async auth => {
				const data: Dictionary = { [idKey]: request.params.id };
				if (action === 'mute') {
					const duration = Number(this.string(request.body?.duration));
					if (Number.isFinite(duration) && duration > 0) data.expiresAt = Date.now() + duration * 1000;
				}
				await this.invoke(endpoint, data, auth, request as MastodonRequest);
				if (action === 'unfollow') await this.mastodonUserFeatureService.unendorse(auth.user.id, request.params.id);
				const user = await this.invoke('users/show', { userId: request.params.id }, auth, request as MastodonRequest);
				return this.mastodonEntityService.relationship(user as Packed<'UserDetailed'>);
			}));
		}
		fastify.post<{ Params: { id: string }; Body: Dictionary }>('/api/v1/accounts/:id/note', request => this.withAuth(request as MastodonRequest, 'write:accounts', async auth => {
			if (typeof request.body?.comment !== 'string') {
				throw new MastodonApiError(400, 'invalid_request', 'comment must be a string');
			}
			await this.invoke('users/update-memo', {
				userId: request.params.id,
				memo: request.body.comment,
			}, auth, request as MastodonRequest);
			const user = await this.invoke('users/show', { userId: request.params.id }, auth, request as MastodonRequest);
			return this.mastodonEntityService.relationship(user as Packed<'UserDetailed'>);
		}));
		fastify.post<{ Params: { id: string } }>('/api/v1/accounts/:id/remove_from_followers', request => this.withAuth(request as MastodonRequest, 'write:follows', async auth => {
			await this.invoke('following/invalidate', { userId: request.params.id }, auth, request as MastodonRequest);
			const user = await this.invoke('users/show', { userId: request.params.id }, auth, request as MastodonRequest);
			return this.mastodonEntityService.relationship(user as Packed<'UserDetailed'>);
		}));
		fastify.get('/api/v1/follow_requests', request => this.withAuth(request as MastodonRequest, 'read:follows', async auth => {
			const requests = await this.invoke('following/requests/list', this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100), auth, request as MastodonRequest) as Array<{ follower: Packed<'UserLite'> }>;
			return requests.map(followRequest => this.mastodonEntityService.account(followRequest.follower));
		}));
		for (const [action, endpoint] of [['authorize', 'following/requests/accept'], ['reject', 'following/requests/reject']] as const) {
			fastify.post<{ Params: { id: string } }>(`/api/v1/follow_requests/:id/${action}`, request => this.withAuth(request as MastodonRequest, 'write:follows', async auth => {
				await this.invoke(endpoint, { userId: request.params.id }, auth, request as MastodonRequest);
				const user = await this.invoke('users/show', { userId: request.params.id }, auth, request as MastodonRequest);
				return this.mastodonEntityService.relationship(user as Packed<'UserDetailed'>);
			}));
		}
	}

	private registerUserFeatures(fastify: FastifyInstance): void {
		fastify.get('/api/v1/followed_tags', (request, reply) => this.withAuth(request as MastodonRequest, 'read:follows', async auth => {
			const [followed, featured] = await Promise.all([
				this.mastodonUserFeatureService.listFollowedTags(auth.user.id),
				this.mastodonUserFeatureService.listFeaturedTags(auth.user.id),
			]);
			const page = this.compatibilityStatePage(followed, request.query as Dictionary, 200, 100);
			const featuredNames = new Set(featured.map(tag => tag.name));
			return this.page(request, reply, page, page.map(tag => this.mastodonEntityService.tag(tag.name, {
				following: true,
				featuring: featuredNames.has(tag.name),
			})));
		}));

		for (const action of ['follow', 'unfollow', 'feature', 'unfeature'] as const) {
			const scope = action === 'follow' || action === 'unfollow' ? 'write:follows' : 'write:accounts';
			fastify.post<{ Params: { name: string } }>(`/api/v1/tags/:name/${action}`, request => this.withAuth(request as MastodonRequest, scope, async auth => {
				if (action === 'follow') await this.mastodonUserFeatureService.followTag(auth.user.id, request.params.name);
				else if (action === 'unfollow') await this.mastodonUserFeatureService.unfollowTag(auth.user.id, request.params.name);
				else if (action === 'feature') await this.mastodonUserFeatureService.featureTag(auth.user.id, request.params.name);
				else await this.mastodonUserFeatureService.unfeatureTag(auth.user.id, request.params.name);
				const state = await this.mastodonUserFeatureService.tagFlags(auth.user.id, request.params.name);
				return this.mastodonEntityService.tag(state.name, state);
			}));
		}

		fastify.get('/api/v1/featured_tags', (request, reply) => this.withAuth(request as MastodonRequest, 'read:accounts', async auth => {
			const tags = this.compatibilityStatePage(
				await this.mastodonUserFeatureService.listFeaturedTags(auth.user.id),
				request.query as Dictionary,
				100,
			);
			return this.page(request, reply, tags, await this.featuredTagEntities(auth.user.id, tags, auth, request as MastodonRequest));
		}));
		fastify.post<{ Body: Dictionary }>('/api/v1/featured_tags', request => this.withAuth(request as MastodonRequest, 'write:accounts', async auth => {
			const name = this.string(request.body?.name);
			if (name == null || name === '') throw new MastodonApiError(400, 'invalid_request', 'name is required');
			const tag = await this.mastodonUserFeatureService.featureTag(auth.user.id, name);
			return (await this.featuredTagEntities(auth.user.id, [tag], auth, request as MastodonRequest))[0]!;
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v1/featured_tags/:id', request => this.withAuth(request as MastodonRequest, 'write:accounts', async auth => {
			return await this.mastodonUserFeatureService.unfeatureTagById(auth.user.id, request.params.id);
		}));
		fastify.get('/api/v1/featured_tags/suggestions', request => this.withAuth(request as MastodonRequest, 'read:accounts', async auth => {
			const [notes, followed, featured] = await Promise.all([
				this.invoke('users/notes', { userId: auth.user.id, limit: 100, withReplies: true, withRenotes: false }, auth, request as MastodonRequest) as Promise<Packed<'Note'>[]>,
				this.mastodonUserFeatureService.listFollowedTags(auth.user.id),
				this.mastodonUserFeatureService.listFeaturedTags(auth.user.id),
			]);
			const followedNames = new Set(followed.map(tag => tag.name));
			const featuredNames = new Set(featured.map(tag => tag.name));
			const names: string[] = [];
			const seen = new Set<string>();
			for (const note of notes) {
				for (const tag of note.tags ?? []) {
					const name = this.normalizedHashtag(tag);
					if (name === '' || seen.has(name) || featuredNames.has(name)) continue;
					seen.add(name);
					names.push(name);
					if (names.length === 10) break;
				}
				if (names.length === 10) break;
			}
			return names.map(name => this.mastodonEntityService.tag(name, {
				following: followedNames.has(name),
				featuring: false,
			}));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/featured_tags', (request, reply) => this.withOptionalUser(request as MastodonRequest, undefined, async auth => {
			await this.invokePublic('users/show', { userId: request.params.id }, auth, request as MastodonRequest);
			const tags = this.compatibilityStatePage(
				await this.mastodonUserFeatureService.listFeaturedTags(request.params.id),
				request.query as Dictionary,
				100,
			);
			return this.page(request, reply, tags, await this.featuredTagEntities(request.params.id, tags, auth, request as MastodonRequest));
		}));

		fastify.get('/api/v1/endorsements', (request, reply) => this.withAuth(request as MastodonRequest, 'read:accounts', async auth => {
			return await this.endorsementPage(auth.user.id, request as MastodonRequest, reply, auth);
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/accounts/:id/endorsements', (request, reply) => this.withOptionalUser(request as MastodonRequest, undefined, async auth => {
			await this.invokePublic('users/show', { userId: request.params.id }, auth, request as MastodonRequest);
			return await this.endorsementPage(request.params.id, request as MastodonRequest, reply, auth);
		}));
		for (const action of ['endorse', 'pin', 'unendorse', 'unpin'] as const) {
			fastify.post<{ Params: { id: string } }>(`/api/v1/accounts/:id/${action}`, request => this.withAuth(request as MastodonRequest, 'write:accounts', async auth => {
				const endorsed = action === 'endorse' || action === 'pin';
				if (endorsed) await this.mastodonUserFeatureService.endorse(auth.user.id, request.params.id);
				const user = await this.invokePublic('users/show', { userId: request.params.id }, auth, request as MastodonRequest) as Packed<'UserDetailed'>;
				if (!endorsed) await this.mastodonUserFeatureService.unendorse(auth.user.id, request.params.id);
				return { ...this.mastodonEntityService.relationship(user), endorsed };
			}));
		}

		fastify.get('/api/v1/domain_blocks', (request, reply) => this.withAuth(request as MastodonRequest, 'read:blocks', async auth => {
			const domains = this.compatibilityStatePage(
				(await this.mastodonUserFeatureService.listDomainBlocks(auth.user.id))
					.map(id => ({ id }))
					.sort((left, right) => right.id.localeCompare(left.id)),
				request.query as Dictionary,
				200,
				100,
			);
			return this.page(request, reply, domains, domains.map(domain => domain.id));
		}));
		for (const method of ['POST', 'DELETE'] as const) {
			fastify.route({
				method,
				url: '/api/v1/domain_blocks',
				handler: request => this.withAuth(request as MastodonRequest, 'write:blocks', async auth => {
					const domain = this.string((request.body as Dictionary | undefined)?.domain);
					if (domain == null || domain.trim() === '') throw new MastodonApiError(422, 'unprocessable_entity', 'domain is required');
					return method === 'POST'
						? await this.mastodonUserFeatureService.blockDomain(auth.user.id, domain)
						: await this.mastodonUserFeatureService.unblockDomain(auth.user.id, domain);
				}),
			});
		}
	}

	private registerTimelines(fastify: FastifyInstance): void {
		const timelines: Array<[string, string, string, (query: Dictionary, params: Dictionary) => Dictionary]> = [
			['/api/v1/timelines/public', 'notes/global-timeline', 'read:statuses', query => ({
				...this.mastodonPaginationService.toMisskey(query),
				withFiles: this.boolean(query.only_media),
			})],
			['/api/v1/timelines/tag/:tag', 'notes/search-by-tag', 'read:statuses', (query, params) => ({
				...this.mastodonPaginationService.toMisskey(query),
				tag: params.tag,
				withFiles: this.boolean(query.only_media),
				localHostOnly: this.boolean(query.local),
			})],
			['/api/v1/timelines/list/:id', 'notes/user-list-timeline', 'read:statuses', (query, params) => ({ ...this.mastodonPaginationService.toMisskey(query), listId: params.id })],
		];
		fastify.get('/api/v1/timelines/home', (request, reply) => this.withAuth(request as MastodonRequest, 'read:statuses', async auth => {
			const pagination = this.mastodonPaginationService.toMisskey(request.query as Dictionary);
			const [homeNotes, followedTags] = await Promise.all([
				this.invoke('notes/timeline', pagination, auth, request as MastodonRequest) as Promise<Packed<'Note'>[]>,
				this.mastodonUserFeatureService.listFollowedTags(auth.user.id),
			]);
			const homeTags = followedTags.slice(0, 20);
			const tagNotes = homeTags.length === 0
				? []
				: await this.invoke('notes/search-by-tag', {
					...pagination,
					limit: Math.min(100, pagination.limit * 3),
					query: homeTags.map(tag => [tag.name]),
				}, auth, request as MastodonRequest) as Packed<'Note'>[];
			const notes = [...new Map([...homeNotes, ...tagNotes].map(note => [note.id, note])).values()]
				.sort((left, right) => right.id.localeCompare(left.id))
				.slice(0, pagination.limit);
			return this.page(request, reply, notes, await this.statusesWithState(notes, auth, 'home'));
		}));
		for (const [path, endpoint, scope, data] of timelines) {
			const isPublic = path === '/api/v1/timelines/public' || path === '/api/v1/timelines/tag/:tag';
			const context: MastodonFilterContext = isPublic ? 'public' : 'home';
			if (isPublic) {
				fastify.get(path, (request, reply) => this.withOptionalUser(request as MastodonRequest, scope, async auth => {
					const query = request.query as Dictionary;
					if (this.boolean(query.remote)) {
						throw new MastodonApiError(422, 'unprocessable_entity', 'Remote-only timelines are not supported');
					}
					if (path === '/api/v1/timelines/tag/:tag' && [
						[query['any[]'], query.any],
						[query['all[]'], query.all],
						[query['none[]'], query.none],
					].some(values => this.strings(values).length > 0)) {
						throw new MastodonApiError(422, 'unprocessable_entity', 'Compound tag filters are not supported');
					}
					const selectedEndpoint = path === '/api/v1/timelines/public' && this.boolean(query.local)
						? 'notes/local-timeline'
						: endpoint;
					const notes = await this.invokePublic(selectedEndpoint, data(query, request.params as Dictionary), auth, request as MastodonRequest) as Packed<'Note'>[];
					return this.page(request, reply, notes, await this.statusesWithState(notes, auth, context));
				}));
			} else {
				fastify.get(path, (request, reply) => this.withAuth(request as MastodonRequest, scope, async auth => {
					const notes = await this.invoke(endpoint, data(request.query as Dictionary, request.params as Dictionary), auth, request as MastodonRequest) as Packed<'Note'>[];
					return this.page(request, reply, notes, await this.statusesWithState(notes, auth, context));
				}));
			}
		}
		fastify.get('/api/v1/bookmarks', (request, reply) => this.withAuth(request as MastodonRequest, 'read:bookmarks', async auth => {
			const favorites = await this.invoke('i/favorites', this.mastodonPaginationService.toMisskey(request.query as Dictionary), auth, request as MastodonRequest) as Array<{ id: string; note: Packed<'Note'> }>;
			return this.page(request, reply, favorites, await this.statusesWithState(favorites.map(favorite => favorite.note), auth, 'home'));
		}));
		fastify.get('/api/v1/favourites', (request, reply) => this.withAuth(request as MastodonRequest, 'read:favourites', async auth => {
			const reactions = await this.invoke('users/reactions', {
				userId: auth.user.id,
				...this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100),
			}, auth, request as MastodonRequest) as Array<{ id: string; note: Packed<'Note'> }>;
			return this.page(request, reply, reactions, await this.statusesWithState(reactions.map(reaction => reaction.note), auth, 'home'));
		}));
		fastify.get('/api/v1/blocks', (request, reply) => this.withAuth(request as MastodonRequest, 'read:blocks', async auth => {
			const blockings = await this.invoke('blocking/list', this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100), auth, request as MastodonRequest) as Packed<'Blocking'>[];
			return this.page(request, reply, blockings, blockings.map(blocking => this.mastodonEntityService.account(blocking.blockee)));
		}));
		fastify.get('/api/v1/mutes', (request, reply) => this.withAuth(request as MastodonRequest, 'read:mutes', async auth => {
			const mutings = await this.invoke('mute/list', this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100), auth, request as MastodonRequest) as Packed<'Muting'>[];
			return this.page(request, reply, mutings, mutings.map(muting => this.mastodonEntityService.account(muting.mutee)));
		}));
	}

	private registerStatuses(fastify: FastifyInstance): void {
		fastify.get('/api/v1/statuses', request => this.withToken(request as MastodonRequest, 'read:statuses', async tokenAuth => {
			const auth = tokenAuth.kind === 'user' ? tokenAuth : null;
			const notes = await this.invokePublicBatch(
				'notes/show',
				'noteId',
				(request.query as Dictionary)['id[]'] ?? (request.query as Dictionary).id,
				auth,
				request as MastodonRequest,
			) as Packed<'Note'>[];
			return await this.statusesWithState(notes, auth, 'thread');
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/statuses/:id', request => this.withOptionalUser(request as MastodonRequest, 'read:statuses', async auth => {
			const note = await this.invokePublic('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
			return await this.statusWithState(note, auth, 'thread');
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/statuses/:id/context', request => this.withOptionalUser(request as MastodonRequest, 'read:statuses', async auth => {
			const [ancestors, descendants] = await Promise.all([
				this.invokePublic('notes/conversation', { noteId: request.params.id }, auth, request as MastodonRequest),
				this.invokePublic('notes/children', { noteId: request.params.id, limit: 100 }, auth, request as MastodonRequest),
			]);
			const orderedAncestors = (ancestors as Packed<'Note'>[]).reverse();
			return {
				ancestors: await this.statusesWithState(orderedAncestors, auth, 'thread'),
				descendants: await this.statusesWithState(descendants as Packed<'Note'>[], auth, 'thread'),
			};
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/statuses/:id/source', request => this.withAuth(request as MastodonRequest, 'read:statuses', async auth => {
			const note = await this.invoke('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
			if (note.userId !== auth.user.id) throw new MastodonApiError(403, 'forbidden', 'Only the author can view the status source');
			return { id: note.id, text: note.text ?? '', spoiler_text: note.cw ?? '' };
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/statuses/:id/history', request => this.withOptionalScopedUser(request as MastodonRequest, 'read:statuses', async auth => {
			const note = await this.invokePublic('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
			return this.mastodonEntityService.statusEdits(note);
		}));
		fastify.post<{ Params: { id: string }; Body: Dictionary }>('/api/v1/statuses/:id/translate', request => this.withAuth(request as MastodonRequest, 'read:statuses', async auth => {
			const query = request.query as Dictionary;
			const acceptLanguage = this.string(request.headers['accept-language'])
				?.split(',')[0]
				?.split(';')[0]
				?.trim();
			const targetLanguage = this.string(request.body?.lang) ?? this.string(query.lang) ?? acceptLanguage;
			if (targetLanguage == null || targetLanguage === '') {
				throw new MastodonApiError(400, 'invalid_request', 'A target language is required');
			}
			let result: { sourceLang: string; text: string } | undefined;
			try {
				result = await this.invoke('notes/translate', {
					noteId: request.params.id,
					targetLang: targetLanguage,
				}, auth, request as MastodonRequest) as { sourceLang: string; text: string } | undefined;
			} catch (error) {
				if (error instanceof ApiError && error.code === 'UNAVAILABLE') {
					throw new MastodonApiError(422, 'unprocessable_entity', 'Translation is unavailable');
				}
				throw error;
			}
			if (result == null) throw new MastodonApiError(422, 'unprocessable_entity', 'Translation is unavailable');
			return this.mastodonEntityService.translation(result, targetLanguage);
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/statuses/:id/quotes', (request, reply) => this.withToken(request as MastodonRequest, 'read:statuses', async tokenAuth => {
			const auth = tokenAuth.kind === 'user' ? tokenAuth : null;
			const renotes = await this.invokePublic('notes/renotes', {
				noteId: request.params.id,
				...this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100),
			}, auth, request as MastodonRequest) as Packed<'Note'>[];
			const quotes = renotes.filter(note => note.renoteId != null && !this.isPurePackedRenote(note));
			return this.page(request, reply, quotes, await this.statusesWithState(quotes, auth, 'thread'));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/statuses/:id/reblogged_by', request => this.withOptionalUser(request as MastodonRequest, 'read:statuses', async auth => {
			const renotes = await this.invokePublic('notes/renotes', { noteId: request.params.id, ...this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100) }, auth, request as MastodonRequest) as Packed<'Note'>[];
			return renotes.map(note => this.mastodonEntityService.account(note.user));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/statuses/:id/favourited_by', request => this.withOptionalUser(request as MastodonRequest, 'read:statuses', async auth => {
			const reactions = await this.invokePublic('notes/reactions', { noteId: request.params.id, ...this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100) }, auth, request as MastodonRequest) as Array<{ user: Packed<'UserLite'> }>;
			return reactions.map(reaction => this.mastodonEntityService.account(reaction.user));
		}));
		fastify.post<{ Body: Dictionary }>('/api/v1/statuses', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			return await this.createStatus(request as MastodonRequest, auth);
		}));
		fastify.put<{ Params: { id: string }; Body: Dictionary }>('/api/v1/statuses/:id', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			this.validateStatusUpdateSemantics(request.body ?? {});
			const fileIds = this.strings(request.body?.['media_ids[]'] ?? request.body?.media_ids);
			const current = await this.invoke('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
			const hasMediaIds = Object.hasOwn(request.body ?? {}, 'media_ids') || Object.hasOwn(request.body ?? {}, 'media_ids[]');
			const effectiveFileIds = hasMediaIds ? fileIds : current.fileIds ?? [];
			await this.updateMediaSensitivity(effectiveFileIds, request.body?.sensitive, auth, request as MastodonRequest);
			const result = await this.invoke('notes/update', {
				noteId: request.params.id,
				text: this.string(request.body?.status) ?? current.text ?? '',
				cw: Object.hasOwn(request.body ?? {}, 'spoiler_text') ? this.string(request.body?.spoiler_text) || null : current.cw ?? null,
				...(effectiveFileIds.length > 0 ? { fileIds: effectiveFileIds } : {}),
			}, auth, request as MastodonRequest) as { updatedNote: Packed<'Note'> };
			return await this.statusWithState(result.updatedNote, auth, 'thread');
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v1/statuses/:id', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			const note = await this.invoke('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
			const status = await this.statusWithState(note, auth, 'thread');
			await this.invoke('notes/delete', { noteId: request.params.id }, auth, request as MastodonRequest);
			return { ...status, text: note.text ?? '' };
		}));

		const actions: Array<[string, string, string, Dictionary]> = [
			['favourite', 'notes/reactions/create', 'write:favourites', { reaction: '❤️' }],
			['unfavourite', 'notes/reactions/delete', 'write:favourites', {}],
			['bookmark', 'notes/favorites/create', 'write:bookmarks', {}],
			['unbookmark', 'notes/favorites/delete', 'write:bookmarks', {}],
		];
		for (const [action, endpoint, scope, extra] of actions) {
			fastify.post<{ Params: { id: string } }>(`/api/v1/statuses/:id/${action}`, request => this.withAuth(request as MastodonRequest, scope, async auth => {
				await this.invoke(endpoint, { noteId: request.params.id, ...extra }, auth, request as MastodonRequest);
				const note = await this.invoke('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest);
				const status = await this.statusWithState(note as Packed<'Note'>, auth, 'thread');
				if (action === 'favourite' || action === 'unfavourite') status.favourited = action === 'favourite';
				if (action === 'bookmark' || action === 'unbookmark') status.bookmarked = action === 'bookmark';
				return status;
			}));
		}
		for (const action of ['mute', 'unmute'] as const) {
			fastify.post<{ Params: { id: string } }>(`/api/v1/statuses/:id/${action}`, request => this.withAuth(request as MastodonRequest, 'write:mutes', async auth => {
				const note = await this.invokePublic('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
				const nativeNote = await this.notesRepository.findOneBy({ id: note.id });
				if (nativeNote == null) throw new MastodonApiError(404, 'not_found', 'Status not found');
				const threadId = nativeNote.threadId ?? nativeNote.id;
				if (action === 'mute') {
					await this.assertThreadMuteRate(auth.user.id);
					// The native endpoint's only durable effect is this row; its additional note query is not consumed.
					await this.mastodonUserFeatureService.muteThread(auth.user.id, threadId);
				} else await this.mastodonUserFeatureService.unmuteThread(auth.user.id, threadId);
				return { ...await this.statusWithState(note, auth, 'thread'), muted: action === 'mute' };
			}));
		}
		fastify.post<{ Params: { id: string } }>('/api/v1/statuses/:id/reblog', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			const result = await this.invoke('notes/create', { renoteId: request.params.id }, auth, request as MastodonRequest) as { createdNote: Packed<'Note'> };
			return { ...await this.statusWithState(result.createdNote, auth, 'thread'), reblogged: true };
		}));
		fastify.post<{ Params: { id: string } }>('/api/v1/statuses/:id/unreblog', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			const renotes = await this.notesRepository.findBy({ userId: auth.user.id, renoteId: request.params.id });
			for (const renote of renotes.filter(value => this.isPureRenote(value))) {
				await this.invoke('notes/delete', { noteId: renote.id }, auth, request as MastodonRequest);
			}
			const note = await this.invoke('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest);
			return { ...await this.statusWithState(note as Packed<'Note'>, auth, 'thread'), reblogged: false };
		}));
		for (const [action, endpoint] of [['pin', 'i/pin'], ['unpin', 'i/unpin']] as const) {
			fastify.post<{ Params: { id: string } }>(`/api/v1/statuses/:id/${action}`, request => this.withAuth(request as MastodonRequest, 'write:accounts', async auth => {
				await this.invoke(endpoint, { noteId: request.params.id }, auth, request as MastodonRequest);
				const note = await this.invoke('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
				return { ...await this.statusWithState(note, auth, 'thread'), pinned: action === 'pin' };
			}));
		}
		fastify.get<{ Params: { id: string } }>('/api/v1/polls/:id', request => this.withOptionalUser(request as MastodonRequest, 'read:statuses', async auth => {
			const note = await this.invokePublic('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
			if (note.poll == null) throw new MastodonApiError(404, 'not_found', 'Poll not found');
			return this.mastodonEntityService.poll(note.id, note.poll);
		}));
		fastify.post<{ Params: { id: string }; Body: Dictionary }>('/api/v1/polls/:id/votes', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			const choices = this.strings(request.body?.['choices[]'] ?? request.body?.choices)
				.map(choice => Number(choice))
				.filter(choice => Number.isInteger(choice) && choice >= 0);
			if (choices.length === 0) throw new MastodonApiError(400, 'invalid_request', 'At least one poll choice is required');
			for (const choice of new Set(choices)) {
				await this.invoke('notes/polls/vote', { noteId: request.params.id, choice }, auth, request as MastodonRequest);
			}
			const note = await this.invoke('notes/show', { noteId: request.params.id }, auth, request as MastodonRequest) as Packed<'Note'>;
			return note.poll == null ? null : this.mastodonEntityService.poll(note.id, note.poll);
		}));
		fastify.post('/api/v1/media', request => this.upload(request as MastodonRequest));
		fastify.post('/api/v2/media', request => this.upload(request as MastodonRequest));
		fastify.get<{ Params: { id: string } }>('/api/v1/media/:id', request => this.withAuth(request as MastodonRequest, 'write:media', async auth => {
			const file = await this.invoke('drive/files/show', { fileId: request.params.id }, auth, request as MastodonRequest);
			return this.mastodonEntityService.attachment(file as Packed<'DriveFile'>);
		}));
		fastify.put<{ Params: { id: string }; Body: Dictionary }>('/api/v1/media/:id', request => this.withAuth(request as MastodonRequest, 'write:media', async auth => {
			const file = await this.invoke('drive/files/update', { fileId: request.params.id, comment: this.string(request.body?.description) ?? null }, auth, request as MastodonRequest);
			return this.mastodonEntityService.attachment(file as Packed<'DriveFile'>);
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v1/media/:id', request => this.withAuth(request as MastodonRequest, 'write:media', async auth => {
			await this.invoke('drive/files/delete', { fileId: request.params.id }, auth, request as MastodonRequest);
			return {};
		}));
	}

	private validateStatusUpdateSemantics(body: Dictionary): void {
		if (Object.keys(body).some(key => key === 'poll' || key.startsWith('poll['))) {
			throw new MastodonApiError(422, 'unprocessable_entity', 'Poll changes cannot be persisted by this server');
		}
		// Mastodon clients commonly send language by default. Notes cannot persist it, so accept and ignore it.
		const quoteApprovalPolicy = this.string(body.quote_approval_policy);
		if (quoteApprovalPolicy != null && quoteApprovalPolicy !== '' && quoteApprovalPolicy !== 'public') {
			throw new MastodonApiError(422, 'unprocessable_entity', `Unsupported quote approval policy: ${quoteApprovalPolicy}`);
		}
	}

	private registerNotifications(fastify: FastifyInstance): void {
		fastify.get('/api/v1/notifications', (request, reply) => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
			const query = request.query as Dictionary;
			const options = this.notificationOptions(query);
			const includeMisskeyTypes = this.mastodonNotificationService.toMisskeyTypes(options.types).filter(type => type !== 'reaction:grouped' && type !== 'renote:grouped');
			const excludeMisskeyTypes = this.mastodonNotificationService.toMisskeyTypes(options.excludeTypes).filter(type => type !== 'reaction:grouped' && type !== 'renote:grouped');
			const sourcePage = await this.notificationSourcePage(auth, request as MastodonRequest, {
				...this.mastodonPaginationService.toMisskey(query, 80),
				limit: this.integer(query.limit, 40, 1, 80),
				markAsRead: false,
				...(options.types.length > 0 ? { includeTypes: [...new Set(includeMisskeyTypes)] } : {}),
				...(options.types.length === 0 && options.excludeTypes.length > 0 ? { excludeTypes: [...new Set(excludeMisskeyTypes)] } : {}),
			});
			const sources = sourcePage.sources;
			const visible = await this.mastodonNotificationService.list(auth.user.id, sources, { ...options, groupedTypes: undefined });
			return this.page(request, reply, sourcePage.page, visible.map(value => value.entity));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/notifications/:id', request => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
			const query = request.query as Dictionary;
			const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: 100, markAsRead: false });
			const visible = await this.mastodonNotificationService.list(auth.user.id, sources, { ...this.notificationOptions(query), groupedTypes: undefined });
			const notification = visible.find(value => value.entity.id === request.params.id);
			if (notification == null) throw new MastodonApiError(404, 'not_found', 'Notification not found');
			return notification.entity;
		}));
		fastify.post<{ Params: { id: string } }>('/api/v1/notifications/:id/dismiss', request => this.withAuth(request as MastodonRequest, 'write:notifications', async auth => {
			await this.mastodonNotificationService.dismiss(auth.user.id, request.params.id);
			return {};
		}));
		fastify.post('/api/v1/notifications/clear', request => this.withAuth(request as MastodonRequest, 'write:notifications', async auth => {
			await this.invoke('notifications/mark-all-as-read', {}, auth, request as MastodonRequest);
			return {};
		}));

		for (const version of ['v1', 'v2'] as const) {
			fastify.get(`/api/${version}/notifications/unread_count`, request => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
				const query = request.query as Dictionary;
				const options = this.notificationOptions(query);
				const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: Math.min(100, this.integer(query.limit, 100, 1, 1000)), markAsRead: false });
				const marker = await this.mastodonMarkerService.get(auth.user.id, ['notifications']);
				return await this.mastodonNotificationService.unreadCount(auth.user.id, sources, {
					...options,
					groupedTypes: version === 'v1' ? undefined : options.groupedTypes,
					lastReadId: marker.notifications?.last_read_id,
					limit: this.integer(query.limit, 100, 1, 1000),
					includeFiltered: this.boolean(query.include_filtered),
					grouped: version === 'v2',
				});
			}));
		}

		fastify.get('/api/v2/notifications', (request, reply) => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
			const query = request.query as Dictionary;
			const options = this.notificationOptions(query);
			const lowerId = this.notificationLowerId(query);
			const sourcePage = await this.notificationSourcePage(auth, request as MastodonRequest, {
				limit: 100,
				markAsRead: false,
				...(this.string(query.max_id) == null ? {} : { untilId: this.string(query.max_id) }),
				...(lowerId == null ? {} : { sinceId: lowerId }),
			});
			const sources = this.notificationCursorWindow(sourcePage.sources, query);
			const visible = await this.mastodonNotificationService.list(auth.user.id, sources, options);
			const result = await this.mastodonNotificationService.grouped(auth.user.id, visible, {
				groupedTypes: options.groupedTypes,
				limit: this.integer(query.limit, 40, 1, 80),
			});
			this.notificationGroupLink(request, reply, result.notification_groups, sourcePage.page);
			return result;
		}));

		fastify.get<{ Params: { group_key: string } }>('/api/v2/notifications/:group_key', request => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
			const query = request.query as Dictionary;
			const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: 100, markAsRead: false });
			const options = this.notificationOptions(query);
			const visible = await this.mastodonNotificationService.list(auth.user.id, sources, { ...options, groupedTypes: undefined });
			return await this.mastodonNotificationService.group(auth.user.id, visible, request.params.group_key);
		}));

		fastify.get<{ Params: { group_key: string } }>('/api/v2/notifications/:group_key/accounts', (request, reply) => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
			const query = request.query as Dictionary;
			const lowerId = this.notificationLowerId(query);
			const sources = await this.notificationSources(auth, request as MastodonRequest, {
				limit: 100,
				markAsRead: false,
				...(this.string(query.max_id) == null ? {} : { untilId: this.string(query.max_id) }),
				...(lowerId == null ? {} : { sinceId: lowerId }),
			});
			const options = this.notificationOptions(query);
			const visible = await this.mastodonNotificationService.list(auth.user.id, sources, { ...options, groupedTypes: undefined });
			const paginated = ['limit', 'max_id', 'min_id', 'since_id'].some(key => query[key] != null);
			if (!paginated) return await this.mastodonNotificationService.groupAccounts(auth.user.id, visible, request.params.group_key);
			const limit = this.integer(query.limit, 40, 1, 80);
			const page = await this.mastodonNotificationService.groupAccountsPage(auth.user.id, visible, request.params.group_key, {
				limit,
				maxId: this.string(query.max_id),
				minId: this.string(query.min_id),
				sinceId: this.string(query.since_id),
			});
			if (page.accounts.length < limit) return page.accounts;
			return this.page(request, reply, page.notifications, page.accounts);
		}));

		fastify.post<{ Params: { group_key: string } }>('/api/v2/notifications/:group_key/dismiss', request => this.withAuth(request as MastodonRequest, 'write:notifications', async auth => {
			const query = request.query as Dictionary;
			const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: 100, markAsRead: false });
			const options = this.notificationOptions(query);
			const visible = await this.mastodonNotificationService.list(auth.user.id, sources, { ...options, groupedTypes: undefined });
			return await this.mastodonNotificationService.dismissGroup(auth.user.id, visible, request.params.group_key);
		}));

		fastify.post('/api/v2/notifications/clear', request => this.withAuth(request as MastodonRequest, 'write:notifications', async auth => {
			const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: 100, markAsRead: false });
			const options = this.notificationOptions(request.query as Dictionary);
			const visible = await this.mastodonNotificationService.list(auth.user.id, sources, { ...options, groupedTypes: undefined });
			await this.mastodonNotificationService.clearGroups(auth.user.id, visible);
			await this.invoke('notifications/mark-all-as-read', {}, auth, request as MastodonRequest);
			return {};
		}));

		for (const version of ['v1', 'v2'] as const) {
			fastify.get(`/api/${version}/notifications/policy`, request => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
				const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: 100, markAsRead: false });
				const policy = await this.mastodonNotificationService.policyWithSummary(auth.user.id, sources);
				return version === 'v1' ? this.mastodonNotificationService.legacyPolicy(policy) : policy;
			}));
			for (const method of ['patch', 'put'] as const) {
				fastify[method](`/api/${version}/notifications/policy`, request => this.withAuth(request as MastodonRequest, 'write:notifications', async auth => {
					const body = this.dictionary(request.body) ?? {};
					if (version === 'v1') await this.mastodonNotificationService.updateLegacyPolicy(auth.user.id, this.notificationLegacyPolicyBody(body));
					else await this.mastodonNotificationService.updatePolicy(auth.user.id, body);
					const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: 100, markAsRead: false });
					const policy = await this.mastodonNotificationService.policyWithSummary(auth.user.id, sources);
					return version === 'v1' ? this.mastodonNotificationService.legacyPolicy(policy) : policy;
				}));
			}
		}

		fastify.get('/api/v1/notifications/requests/merged', request => this.withAuth(request as MastodonRequest, 'read:notifications', async () => ({ merged: true })));
		fastify.get('/api/v1/notifications/requests', (request, reply) => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
			const query = request.query as Dictionary;
			const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: 100, markAsRead: false });
			const requests = await this.mastodonNotificationService.requests(auth.user.id, sources, {
				limit: this.integer(query.limit, 40, 1, 80),
				maxId: this.string(query.max_id),
				minId: this.string(query.min_id),
				sinceId: this.string(query.since_id),
			});
			return this.page(request, reply, requests, requests);
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/notifications/requests/:id', request => this.withAuth(request as MastodonRequest, 'read:notifications', async auth => {
			const sources = await this.notificationSources(auth, request as MastodonRequest, { limit: 100, markAsRead: false });
			return await this.mastodonNotificationService.getRequest(auth.user.id, sources, request.params.id);
		}));
		for (const action of ['accept', 'dismiss'] as const) {
			fastify.post(`/api/v1/notifications/requests/${action}`, request => this.withAuth(request as MastodonRequest, 'write:notifications', async auth => {
				const ids = this.strings((request.body as Dictionary)?.['id[]'] ?? (request.body as Dictionary)?.ids ?? (request.body as Dictionary)?.id);
				if (ids.length === 0) throw new MastodonApiError(422, 'unprocessable_entity', 'At least one request id is required');
				if (action === 'accept') await this.mastodonNotificationService.acceptRequests(auth.user.id, ids);
				else await this.mastodonNotificationService.dismissRequests(auth.user.id, ids);
				return {};
			}));
			fastify.post<{ Params: { id: string } }>(`/api/v1/notifications/requests/:id/${action}`, request => this.withAuth(request as MastodonRequest, 'write:notifications', async auth => {
				if (action === 'accept') await this.mastodonNotificationService.acceptRequest(auth.user.id, request.params.id);
				else await this.mastodonNotificationService.dismissRequest(auth.user.id, request.params.id);
				return {};
			}));
		}
	}

	private registerSearch(fastify: FastifyInstance): void {
		fastify.get('/api/v2/search', async request => {
			const query = request.query as Dictionary;
			const q = this.string(query.q)?.trim();
			if (q == null || q === '') throw new MastodonApiError(400, 'invalid_request', 'q is required');
			const rawType = query.type;
			const type = this.string(rawType);
			if (rawType != null && type !== 'accounts' && type !== 'hashtags' && type !== 'statuses') {
				throw new MastodonApiError(400, 'invalid_request', 'type must be accounts, hashtags, or statuses');
			}
			const resolve = this.boolean(query.resolve);
			const following = this.boolean(query.following);
			const excludeUnreviewed = this.boolean(query.exclude_unreviewed);
			if (excludeUnreviewed && (type == null || type === 'hashtags')) {
				throw new MastodonApiError(422, 'unprocessable_entity', 'exclude_unreviewed is not supported for hashtag searches');
			}
			const requiresUser = resolve || following || Object.hasOwn(query, 'offset');
			const search = async (auth: MastodonUserAuth | null) => {
				const limit = this.integer(query.limit, 20, 1, 40);
				const offset = type == null ? 0 : this.integer(query.offset, 0, 0);
				const accountsInScope = type == null || type === 'accounts';
				const usesStatusOffset = type === 'statuses' && Object.hasOwn(query, 'offset');
				if (((following && accountsInScope) || usesStatusOffset) && offset + limit > 100) {
					throw new MastodonApiError(422, 'unprocessable_entity', 'The requested search window exceeds 100 results');
				}
				if (resolve && auth != null && this.isHttpUrl(q)) {
					let result: { type: 'Note'; object: Packed<'Note'> } | { type: 'User'; object: Packed<'UserDetailed'> } | null;
					try {
						result = await this.invoke('ap/show', { uri: q }, auth, request as MastodonRequest) as typeof result;
					} catch (error) {
						if (error instanceof ApiError && (error.code === 'NO_SUCH_OBJECT' || error.code === 'REQUEST_FAILED')) {
							result = null;
						} else {
							throw error;
						}
					}
					return {
						accounts: result?.type === 'User' && (type == null || type === 'accounts')
							? [this.mastodonEntityService.account(result.object)]
							: [],
						statuses: result?.type === 'Note' && (type == null || type === 'statuses')
							? await this.statusesWithState([result.object], auth, 'public')
							: [],
						hashtags: [],
					};
				}

				const accountId = this.string(query.account_id);
				const untilId = this.string(query.max_id);
				const sinceId = this.string(query.min_id);
				const [accounts, statuses, hashtags] = await Promise.all([
					accountsInScope
						? this.invokePublic('users/search', following
							? { query: q, limit: 100, offset: 0, detail: true }
							: { query: q, limit, offset }, auth, request as MastodonRequest) as Promise<Packed<'UserDetailed'>[]>
						: Promise.resolve([]),
					type == null || type === 'statuses'
						? this.invokePublic('notes/search', {
							query: q,
							limit: usesStatusOffset ? offset + limit : limit,
							...(accountId != null && accountId !== '' ? { userId: accountId } : {}),
							...(untilId != null && untilId !== '' ? { untilId } : {}),
							...(sinceId != null && sinceId !== '' ? { sinceId } : {}),
						}, auth, request as MastodonRequest) as Promise<Packed<'Note'>[]>
						: Promise.resolve([]),
					type == null || type === 'hashtags'
						? this.invokePublic('hashtags/search', { query: q, limit, offset }, auth, request as MastodonRequest) as Promise<string[]>
						: Promise.resolve([]),
				]);
				const visibleAccounts = following
					? accounts.filter(user => user.isFollowing === true).slice(offset, offset + limit)
					: accounts;
				const visibleStatuses = usesStatusOffset
					? statuses.slice(offset, offset + limit)
					: statuses;
				return {
					accounts: visibleAccounts.map(user => this.mastodonEntityService.account(user)),
					statuses: await this.statusesWithState(visibleStatuses, auth, 'public'),
					hashtags: hashtags.map(hashtag => this.mastodonEntityService.tag(hashtag)),
				};
			};
			return requiresUser
				? await this.withAuth(request as MastodonRequest, 'read:search', search)
				: await this.withOptionalUser(request as MastodonRequest, 'read:search', search);
		});
	}

	private registerLists(fastify: FastifyInstance): void {
		fastify.get('/api/v1/lists', request => this.withAuth(request as MastodonRequest, 'read:lists', async auth => {
			const lists = await this.invoke('users/lists/list', {}, auth, request as MastodonRequest) as Array<{ id: string; name: string }>;
			return lists.map(list => this.mastodonEntityService.list(list));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/lists/:id', request => this.withAuth(request as MastodonRequest, 'read:lists', async auth => {
			const list = await this.invoke('users/lists/show', { listId: request.params.id }, auth, request as MastodonRequest);
			return this.mastodonEntityService.list(list as { id: string; name: string });
		}));
		fastify.post<{ Body: Dictionary }>('/api/v1/lists', request => this.withAuth(request as MastodonRequest, 'write:lists', async auth => {
			const list = await this.invoke('users/lists/create', { name: this.string(request.body?.title) }, auth, request as MastodonRequest);
			return this.mastodonEntityService.list(list as { id: string; name: string });
		}));
		fastify.put<{ Params: { id: string }; Body: Dictionary }>('/api/v1/lists/:id', request => this.withAuth(request as MastodonRequest, 'write:lists', async auth => {
			const list = await this.invoke('users/lists/update', { listId: request.params.id, name: this.string(request.body?.title) }, auth, request as MastodonRequest);
			return this.mastodonEntityService.list(list as { id: string; name: string });
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v1/lists/:id', request => this.withAuth(request as MastodonRequest, 'write:lists', async auth => {
			await this.invoke('users/lists/delete', { listId: request.params.id }, auth, request as MastodonRequest);
			return {};
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/lists/:id/accounts', request => this.withAuth(request as MastodonRequest, 'read:lists', async auth => {
			const memberships = await this.invoke('users/lists/get-memberships', {
				listId: request.params.id,
				...this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100),
			}, auth, request as MastodonRequest) as Array<{ user: Packed<'UserLite'> }>;
			return memberships.map(membership => this.mastodonEntityService.account(membership.user));
		}));
		for (const [method, endpoint] of [['post', 'users/lists/push'], ['delete', 'users/lists/pull']] as const) {
			fastify[method]<{ Params: { id: string }; Body: Dictionary }>('/api/v1/lists/:id/accounts', request => this.withAuth(request as MastodonRequest, 'write:lists', async auth => {
				for (const userId of this.strings(request.body?.['account_ids[]'] ?? request.body?.account_ids)) {
					await this.invoke(endpoint, { listId: request.params.id, userId }, auth, request as MastodonRequest);
				}
				return {};
			}));
		}
	}

	private registerFiltersAndMarkers(fastify: FastifyInstance): void {
		fastify.get('/api/v1/filters', request => this.withAuth(request as MastodonRequest, 'read:filters', async auth => {
			return await this.mastodonFilterService.listV1(auth.user.id);
		}));
		fastify.post<{ Body: Dictionary }>('/api/v1/filters', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.createV1(auth.user.id, this.filterInput(request.body ?? {}));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/filters/:id', request => this.withAuth(request as MastodonRequest, 'read:filters', async auth => {
			return await this.mastodonFilterService.getV1(auth.user.id, request.params.id);
		}));
		fastify.put<{ Params: { id: string }; Body: Dictionary }>('/api/v1/filters/:id', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.updateV1(auth.user.id, request.params.id, this.filterInput(request.body ?? {}));
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v1/filters/:id', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.deleteV1(auth.user.id, request.params.id);
		}));

		fastify.get('/api/v2/filters', request => this.withAuth(request as MastodonRequest, 'read:filters', async auth => {
			return await this.mastodonFilterService.listV2(auth.user.id);
		}));
		fastify.post<{ Body: Dictionary }>('/api/v2/filters', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.createV2(auth.user.id, this.filterInput(request.body ?? {}));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v2/filters/:id', request => this.withAuth(request as MastodonRequest, 'read:filters', async auth => {
			return await this.mastodonFilterService.getV2(auth.user.id, request.params.id);
		}));
		fastify.put<{ Params: { id: string }; Body: Dictionary }>('/api/v2/filters/:id', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.updateV2(auth.user.id, request.params.id, this.filterInput(request.body ?? {}));
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v2/filters/:id', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.deleteV2(auth.user.id, request.params.id);
		}));

		fastify.get<{ Params: { filter_id: string } }>('/api/v2/filters/:filter_id/keywords', request => this.withAuth(request as MastodonRequest, 'read:filters', async auth => {
			return await this.mastodonFilterService.listKeywords(auth.user.id, request.params.filter_id);
		}));
		fastify.post<{ Params: { filter_id: string }; Body: Dictionary }>('/api/v2/filters/:filter_id/keywords', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.createKeyword(auth.user.id, request.params.filter_id, request.body ?? {});
		}));
		fastify.get<{ Params: { id: string } }>('/api/v2/filters/keywords/:id', request => this.withAuth(request as MastodonRequest, 'read:filters', async auth => {
			return await this.mastodonFilterService.getKeyword(auth.user.id, request.params.id);
		}));
		fastify.put<{ Params: { id: string }; Body: Dictionary }>('/api/v2/filters/keywords/:id', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.updateKeyword(auth.user.id, request.params.id, request.body ?? {});
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v2/filters/keywords/:id', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.deleteKeyword(auth.user.id, request.params.id);
		}));

		fastify.get<{ Params: { filter_id: string } }>('/api/v2/filters/:filter_id/statuses', request => this.withAuth(request as MastodonRequest, 'read:filters', async auth => {
			return await this.mastodonFilterService.listStatuses(auth.user.id, request.params.filter_id);
		}));
		fastify.post<{ Params: { filter_id: string }; Body: Dictionary }>('/api/v2/filters/:filter_id/statuses', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.createStatus(auth.user.id, request.params.filter_id, request.body ?? {});
		}));
		fastify.get<{ Params: { id: string } }>('/api/v2/filters/statuses/:id', request => this.withAuth(request as MastodonRequest, 'read:filters', async auth => {
			return await this.mastodonFilterService.getStatus(auth.user.id, request.params.id);
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v2/filters/statuses/:id', request => this.withAuth(request as MastodonRequest, 'write:filters', async auth => {
			return await this.mastodonFilterService.deleteStatus(auth.user.id, request.params.id);
		}));

		fastify.get('/api/v1/markers', request => this.withAuth(request as MastodonRequest, 'read:statuses', async auth => {
			const query = request.query as Dictionary;
			return await this.mastodonMarkerService.get(
				auth.user.id,
				this.strings(query['timeline[]'] ?? query.timeline) as MastodonMarkerTimeline[],
			);
		}));
		fastify.post<{ Body: Dictionary }>('/api/v1/markers', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			return await this.mastodonMarkerService.update(auth.user.id, this.markerInput(request.body ?? {}));
		}));
	}

	private registerCollections(fastify: FastifyInstance): void {
		fastify.post<{ Body: Dictionary }>('/api/v1/collections', request => this.withAuth(request as MastodonRequest, 'write:collections', async auth => {
			const body = request.body ?? {};
			const input = { ...body };
			if (Object.hasOwn(body, 'account_ids[]')) {
				delete input['account_ids[]'];
				input.account_ids = this.strings(body['account_ids[]']);
			}
			const collection = await this.mastodonCollectionService.create(auth.user.id, input);
			return { collection };
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/collections/:id', request => this.withOptionalScopedUser(request as MastodonRequest, 'read:collections', async auth => {
			return await this.mastodonCollectionService.get(request.params.id, auth?.user.id ?? null);
		}));
		fastify.get<{ Params: { account_id: string } }>('/api/v1/accounts/:account_id/collections', (request, reply) => this.withOptionalScopedUser(request as MastodonRequest, 'read:collections', async auth => {
			const pagination = this.collectionPagination(request.query as Dictionary);
			const page = await this.mastodonCollectionService.listByAccount(request.params.account_id, auth?.user.id ?? null, pagination);
			this.collectionLink(request, reply, pagination, page);
			return { collections: page.items };
		}));
		fastify.get<{ Params: { account_id: string } }>('/api/v1/accounts/:account_id/in_collections', (request, reply) => this.withAuth(request as MastodonRequest, 'read:collections', async auth => {
			const pagination = this.collectionPagination(request.query as Dictionary);
			const page = await this.mastodonCollectionService.listInCollections(request.params.account_id, auth.user.id, pagination);
			this.collectionLink(request, reply, pagination, page);
			return { collections: page.items };
		}));
		for (const method of ['patch', 'put'] as const) {
			fastify[method]<{ Params: { id: string }; Body: Dictionary }>('/api/v1/collections/:id', request => this.withAuth(request as MastodonRequest, 'write:collections', async auth => ({
				collection: await this.mastodonCollectionService.update(auth.user.id, request.params.id, request.body ?? {}),
			})));
		}
		fastify.delete<{ Params: { id: string } }>('/api/v1/collections/:id', request => this.withAuth(request as MastodonRequest, 'write:collections', async auth => {
			return await this.mastodonCollectionService.delete(auth.user.id, request.params.id);
		}));
		fastify.post<{ Params: { collection_id: string }; Body: Dictionary }>('/api/v1/collections/:collection_id/items', request => this.withAuth(request as MastodonRequest, 'write:collections', async auth => ({
			collection_item: await this.mastodonCollectionService.addItem(
				auth.user.id,
				request.params.collection_id,
				this.string(request.body?.account_id) ?? '',
			),
		})));
		fastify.delete<{ Params: { collection_id: string; id: string } }>('/api/v1/collections/:collection_id/items/:id', request => this.withAuth(request as MastodonRequest, 'write:collections', async auth => {
			return await this.mastodonCollectionService.removeItem(auth.user.id, request.params.collection_id, request.params.id);
		}));
		fastify.post<{ Params: { collection_id: string; id: string } }>('/api/v1/collections/:collection_id/items/:id/revoke', request => this.withAuth(request as MastodonRequest, 'write:collections', async auth => {
			return await this.mastodonCollectionService.revoke(auth.user.id, request.params.collection_id, request.params.id);
		}));
	}

	private collectionPagination(query: Dictionary): { limit: number; offset: number } {
		const limit = this.integer(query.limit, 40, 1, 80);
		const offset = this.integer(query.offset, 0, 0);
		if (offset + limit > MASTODON_COLLECTION_WINDOW_LIMIT) {
			throw new MastodonApiError(422, 'validation_error', `collection window exceeds ${MASTODON_COLLECTION_WINDOW_LIMIT}`);
		}
		return { limit, offset };
	}

	private collectionLink(
		request: FastifyRequest,
		reply: FastifyReply,
		pagination: { limit: number; offset: number },
		page: MastodonCollectionPage,
	): void {
		const hasMoreWithinWindow = page.hasMore && pagination.offset + (2 * pagination.limit) <= MASTODON_COLLECTION_WINDOW_LIMIT;
		const link = this.mastodonPaginationService.offsetLinkHeader(
			new URL(request.url, this.config.url).toString(),
			pagination.offset,
			pagination.limit,
			hasMoreWithinWindow,
		);
		if (link != null) reply.header('Link', link);
	}

	private filterInput(body: Dictionary): Dictionary {
		const input: Dictionary = {
			...body,
			context: body['context[]'] ?? body.context,
		};
		const keywordAttributes = this.keywordAttributes(body);
		if (keywordAttributes != null) input.keywords_attributes = keywordAttributes;
		return input;
	}

	private keywordAttributes(body: Dictionary): Dictionary[] | null {
		if (Array.isArray(body.keywords_attributes)) {
			return body.keywords_attributes.flatMap(value => value != null && typeof value === 'object' && !Array.isArray(value) ? [value as Dictionary] : []);
		}
		if (body.keywords_attributes != null && typeof body.keywords_attributes === 'object') {
			return Object.values(body.keywords_attributes).flatMap(value => value != null && typeof value === 'object' && !Array.isArray(value) ? [value as Dictionary] : []);
		}
		const attributes = new Map<number, Dictionary>();
		for (const [key, rawValue] of Object.entries(body)) {
			const match = /^keywords_attributes\[(\d*)\]\[(id|keyword|whole_word|_destroy)\]$/u.exec(key);
			if (match == null) continue;
			const values = Array.isArray(rawValue) ? rawValue : [rawValue];
			const explicitIndex = match[1] === '' ? null : Number(match[1]);
			values.forEach((value, valueIndex) => {
				const index = explicitIndex ?? valueIndex;
				const attribute = attributes.get(index) ?? {};
				attribute[match[2]] = value;
				attributes.set(index, attribute);
			});
		}
		return attributes.size === 0 ? null : [...attributes.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
	}

	private markerInput(body: Dictionary): Dictionary {
		const result: Dictionary = {};
		for (const [key, value] of Object.entries(body)) {
			if (key === 'home' || key === 'notifications') {
				result[key] = value;
				continue;
			}
			const match = /^(home|notifications)\[(last_read_id|version)\]$/u.exec(key);
			if (match == null) {
				result[key] = value;
				continue;
			}
			const marker = result[match[1]] != null && typeof result[match[1]] === 'object' && !Array.isArray(result[match[1]])
				? result[match[1]] as Dictionary
				: {};
			marker[match[2]] = value;
			result[match[1]] = marker;
		}
		return result;
	}

	private registerCompatibilityRoutes(fastify: FastifyInstance): void {
		for (const route of MASTODON_4_6_USER_ROUTES) {
			if (route.transport === 'websocket' || route.behavior === 'implemented') continue;
			fastify.route({
				method: route.method,
				url: route.path,
				handler: request => {
					const mastodonRequest = request as MastodonRequest;
					this.validateCompatibilityRequest(route, mastodonRequest);
					const respond = async () => this.compatibilityResponse(route);
					if (route.auth === 'public') return this.withOptionalToken(mastodonRequest, respond, route.scope);
					if (route.auth === 'token') return this.withToken(mastodonRequest, route.scope, respond);
					return this.withAuth(mastodonRequest, route.scope, respond);
				},
			});
		}
	}

	private registerConversations(fastify: FastifyInstance): void {
		fastify.get('/api/v1/conversations', (request, reply) => this.withAuth(request as MastodonRequest, 'read:statuses', async auth => {
			const query = request.query as Dictionary;
			const conversations = await this.mastodonConversationService.list(auth.user, {
				limit: this.integer(query.limit, 20, 1, 40),
				maxId: this.string(query.max_id),
				minId: this.string(query.min_id),
				sinceId: this.string(query.since_id),
			});
			const entities = await Promise.all(conversations.map(conversation => this.conversation(conversation, auth)));
			return this.page(request, reply, conversations.map(conversation => ({ id: conversation.lastStatus.id })), entities);
		}));

		fastify.delete<{ Params: { id: string } }>('/api/v1/conversations/:id', request => this.withAuth(request as MastodonRequest, 'write:conversations', async auth => {
			return await this.mastodonConversationService.delete(auth.user, request.params.id);
		}));

		for (const action of ['read', 'unread'] as const) {
			fastify.post<{ Params: { id: string } }>(`/api/v1/conversations/:id/${action}`, request => this.withAuth(request as MastodonRequest, 'write:conversations', async auth => {
				const conversation = await this.mastodonConversationService[action](auth.user, request.params.id);
				return await this.conversation(conversation, auth);
			}));
		}
	}

	private async conversation(conversation: MastodonConversation, auth: MastodonUserAuth): Promise<Dictionary> {
		return {
			id: conversation.id,
			unread: conversation.unread,
			accounts: conversation.accounts,
			last_status: await this.statusWithState(conversation.lastStatus, auth, 'thread'),
		};
	}

	private registerProfile(fastify: FastifyInstance): void {
		fastify.get('/api/v1/profile', request => this.withAuth(request as MastodonRequest, ['profile', 'read:accounts'], async auth => {
			const user = await this.invoke('i', {}, auth, request as MastodonRequest);
			return this.mastodonEntityService.profile(user as Packed<'MeDetailed'>);
		}));
		fastify.patch('/api/v1/profile', request => this.updateProfile(request as MastodonRequest, 'profile'));
		fastify.patch('/api/v1/accounts/update_credentials', request => this.updateProfile(request as MastodonRequest, 'credential-account'));

		for (const [kind, update] of [
			['avatar', { avatarId: null }],
			['header', { bannerId: null }],
		] as const) {
			fastify.delete(`/api/v1/profile/${kind}`, request => this.withAuth(request as MastodonRequest, 'write:accounts', async auth => {
				await this.invoke('i/update', update, auth, request as MastodonRequest);
				const user = await this.invoke('i', {}, auth, request as MastodonRequest);
				return this.mastodonEntityService.profile(user as Packed<'MeDetailed'>);
			}));
		}
	}

	private registerReports(fastify: FastifyInstance): void {
		fastify.post('/api/v1/reports', request => this.withAuth(request as MastodonRequest, 'write:reports', async auth => {
			const body = (request.body as Dictionary | undefined) ?? {};
			const accountId = this.string(body.account_id);
			if (accountId == null || accountId === '') throw new MastodonApiError(400, 'invalid_request', 'account_id is required');
			const category = this.string(body.category) ?? 'other';
			if (category !== 'spam' && category !== 'violation' && category !== 'other') {
				throw new MastodonApiError(422, 'unprocessable_entity', `Unsupported report category: ${category}`);
			}
			const statusIds = this.strings(body['status_ids[]'] ?? body.status_ids);
			for (const statusId of statusIds) {
				const note = await this.invoke('notes/show', { noteId: statusId }, auth, request as MastodonRequest) as Packed<'Note'>;
				if (note.userId !== accountId) {
					throw new MastodonApiError(422, 'unprocessable_entity', 'Every reported status must belong to the reported account');
				}
			}
			const result = await this.mastodonReportService.create(auth.user, {
				accountId,
				comment: this.string(body.comment) ?? '',
				category,
				statusIds,
				ruleIds: this.strings(body['rule_ids[]'] ?? body.rule_ids),
				collectionIds: this.strings(body['collection_ids[]'] ?? body.collection_ids),
				forwardToDomains: this.strings(body['forward_to_domains[]'] ?? body.forward_to_domains),
				forward: this.boolean(body.forward),
			});
			return this.mastodonEntityService.report(result.report, result.createdAt, result.targetUser, result.input);
		}));
	}

	private registerAnnouncements(fastify: FastifyInstance): void {
		fastify.get('/api/v1/announcements', (request, reply) => this.withAuth(request as MastodonRequest, undefined, async auth => {
			const announcements = await this.invoke('announcements', {
				...this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100),
				isActive: true,
			}, auth, request as MastodonRequest) as Packed<'Announcement'>[];
			return this.page(request, reply, announcements, announcements.map(announcement => this.mastodonEntityService.announcement(announcement)));
		}));
		fastify.post<{ Params: { id: string } }>('/api/v1/announcements/:id/dismiss', request => this.withAuth(request as MastodonRequest, 'write:accounts', async auth => {
			await this.invoke('i/read-announcement', { announcementId: request.params.id }, auth, request as MastodonRequest);
			return {};
		}));
	}

	private registerScheduledStatuses(fastify: FastifyInstance): void {
		fastify.get('/api/v1/scheduled_statuses', (request, reply) => this.withAuth(request as MastodonRequest, 'read:statuses', async auth => {
			const drafts = await this.invoke('notes/drafts/list', {
				...this.mastodonPaginationService.toMisskey(request.query as Dictionary, 100),
				scheduled: true,
			}, auth, request as MastodonRequest) as Packed<'NoteDraft'>[];
			return this.page(request, reply, drafts, drafts.map(draft => this.mastodonEntityService.scheduledStatus(draft)));
		}));
		fastify.get<{ Params: { id: string } }>('/api/v1/scheduled_statuses/:id', request => this.withAuth(request as MastodonRequest, 'read:statuses', async auth => {
			const draft = await this.mastodonScheduledStatusService.get(auth.user, request.params.id);
			return this.mastodonEntityService.scheduledStatus(draft);
		}));
		fastify.put<{ Params: { id: string }; Body: Dictionary }>('/api/v1/scheduled_statuses/:id', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			await this.mastodonScheduledStatusService.get(auth.user, request.params.id);
			const scheduledAt = this.parseScheduledAt(request.body?.scheduled_at, true)!;
			const result = await this.invoke('notes/drafts/update', {
				draftId: request.params.id,
				scheduledAt: scheduledAt.getTime(),
				isActuallyScheduled: true,
			}, auth, request as MastodonRequest) as { updatedDraft: Packed<'NoteDraft'> };
			return this.mastodonEntityService.scheduledStatus(result.updatedDraft);
		}));
		fastify.delete<{ Params: { id: string } }>('/api/v1/scheduled_statuses/:id', request => this.withAuth(request as MastodonRequest, 'write:statuses', async auth => {
			await this.mastodonScheduledStatusService.get(auth.user, request.params.id);
			await this.invoke('notes/drafts/delete', { draftId: request.params.id }, auth, request as MastodonRequest);
			return {};
		}));
	}

	private async updateProfile(request: MastodonRequest, response: 'profile' | 'credential-account'): Promise<Dictionary> {
		return await this.withAuth(request, 'write:accounts', async auth => {
			let body = request.body ?? {};
			const uploads: Array<{ fieldname: 'avatar' | 'header'; filename: string; path: string }> = [];
			const cleanups: Array<() => void> = [];
			try {
				if (request.isMultipart()) {
					body = {};
					const fileFields = new Set<string>();
					for await (const part of request.parts()) {
						if (part.type !== 'file') {
							const current = body[part.fieldname];
							body[part.fieldname] = current == null
								? part.value
								: Array.isArray(current)
									? [...current, part.value]
									: [current, part.value];
							continue;
						}
						if (part.fieldname !== 'avatar' && part.fieldname !== 'header') {
							part.file.resume();
							throw new MastodonApiError(400, 'invalid_request', `Unexpected file field: ${part.fieldname}`);
						}
						if (fileFields.has(part.fieldname)) {
							part.file.resume();
							throw new MastodonApiError(400, 'invalid_request', `Duplicate file field: ${part.fieldname}`);
						}
						fileFields.add(part.fieldname);
						const [path, cleanup] = await createTemp();
						cleanups.push(cleanup);
						await pipeline(part.file, fs.createWriteStream(path));
						if (part.file.truncated) throw new MastodonApiError(413, 'file_too_large', 'File is too large');
						uploads.push({ fieldname: part.fieldname, filename: part.filename, path });
					}
				}

				const update = this.profileUpdateData(body);
				for (const upload of uploads) {
					const file = await this.mastodonApiCallService.invoke('drive/files/create', {
						name: upload.filename,
					}, auth, request, { name: upload.filename, path: upload.path }) as Packed<'DriveFile'>;
					update[upload.fieldname === 'avatar' ? 'avatarId' : 'bannerId'] = file.id;
				}
				await this.invoke('i/update', update, auth, request);
				const user = await this.invoke('i', {}, auth, request) as Packed<'MeDetailed'>;
				return response === 'profile'
					? this.mastodonEntityService.profile(user)
					: this.mastodonEntityService.credentialAccount(user);
			} finally {
				for (const cleanup of cleanups) cleanup();
			}
		});
	}

	private profileUpdateData(body: Dictionary): Dictionary {
		const update: Dictionary = {};
		const assignString = (source: string, target: string) => {
			if (!Object.hasOwn(body, source)) return;
			if (body[source] == null) {
				update[target] = null;
				return;
			}
			const value = this.string(body[source]);
			if (value == null) throw new MastodonApiError(400, 'invalid_request', `${source} must be a string`);
			update[target] = value;
		};
		const assignBoolean = (source: string, target: string) => {
			if (!Object.hasOwn(body, source)) return;
			update[target] = this.profileBoolean(body[source], source);
		};
		assignString('display_name', 'name');
		assignString('note', 'description');
		assignBoolean('locked', 'isLocked');
		assignBoolean('discoverable', 'isExplorable');
		assignBoolean('bot', 'isBot');

		const fields = this.profileFields(body);
		if (fields != null) update.fields = fields;

		const source = body.source != null && typeof body.source === 'object' && !Array.isArray(body.source)
			? body.source as Dictionary
			: {};
		const nested = (name: string): { present: boolean; value: unknown } => {
			const flat = `source[${name}]`;
			if (Object.hasOwn(body, flat)) return { present: true, value: body[flat] };
			return Object.hasOwn(source, name) ? { present: true, value: source[name] } : { present: false, value: undefined };
		};
		const unsupported = (name: string) => {
			throw new MastodonApiError(422, 'unprocessable_entity', `${name} is not supported by this server`);
		};

		const privacy = nested('privacy');
		if (privacy.present && privacy.value !== 'public') unsupported('source[privacy]');
		const sensitive = nested('sensitive');
		if (sensitive.present && this.profileBoolean(sensitive.value, 'source[sensitive]') !== false) unsupported('source[sensitive]');
		const language = nested('language');
		if (language.present && language.value != null && language.value !== '') unsupported('source[language]');

		for (const name of ['avatar_description', 'header_description'] as const) {
			if (!Object.hasOwn(body, name)) continue;
			if (body[name] != null && body[name] !== '') unsupported(name);
		}
		for (const [name, defaultValue] of [
			['hide_collections', false],
			['indexable', false],
			['show_media', true],
			['show_media_replies', true],
			['show_featured', true],
		] as const) {
			if (!Object.hasOwn(body, name)) continue;
			if (this.profileBoolean(body[name], name) !== defaultValue) unsupported(name);
		}
		const domainsKey = Object.hasOwn(body, 'attribution_domains[]') ? 'attribution_domains[]' : 'attribution_domains';
		if (Object.hasOwn(body, domainsKey) && this.strings(body[domainsKey]).length > 0) unsupported('attribution_domains');

		return update;
	}

	private profileFields(body: Dictionary): Array<{ name: string; value: string }> | undefined {
		const entries = new Map<number, Dictionary>();
		let present = Object.hasOwn(body, 'fields_attributes');
		const direct = body.fields_attributes;
		if (Array.isArray(direct)) {
			direct.forEach((field, index) => {
				if (field != null && typeof field === 'object' && !Array.isArray(field)) entries.set(index, field as Dictionary);
			});
		} else if (direct != null && typeof direct === 'object') {
			for (const [index, field] of Object.entries(direct)) {
				if (/^\d+$/u.test(index) && field != null && typeof field === 'object' && !Array.isArray(field)) {
					entries.set(Number(index), field as Dictionary);
				}
			}
		}
		for (const [key, value] of Object.entries(body)) {
			const match = /^fields_attributes\[(\d+)\]\[(name|value)\]$/u.exec(key);
			if (match == null) continue;
			present = true;
			const index = Number(match[1]);
			const field = entries.get(index) ?? {};
			field[match[2]] = value;
			entries.set(index, field);
		}
		if (!present) return undefined;
		return [...entries.entries()].sort(([a], [b]) => a - b).map(([, field]) => {
			const name = this.string(field.name);
			const value = this.string(field.value);
			if (name == null || value == null) throw new MastodonApiError(400, 'invalid_request', 'Profile fields require name and value');
			return { name, value };
		});
	}

	private profileBoolean(value: unknown, name: string): boolean {
		if (value === true || value === 1 || value === '1' || value === 'true' || value === 'on') return true;
		if (value === false || value === 0 || value === '0' || value === 'false' || value === 'off') return false;
		throw new MastodonApiError(400, 'invalid_request', `${name} must be a boolean`);
	}

	private validateCompatibilityRequest(route: MastodonContractRoute, request: MastodonRequest): void {
		for (const [source, names] of [[request.body ?? {}, route.requiredBody], [request.query ?? {}, route.requiredQuery]] as const) {
			for (const name of names ?? []) {
				const value = source[name];
				if (value == null || value === '') {
					throw new MastodonApiError(400, 'invalid_request', `${name} is required`);
				}
			}
		}
	}

	private compatibilityResponse(route: MastodonContractRoute): readonly unknown[] | Readonly<Record<string, unknown>> {
		if (route.behavior === 'safe-array') return route.fallbackBody ?? [];
		if (route.behavior === 'safe-object') return route.fallbackBody ?? {};
		if (route.behavior === 'singleton-not-found') {
			throw new MastodonApiError(404, 'not_found', 'Record not found');
		}
		throw new MastodonApiError(422, 'unprocessable_entity', 'This operation is not supported by this server');
	}

	private async account(request: MastodonRequest, userId: string) {
		return await this.withOptionalUser(request, 'read:accounts', async auth => {
			const user = await this.invokePublic('users/show', { userId }, auth, request);
			return this.mastodonEntityService.account(user as Packed<'UserDetailed'>);
		});
	}

	private async userPage(request: MastodonRequest, reply: FastifyReply, endpoint: string, userId: string) {
		return await this.withOptionalUser(request, 'read:follows', async auth => {
			const followings = await this.invokePublic(endpoint, { userId, ...this.mastodonPaginationService.toMisskey(request.query) }, auth, request) as Array<{
				id: string;
				follower?: Packed<'UserDetailed'>;
				followee?: Packed<'UserDetailed'>;
			}>;
			return this.page(request, reply, followings, followings.flatMap(following => {
				const user = endpoint === 'users/followers' ? following.follower : following.followee;
				return user == null ? [] : [this.mastodonEntityService.account(user)];
			}));
		});
	}

	private async upload(request: MastodonRequest) {
		return await this.withAuth(request, 'write:media', async auth => {
			const multipartData = await request.file().catch(() => null);
			if (multipartData == null) throw new MastodonApiError(400, 'invalid_request', 'file is required');
			const [path, cleanup] = await createTemp();
			try {
				await pipeline(multipartData.file, fs.createWriteStream(path));
				if (multipartData.file.truncated) throw new MastodonApiError(413, 'file_too_large', 'File is too large');
				const fields = multipartData.fields as Record<string, { value?: unknown }>;
				const file = await this.mastodonApiCallService.invoke('drive/files/create', {
					name: multipartData.filename,
					comment: this.string(fields.description?.value) ?? null,
				}, auth, request, { name: multipartData.filename, path });
				return this.mastodonEntityService.attachment(file as Packed<'DriveFile'>);
			} finally {
				cleanup();
			}
		});
	}

	private async createStatus(request: MastodonRequest, auth: MastodonUserAuth): Promise<Record<string, unknown>> {
		const body = request.body ?? {};
		this.validateStatusCreateSemantics(body);
		if (Object.hasOwn(body, 'scheduled_at') && body.scheduled_at == null) {
			throw new MastodonApiError(400, 'invalid_request', 'scheduled_at must be an ISO 8601 date-time');
		}
		const scheduledAt = this.parseScheduledAt(body.scheduled_at, false);
		const idempotencyKey = this.string(request.headers['idempotency-key']);
		const cacheKey = idempotencyKey == null || idempotencyKey === ''
			? null
			: `mastodon-api:idempotency:${auth.token.id}:${digestCredential(idempotencyKey)}`;
		if (cacheKey != null) {
			const cached = await this.redis.get(cacheKey);
			if (cached != null) return JSON.parse(cached) as Record<string, unknown>;
			const acquired = await this.redis.set(`${cacheKey}:lock`, '1', 'EX', 60, 'NX');
			if (acquired == null) throw new MastodonApiError(409, 'conflict', 'A request with this Idempotency-Key is already in progress');
		}

		try {
			const text = this.string(body.status) ?? null;
			const visibility = this.string(body.visibility) ?? 'public';
			const misskeyVisibility = this.toMisskeyVisibility(visibility);
			const choices = this.strings(body['poll[options][]'] ?? (body.poll as Dictionary | undefined)?.options);
			const fileIds = this.strings(body['media_ids[]'] ?? body.media_ids);
			await this.updateMediaSensitivity(fileIds, body.sensitive, auth, request);
			const replyId = this.string(body.in_reply_to_id) ?? null;
			const renoteId = this.string(body.quoted_status_id) ?? null;
			const visibleUserIds = misskeyVisibility === 'specified'
				? await this.resolveDirectRecipientIds(text ?? '', replyId, auth, request)
				: [];
			const common = {
				text,
				cw: this.string(body.spoiler_text) || null,
				visibility: misskeyVisibility,
				...(misskeyVisibility === 'specified' ? { visibleUserIds } : {}),
				replyId,
				renoteId,
				...(fileIds.length > 0 ? { fileIds } : {}),
				...(choices.length >= 2 ? { poll: {
					choices,
					multiple: this.boolean(body['poll[multiple]'] ?? (body.poll as Dictionary | undefined)?.multiple),
					expiredAfter: Math.max(1, Number(this.string(body['poll[expires_in]'] ?? (body.poll as Dictionary | undefined)?.expires_in) ?? 300)) * 1000,
				} } : {}),
			};
			if (scheduledAt != null) {
				const result = await this.invoke('notes/drafts/create', {
					...common,
					scheduledAt: scheduledAt.getTime(),
					isActuallyScheduled: true,
				}, auth, request) as { createdDraft: Packed<'NoteDraft'> };
				const scheduledStatus = this.mastodonEntityService.scheduledStatus(result.createdDraft);
				if (cacheKey != null) await this.redis.set(cacheKey, JSON.stringify(scheduledStatus), 'EX', 86400);
				return scheduledStatus;
			}
			const result = await this.invoke('notes/create', {
				...common,
			}, auth, request) as { createdNote: Packed<'Note'> };
			const status = await this.statusWithState(result.createdNote, auth, 'thread');
			if (cacheKey != null) await this.redis.set(cacheKey, JSON.stringify(status), 'EX', 86400);
			return status;
		} finally {
			if (cacheKey != null) await this.redis.del(`${cacheKey}:lock`);
		}
	}

	private validateStatusCreateSemantics(body: Dictionary): void {
		// Mastodon clients commonly send language by default. Notes cannot persist it, so accept and ignore it.
		if (Object.keys(body).some(key => key === 'allowed_mentions' || key.startsWith('allowed_mentions['))) {
			throw new MastodonApiError(422, 'unprocessable_entity', 'Allowed mention constraints cannot be enforced by this server');
		}
		const quoteApprovalPolicy = this.string(body.quote_approval_policy);
		if (quoteApprovalPolicy != null && quoteApprovalPolicy !== '' && quoteApprovalPolicy !== 'public') {
			throw new MastodonApiError(422, 'unprocessable_entity', `Unsupported quote approval policy: ${quoteApprovalPolicy}`);
		}
	}

	private parseScheduledAt(rawValue: unknown, required: boolean): Date | null {
		if (rawValue == null || rawValue === '') {
			if (required) throw new MastodonApiError(400, 'invalid_request', 'scheduled_at is required');
			return null;
		}
		if (typeof rawValue !== 'string') throw new MastodonApiError(400, 'invalid_request', 'scheduled_at must be an ISO 8601 date-time');
		const date = new Date(rawValue);
		if (!Number.isFinite(date.getTime())) throw new MastodonApiError(400, 'invalid_request', 'scheduled_at must be an ISO 8601 date-time');
		if (date.getTime() <= Date.now()) throw new MastodonApiError(422, 'unprocessable_entity', 'scheduled_at must be in the future');
		return date;
	}

	private async featuredTagEntities(
		userId: string,
		tags: MastodonUserTagState[],
		auth: MastodonUserAuth | null,
		request: MastodonRequest,
	) {
		if (tags.length === 0) return [];
		const [user, aggregates] = await Promise.all([
			this.invokePublic('users/show', { userId }, auth, request) as Promise<Packed<'UserDetailed'>>,
			this.notesRepository.query(`
				SELECT tag."name" AS "tag",
					COUNT(*)::integer AS "statusesCount",
					MAX(note."createdAt") AS "lastStatusAt"
				FROM "note" note
				CROSS JOIN LATERAL unnest(note."tags") AS tag("name")
				WHERE note."userId" = $1
					AND note."visibility" IN ('public', 'home')
					AND note."localOnly" = FALSE
					AND note."channelId" IS NULL
					AND tag."name" = ANY($2::varchar[])
				GROUP BY tag."name"
			`, [userId, tags.map(tag => tag.name)]) as Promise<Array<{ tag: string; statusesCount: number; lastStatusAt: Date | string | null }>>,
		]);
		const stats = new Map(tags.map(tag => [tag.name, { statusesCount: 0, lastStatusAt: null as string | null }]));
		for (const aggregate of aggregates) {
			const value = stats.get(aggregate.tag);
			if (value == null) continue;
			value.statusesCount = Number(aggregate.statusesCount);
			value.lastStatusAt = aggregate.lastStatusAt == null
				? null
				: (aggregate.lastStatusAt instanceof Date ? aggregate.lastStatusAt.toISOString() : aggregate.lastStatusAt).slice(0, 10);
		}
		const accountUrl = this.mastodonEntityService.account(user).url;
		return tags.map(tag => this.mastodonEntityService.featuredTag(tag, accountUrl, stats.get(tag.name)!));
	}

	private async endorsementPage(
		userId: string,
		request: MastodonRequest,
		reply: FastifyReply,
		auth: MastodonUserAuth | null,
	) {
		const state = this.compatibilityStatePage(
			(await this.mastodonUserFeatureService.listEndorsementIds(userId)).map(id => ({ id })),
			request.query,
			80,
			40,
		);
		if (state.length === 0) return this.page(request, reply, state, []);
		const users = await this.invokePublic('users/show', { userIds: state.map(value => value.id) }, auth, request) as Packed<'UserDetailed'>[];
		const usersById = new Map(users.map(user => [user.id, user]));
		const availableUsers = state.flatMap(value => {
			const user = usersById.get(value.id);
			return user == null ? [] : [user];
		});
		return this.page(request, reply, state, availableUsers.map(user => this.mastodonEntityService.account(user)));
	}

	private compatibilityStatePage<T extends { id: string }>(items: T[], query: Dictionary, maximum: number, defaultLimit = 20): T[] {
		const rawLimit = query.limit;
		const pagination = this.mastodonPaginationService.toMisskey({
			...query,
			limit: typeof rawLimit === 'string' || typeof rawLimit === 'number' ? rawLimit : defaultLimit,
		}, maximum);
		return items
			.filter(item => pagination.untilId == null || item.id < pagination.untilId)
			.filter(item => pagination.sinceId == null || item.id > pagination.sinceId)
			.slice(0, pagination.limit);
	}

	private normalizedHashtag(value: string): string {
		return value.normalize('NFKC').replace(/^#+/u, '').toLowerCase();
	}

	private async statusWithState(note: Packed<'Note'>, auth: MastodonUserAuth | null, context: MastodonFilterContext): Promise<Record<string, unknown>> {
		return (await this.statusesWithState([note], auth, context, { preserveHidden: true }))[0]!;
	}

	private async statusesWithState(
		notes: Packed<'Note'>[],
		auth: MastodonUserAuth | null,
		context: MastodonFilterContext,
		options: MastodonFilterApplyOptions = {},
	): Promise<Record<string, unknown>[]> {
		if (notes.length === 0) return [];
		if (auth == null) return notes.map(note => this.mastodonEntityService.status(note));
		const rootNoteIds = [...new Set(notes.map(note => note.id))];
		const noteIds = this.collectNoteIds(notes);
		const [renotes, favorites, pinings, mutedNoteIds] = await Promise.all([
			this.notesRepository.findBy({ userId: auth.user.id, renoteId: In(rootNoteIds) }),
			this.noteFavoritesRepository.findBy({ userId: auth.user.id, noteId: In(rootNoteIds) }),
			this.userNotePiningsRepository.findBy({ userId: auth.user.id, noteId: In(rootNoteIds) }),
			this.mastodonUserFeatureService.mutedNoteIds(auth.user.id, noteIds),
		]);
		const renotedIds = new Set(renotes.flatMap(renote => renote.renoteId == null || !this.isPureRenote(renote) ? [] : [renote.renoteId]));
		const bookmarkedIds = new Set(favorites.map(favorite => favorite.noteId));
		const pinnedIds = new Set(pinings.map(pining => pining.noteId));
		const statuses = notes.map(note => ({
			...this.applyMutedState(this.mastodonEntityService.status(note), mutedNoteIds),
			reblogged: renotedIds.has(note.id),
			bookmarked: bookmarkedIds.has(note.id),
			pinned: pinnedIds.has(note.id),
			muted: mutedNoteIds.has(note.id),
		}));
		const quotesCount = await this.queryQuotesCount(rootNoteIds);
		const allAccounts: Record<string, unknown>[] = [];
		for (const st of statuses) {
			const acct = this.dictionary(st.account);
			if (acct != null) allAccounts.push(acct);
			const reblog = this.dictionary(st.reblog);
			if (reblog != null) {
				const ra = this.dictionary(reblog.account);
				if (ra != null) allAccounts.push(ra);
			}
		}
		await this.mastodonEntityService.enrichLastStatusAt(allAccounts);
		for (const st of statuses) {
			const sid = this.string(st.id) ?? '';
			st.quotes_count = quotesCount.get(sid) ?? 0;
		}
		const corpora = new Map(notes.map(note => [note.id, this.filterCorpus(note)]));
		return await this.mastodonFilterService.apply(auth.user.id, context, statuses, { ...options, corpora });
	}

	private notificationOptions(query: Dictionary): {
		types: string[];
		excludeTypes: string[];
		accountId?: string;
		includeFiltered: boolean;
		groupedTypes?: string[];
	} {
		const groupedValue = query['grouped_types[]'] ?? query.grouped_types;
		return {
			types: this.strings(query['types[]'] ?? query.types),
			excludeTypes: this.strings(query['exclude_types[]'] ?? query.exclude_types),
			accountId: this.string(query.account_id),
			includeFiltered: this.boolean(query.include_filtered),
			...(groupedValue == null ? {} : { groupedTypes: this.strings(groupedValue) }),
		};
	}

	private async notificationSources(
		auth: MastodonUserAuth,
		request: MastodonRequest,
		params: Dictionary,
	): Promise<MastodonNotificationSource[]> {
		return (await this.notificationSourcePage(auth, request, params)).sources;
	}

	private async notificationSourcePage(
		auth: MastodonUserAuth,
		request: MastodonRequest,
		params: Dictionary,
	): Promise<{ sources: MastodonNotificationSource[]; page: { id: string }[] }> {
		const notifications = await this.invoke('i/notifications', params, auth, request) as Packed<'Notification'>[];
		const converted = notifications
			.map(notification => this.mastodonEntityService.notification(notification))
			.filter(value => value != null) as Dictionary[];
		const filtered = await this.notificationFilters(auth.user.id, converted, notifications);
		const entitiesById = new Map(filtered.flatMap(entity => {
			const id = this.string(entity.id);
			return id == null ? [] : [[id, entity] as const];
		}));
		const sources = notifications.flatMap(notification => {
			const entity = entitiesById.get(notification.id);
			return entity == null ? [] : [{ native: notification as unknown as MastodonNotificationSource['native'], entity: entity as MastodonNotificationSource['entity'] }];
		});
		return { sources, page: notifications.map(notification => ({ id: notification.id })) };
	}

	private notificationGroupLink(
		request: FastifyRequest,
		reply: FastifyReply,
		groups: readonly { most_recent_notification_id: string; page_min_id: string; page_max_id: string }[],
		fallbackPage: readonly { id: string }[] = [],
	): void {
		const pageMaxId = groups.reduce<string | null>((maxId, group) => maxId == null || group.page_max_id > maxId ? group.page_max_id : maxId, null);
		const pageMinId = groups.reduce<string | null>((minId, group) => minId == null || group.page_min_id < minId ? group.page_min_id : minId, null);
		const records = groups.length > 0
			? [{ id: pageMaxId! }, { id: pageMinId! }]
			: fallbackPage.length > 0
				? [{ id: fallbackPage[0]!.id }, { id: fallbackPage.at(-1)!.id }]
				: [];
		if (records.length === 0) return;
		const link = this.mastodonPaginationService.linkHeader(
			new URL(request.url, this.config.url).toString(),
			records,
		);
		if (link != null) reply.header('Link', link);
	}

	private notificationLowerId(query: Dictionary): string | undefined {
		const minId = this.string(query.min_id);
		const sinceId = this.string(query.since_id);
		if (minId == null || minId === '') return sinceId;
		if (sinceId == null || sinceId === '') return minId;
		return minId > sinceId ? minId : sinceId;
	}

	private notificationCursorWindow(sources: MastodonNotificationSource[], query: Dictionary): MastodonNotificationSource[] {
		const maxId = this.string(query.max_id);
		const lowerId = this.notificationLowerId(query);
		const filtered = sources
			.filter(source => maxId == null || source.entity.id < maxId)
			.filter(source => lowerId == null || source.entity.id > lowerId);
		const window = this.string(query.min_id) == null
			? filtered.sort((left, right) => right.entity.id.localeCompare(left.entity.id)).slice(0, 100)
			: filtered.sort((left, right) => left.entity.id.localeCompare(right.entity.id)).slice(0, 100);
		return window.sort((left, right) => right.entity.id.localeCompare(left.entity.id));
	}

	private notificationLegacyPolicyBody(body: Dictionary): Dictionary {
		return Object.fromEntries(Object.entries(body).map(([key, value]) => {
			const normalized = typeof value === 'string' ? value.toLowerCase() : value;
			if (normalized === true || normalized === 1 || normalized === '1' || normalized === 'true' || normalized === 'on') return [key, true];
			if (normalized === false || normalized === 0 || normalized === '0' || normalized === 'false' || normalized === 'off') return [key, false];
			return [key, value];
		}));
	}

	private async notificationFilters(
		userId: string,
		notifications: Dictionary[],
		nativeNotifications: Packed<'Notification'>[],
	): Promise<Dictionary[]> {
		const statuses = notifications.flatMap(notification => {
			const status = notification.status;
			return status != null && typeof status === 'object' && !Array.isArray(status) ? [status as Dictionary] : [];
		});
		if (statuses.length === 0) return notifications;
		const statusIds = this.collectStatusIds(statuses);
		const mutedNoteIds = await this.mastodonUserFeatureService.mutedNoteIds(userId, statusIds);
		const statusesWithState = statuses.map(status => this.applyMutedState(status, mutedNoteIds));
		const nativeById = new Map(nativeNotifications.map(notification => [notification.id, notification]));
		const corpora = new Map<string, string[]>();
		for (const notification of notifications) {
			const notificationId = this.string(notification.id);
			const status = notification.status;
			if (notificationId == null || status == null || typeof status !== 'object' || Array.isArray(status)) continue;
			const statusId = this.string((status as Dictionary).id);
			const note = nativeById.get(notificationId)?.note;
			if (statusId != null && note != null) corpora.set(statusId, this.filterCorpus(note));
		}
		const filtered = await this.mastodonFilterService.apply(userId, 'notifications', statusesWithState, { corpora });
		const byId = new Map(filtered.map(status => [this.string(status.id) ?? '', status]));
		return notifications.flatMap(notification => {
			const status = notification.status;
			if (status == null || typeof status !== 'object' || Array.isArray(status)) return [notification];
			const visible = byId.get(this.string((status as Dictionary).id) ?? '');
			return visible == null ? [] : [{ ...notification, status: visible }];
		});
	}

	private collectNoteIds(notes: Packed<'Note'>[]): string[] {
		const ids = new Set<string>();
		const visit = (note: Packed<'Note'>): void => {
			if (ids.has(note.id)) return;
			ids.add(note.id);
			if (note.renote != null) visit(note.renote);
		};
		for (const note of notes) visit(note);
		return [...ids];
	}

	private collectStatusIds(statuses: Dictionary[]): string[] {
		const ids = new Set<string>();
		const visit = (status: Dictionary): void => {
			const id = this.string(status.id);
			if (id != null) ids.add(id);
			const reblog = this.dictionary(status.reblog);
			if (reblog != null) visit(reblog);
			const quote = this.dictionary(status.quote);
			const quotedStatus = quote == null ? null : this.dictionary(quote.quoted_status);
			if (quotedStatus != null) visit(quotedStatus);
		};
		for (const status of statuses) visit(status);
		return [...ids];
	}

	private applyMutedState(status: Dictionary, mutedNoteIds: Set<string>): Dictionary {
		const id = this.string(status.id);
		const reblog = this.dictionary(status.reblog);
		const quote = this.dictionary(status.quote);
		const quotedStatus = quote == null ? null : this.dictionary(quote.quoted_status);
		return {
			...status,
			muted: id != null && mutedNoteIds.has(id),
			...(reblog == null ? {} : { reblog: this.applyMutedState(reblog, mutedNoteIds) }),
			...(quote == null || quotedStatus == null ? {} : {
				quote: { ...quote, quoted_status: this.applyMutedState(quotedStatus, mutedNoteIds) },
			}),
		};
	}

	private filterCorpus(note: Packed<'Note'>): string[] {
		const corpus: string[] = [];
		if (note.text != null) corpus.push(note.text);
		if (note.cw != null) corpus.push(note.cw);
		for (const file of note.files ?? []) {
			if (file.comment != null) corpus.push(file.comment);
		}
		for (const choice of note.poll?.choices ?? []) corpus.push(choice.text);
		if (note.renote != null) corpus.push(...this.filterCorpus(note.renote));
		return corpus;
	}

	private isPureRenote(note: { text: string | null; cw: string | null; fileIds: string[]; hasPoll: boolean; replyId: string | null }): boolean {
		return note.text == null && note.cw == null && note.fileIds.length === 0 && !note.hasPoll && note.replyId == null;
	}

	private isPurePackedRenote(note: Packed<'Note'>): boolean {
		return note.text == null && note.cw == null && (note.files?.length ?? 0) === 0 && note.poll == null && note.replyId == null;
	}

	private async resolveDirectRecipientIds(text: string, replyId: string | null, auth: MastodonUserAuth, request: MastodonRequest): Promise<string[]> {
		const users = new Set<string>();
		for (const mention of extractMentions(mfmParse(text))) {
			const username = mention.username;
			const host = mention.host ?? undefined;
			const user = await this.invoke('users/show', { username, ...(host != null ? { host } : {}) }, auth, request) as Packed<'UserLite'>;
			if (user.id !== auth.user.id) users.add(user.id);
		}
		if (replyId != null) {
			const reply = await this.invoke('notes/show', { noteId: replyId }, auth, request) as Packed<'Note'>;
			if (reply.userId !== auth.user.id) users.add(reply.userId);
		}
		if (users.size === 0) throw new MastodonApiError(422, 'invalid_request', 'A direct status requires at least one recipient');
		return [...users];
	}

	private async updateMediaSensitivity(fileIds: string[], rawSensitive: unknown, auth: MastodonUserAuth, request: MastodonRequest): Promise<void> {
		if (rawSensitive == null || !this.boolean(rawSensitive)) return;
		for (const fileId of fileIds) {
			await this.invoke('drive/files/update', { fileId, isSensitive: true }, auth, request);
		}
	}

	private async assertApplicationRegistrationRate(ip: string): Promise<void> {
		const key = `mastodon-api:app-registration:${digestCredential(ip)}`;
		const count = await this.redis.incr(key);
		if (count === 1) await this.redis.expire(key, 3600);
		if (count > 60) throw new MastodonApiError(429, 'rate_limit_exceeded', 'Too many application registrations');
	}

	private async assertThreadMuteRate(userId: string): Promise<void> {
		// This limiter is transport-specific: the native endpoint requires write:account, so a Mastodon write:mutes token cannot reuse its scope/rate-limit path.
		const key = `mastodon-api:thread-mute:${userId}`;
		const count = await this.redis.incr(key);
		if (count === 1) await this.redis.expire(key, 3600);
		if (count > 10) throw new MastodonApiError(429, 'rate_limit_exceeded', 'Too many thread mutes');
	}

	private bearerToken(request: MastodonRequest): string | undefined {
		const authorization = request.headers.authorization;
		if (authorization == null) return undefined;
		const match = /^Bearer[ \t]+(.+)$/iu.exec(authorization);
		if (match?.[1] == null || match[1] === '') {
			throw new MastodonApiError(401, 'invalid_token', 'The access token is invalid');
		}
		return match[1];
	}

	private async withAnyToken<T>(request: MastodonRequest, action: (auth: MastodonAuth) => Promise<T>): Promise<T> {
		return await this.withToken(request, undefined, action);
	}

	private async withToken<T>(
		request: MastodonRequest,
		scope: string | readonly string[] | undefined,
		action: (auth: MastodonAuth) => Promise<T>,
	): Promise<T> {
		const token = this.bearerToken(request);
		if (token == null) throw new MastodonApiError(401, 'invalid_token', 'The access token is invalid');
		const auth = await this.mastodonAuthenticateService.authenticate(token);
		this.assertScope(auth.token.scopes, scope);
		return await action(auth);
	}

	private async withOptionalToken<T>(
		request: MastodonRequest,
		action: () => Promise<T>,
		scope?: string | readonly string[],
	): Promise<T> {
		const token = this.bearerToken(request);
		if (token != null) {
			const auth = await this.mastodonAuthenticateService.authenticate(token);
			this.assertScope(auth.token.scopes, scope);
		}
		return await action();
	}

	private async withOptionalUser<T>(
		request: MastodonRequest,
		scope: string | undefined,
		action: (auth: MastodonUserAuth | null) => Promise<T>,
	): Promise<T> {
		const token = this.bearerToken(request);
		if (token == null) return await action(null);
		const auth = await this.mastodonAuthenticateService.authenticate(token);
		if (auth.kind === 'application') return await action(null);
		if (scope != null) this.mastodonScopeService.assert(auth.token.scopes, scope);
		return await action(auth);
	}

	private async withOptionalScopedUser<T>(
		request: MastodonRequest,
		scope: string,
		action: (auth: MastodonUserAuth | null) => Promise<T>,
	): Promise<T> {
		const token = this.bearerToken(request);
		if (token == null) return await action(null);
		const auth = await this.mastodonAuthenticateService.authenticate(token);
		this.mastodonScopeService.assert(auth.token.scopes, scope);
		return await action(auth.kind === 'user' ? auth : null);
	}

	private async withAuth<T>(
		request: MastodonRequest,
		scope: string | readonly string[] | undefined,
		action: (auth: MastodonUserAuth) => Promise<T>,
	): Promise<T> {
		const token = this.bearerToken(request);
		if (token == null) throw new MastodonApiError(401, 'invalid_token', 'The access token is invalid');
		const auth = await this.mastodonAuthenticateService.authenticate(token);
		if (auth.kind === 'application') throw new MastodonApiError(401, 'invalid_token', 'This endpoint requires a user token');
		this.assertScope(auth.token.scopes, scope);
		return await action(auth);
	}

	private assertScope(tokenScopes: readonly string[], scope: string | readonly string[] | undefined): void {
		if (scope == null) return;
		if (typeof scope === 'string') {
			this.mastodonScopeService.assert(tokenScopes, scope);
			return;
		}
		this.mastodonScopeService.assertAny(tokenScopes, scope);
	}

	private async invoke(name: string, data: Dictionary, auth: MastodonUserAuth, request: MastodonRequest): Promise<unknown> {
		return await this.mastodonApiCallService.invoke(name, data, auth, request);
	}

	private async invokePublic(name: string, data: Dictionary, auth: MastodonUserAuth | null, request: MastodonRequest): Promise<unknown> {
		try {
			return await this.mastodonApiCallService.invokePublic(name, data, auth, request);
		} catch (error) {
			if (this.isPublicRecordUnavailableError(error)) {
				throw new MastodonApiError(404, 'not_found', 'Record not found');
			}
			throw error;
		}
	}

	private isPublicRecordUnavailableError(error: unknown): boolean {
		if (error instanceof MastodonApiError) return error.statusCode === 403 || error.statusCode === 404;
		if (!(error instanceof ApiError)) return false;
		return error.httpStatusCode === 404 ||
			error.kind === 'permission' ||
			error.code === 'FORBIDDEN' ||
			error.code.startsWith('NO_SUCH_') ||
			error.code.endsWith('_NOT_FOUND') ||
			error.code.startsWith('CONTENT_RESTRICTED_');
	}

	private async invokePublicBatch(
		name: string,
		idKey: string,
		rawIds: unknown,
		auth: MastodonUserAuth | null,
		request: MastodonRequest,
	): Promise<unknown[]> {
		const requestedIds = this.strings(rawIds).slice(0, 40);
		const uniqueIds = [...new Set(requestedIds)];
		const entries = await Promise.all(uniqueIds.map(async id => {
			try {
				return [id, await this.invokePublic(name, { [idKey]: id }, auth, request)] as const;
			} catch (error) {
				if (this.isBatchOmittableError(error)) return [id, null] as const;
				throw error;
			}
		}));
		const valuesById = new Map(entries);
		return requestedIds.flatMap(id => {
			const value = valuesById.get(id);
			return value == null ? [] : [value];
		});
	}

	private isBatchOmittableError(error: unknown): boolean {
		return this.isPublicRecordUnavailableError(error);
	}

	private filterAccountStatuses(notes: Packed<'Note'>[], query: Dictionary): Packed<'Note'>[] {
		const onlyMedia = this.boolean(query.only_media);
		const excludeReplies = this.boolean(query.exclude_replies);
		const excludeReblogs = this.boolean(query.exclude_reblogs);
		return notes.filter(note => {
			if (onlyMedia && (note.files?.length ?? 0) === 0) return false;
			if (excludeReplies && note.replyId != null) return false;
			if (excludeReblogs && note.renote != null && note.text == null && (note.files?.length ?? 0) === 0 && note.poll == null && note.replyId == null) return false;
			return true;
		});
	}

	private page<T>(request: FastifyRequest, reply: FastifyReply, source: readonly { id: string }[], converted: T[]): T[] {
		const link = this.mastodonPaginationService.linkHeader(new URL(request.url, this.config.url).toString(), source);
		if (link != null) reply.header('Link', link);
		return converted;
	}

	private offsetPagination(query: Dictionary, defaultLimit: number, maximumLimit: number): { limit: number; offset: number; readLimit: number } {
		const limit = this.integer(query.limit, defaultLimit, 1, maximumLimit);
		const offset = this.integer(query.offset, 0, 0);
		return {
			limit,
			offset,
			readLimit: Math.min(100, offset + limit + 1),
		};
	}

	private offsetPage<T>(
		request: FastifyRequest,
		reply: FastifyReply,
		source: readonly T[],
		pagination: { limit: number; offset: number },
	): T[] {
		const { limit, offset } = pagination;
		const link = this.mastodonPaginationService.offsetLinkHeader(
			new URL(request.url, this.config.url).toString(),
			offset,
			limit,
			source.length > offset + limit,
		);
		if (link != null) reply.header('Link', link);
		return source.slice(offset, offset + limit);
	}

	private async instanceV1(request: MastodonRequest): Promise<Dictionary> {
		let notesCount = 0;
		let usersCount = 0;
		let instances = 0;
		try {
			const stats = await this.invokePublic('stats', {}, null, request) as { notesCount: number; usersCount: number; instances: number };
			notesCount = stats.notesCount;
			usersCount = stats.usersCount;
			instances = stats.instances;
		} catch { /* keep zero values on failure */ }
		const v2 = await this.instanceV2(request);
		return {
			uri: this.config.host,
			title: v2.title,
			short_description: this.meta.description ?? '',
			description: this.meta.description ?? '',
			email: this.meta.maintainerEmail ?? '',
			version: v2.version,
			urls: { streaming_api: this.streamingUrl() },
			stats: { user_count: usersCount, status_count: notesCount, domain_count: instances },
			thumbnail: this.instanceImageUrl(),
			languages: this.meta.langs,
			registrations: !this.meta.disableRegistration,
			approval_required: false,
			invites_enabled: false,
			configuration: v2.configuration,
			contact_account: null,
			rules: this.rules(),
		};
	}

	private async instanceV2(request: MastodonRequest): Promise<Dictionary> {
		let activeMonth = 0;
		try {
			activeMonth = await this.usersRepository.count({
				where: { host: IsNull(), lastActiveDate: MoreThan(new Date(Date.now() - 2592000000)) },
			});
		} catch { /* keep zero on failure */ }
		return {
			domain: this.config.host,
			title: this.meta.name ?? this.config.host,
			version: `4.3.0 (compatible; Misskey ${this.config.version})`,
			api_versions: { mastodon: 1 },
			source_url: 'https://github.com/misskey-dev/misskey',
			description: this.meta.description ?? '',
			usage: { users: { active_month: activeMonth } },
			thumbnail: { url: this.instanceImageUrl() },
			languages: this.meta.langs,
			configuration: {
				urls: { streaming: this.streamingUrl() },
				vapid: { public_key: this.mastodonPushSubscriptionService.vapidPublicKey() },
				accounts: { max_pinned_statuses: this.meta.policies.pinLimit ?? 5 },
				statuses: { max_characters: MAX_NOTE_TEXT_LENGTH, max_media_attachments: 16, characters_reserved_per_url: 23 },
				media_attachments: {
					supported_mime_types: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/ogg', 'video/mp4', 'video/webm'],
					image_size_limit: this.config.maxFileSize,
					video_size_limit: this.config.maxFileSize,
				},
				polls: { max_options: 10, max_characters_per_option: 50, min_expiration: 300, max_expiration: 2629746 },
			},
			registrations: { enabled: !this.meta.disableRegistration, approval_required: false, message: null },
			contact: { email: this.meta.maintainerEmail ?? '', account: null },
			rules: this.rules(),
		};
	}

	private instanceImageUrl(): string {
		return this.meta.bannerUrl ?? this.meta.iconUrl ?? new URL('/favicon.ico', this.config.url).toString();
	}

	private rules(): Array<{ id: string; text: string; hint: string }> {
		return this.meta.serverRules.map((text, index) => ({
			id: (index + 1).toString(),
			text,
			hint: '',
		}));
	}

	private streamingUrl(): string {
		const url = new URL('/api/v1/streaming', this.config.url);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		return url.toString();
	}

	private toMisskeyVisibility(value: string): 'public' | 'home' | 'followers' | 'specified' {
		const visibility = { public: 'public', unlisted: 'home', private: 'followers', direct: 'specified' }[value] as 'public' | 'home' | 'followers' | 'specified' | undefined;
		if (visibility == null) throw new MastodonApiError(422, 'invalid_request', `Unsupported visibility: ${value}`);
		return visibility;
	}

	private dictionary(value: unknown): Dictionary | null {
		return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Dictionary : null;
	}

	private string(value: unknown): string | undefined {
		return typeof value === 'string' ? value : typeof value === 'number' ? value.toString() : undefined;
	}

	private strings(value: unknown): string[] {
		if (Array.isArray(value)) return value.flatMap(item => this.strings(item));
		const item = this.string(value);
		return item == null || item === '' ? [] : item.split(',').map(part => part.trim()).filter(Boolean);
	}

	private isHttpUrl(value: string): boolean {
		try {
			const url = new URL(value);
			return url.protocol === 'http:' || url.protocol === 'https:';
		} catch {
			return false;
		}
	}

	private integer(value: unknown, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
		const parsed = Number(this.string(value));
		return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed))) : fallback;
	}

	private boolean(value: unknown): boolean {
		return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
	}

	private async queryQuotesCount(noteIds: readonly string[]): Promise<Map<string, number>> {
		if (noteIds.length === 0) return new Map();
		const result = await this.notesRepository.createQueryBuilder('note')
			.select('note.renoteId', 'renoteId')
			.addSelect('COUNT(*)::int', 'count')
			.where('note.renoteId IN (:...ids)', { ids: noteIds as string[] })
			.andWhere("(note.text IS NOT NULL OR note.cw IS NOT NULL OR cardinality(note.\"fileIds\") > 0 OR note.\"hasPoll\" = TRUE OR note.\"replyId\" IS NOT NULL)")
			.groupBy('note.renoteId')
			.getRawMany<{ renoteId: string; count: number }>();
		return new Map(result.map(row => [row.renoteId, row.count]));
	}
}