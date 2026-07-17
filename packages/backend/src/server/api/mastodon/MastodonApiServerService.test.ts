/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '@/server/api/error.js';
import UsersNotesEndpoint from '@/server/api/endpoints/users/notes.js';
import { MastodonApiError } from './errors.js';
import { MASTODON_4_6_USER_ROUTES } from './MastodonApiContract.js';
import { MastodonApiServerService } from './MastodonApiServerService.js';
import { MastodonFilterService } from './MastodonFilterService.js';
import { MastodonMarkerService } from './MastodonMarkerService.js';
import { MastodonNotificationService } from './MastodonNotificationService.js';
import { MastodonPushSubscriptionService } from './MastodonPushSubscriptionService.js';
import { MastodonScopeService } from './MastodonScopeService.js';
import { MastodonUserFeatureService } from './MastodonUserFeatureService.js';

describe(MastodonApiServerService, () => {
	const servers: ReturnType<typeof Fastify>[] = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map(server => server.close()));
	});

	function createServer(
		meta: Record<string, unknown> = {},
		registerBeforeMastodon?: (fastify: ReturnType<typeof Fastify>) => void,
	) {
		const auth = { kind: 'user', user: { id: 'user-id' }, token: { id: 'token-id', scopes: ['read'] } };
		const dismissedNotifications = new Set<string>();
		const authenticate = vi.fn().mockResolvedValue(auth);
		const assert = vi.fn();
		const assertAny = vi.fn();
		const nativeInvoke = vi.fn(async (name: string, data: Record<string, unknown>, _viewer?: unknown, _request?: unknown): Promise<unknown> => {
			if (name === 'i') return { id: 'user-id', username: 'alice' };
			if (name === 'emojis') return {
				emojis: [{
					name: 'blobcat',
					url: 'https://misskey.example/files/blobcat.png',
					category: 'Animals',
				}],
			};
			if (name === 'notes/timeline') return [{ id: 'note-id' }];
			if (name === 'users/show') return Array.isArray(data.userIds)
				? data.userIds.map(id => ({ id, username: id }))
				: { id: data.userId, username: data.userId };
			if (name === 'notes/show') return data.noteId === 'note-with-poll'
				? {
					id: data.noteId,
					poll: {
						expiresAt: null,
						multiple: false,
						choices: [{ text: 'A', votes: 2, isVoted: false }],
					},
				}
				: { id: data.noteId ?? 'note-id' };
			if (name === 'notes/create') return { createdNote: { id: 'created-note-id' } };
			return [];
		});
		const publicInvoke = vi.fn((name: string, data: Record<string, unknown>, viewer: unknown, request: unknown) => nativeInvoke(name, data, viewer, request));
		const registerApplication = vi.fn().mockResolvedValue({ client_id: 'client-id', client_secret: 'client-secret' });
		const getApplication = vi.fn().mockResolvedValue({ id: 'client-id', name: 'Elk' });
		const redis = {
			get: vi.fn().mockResolvedValue(null),
			set: vi.fn().mockResolvedValue('OK'),
			del: vi.fn().mockResolvedValue(1),
			incr: vi.fn().mockResolvedValue(1),
			expire: vi.fn().mockResolvedValue(1),
			zadd: vi.fn(async (_key: string, _score: number, id: string) => {
				dismissedNotifications.add(id);
				return 1;
			}),
			zremrangebyscore: vi.fn().mockResolvedValue(0),
			zremrangebyrank: vi.fn().mockResolvedValue(0),
			zscore: vi.fn(async (_key: string, id: string) => dismissedNotifications.has(id) ? '1' : null),
		};
		const nativeThreads = new Map<string, string | null>([
			['reply-note', 'root-note'],
			['sibling-note', 'root-note'],
			['created-note-id', 'root-note'],
		]);
		const notesRepository = {
			findBy: vi.fn().mockResolvedValue([]),
			findOneBy: vi.fn(async ({ id }: { id: string }) => ({ id, threadId: nativeThreads.get(id) ?? null })),
			query: vi.fn().mockResolvedValue([]),
		};
		const noteFavoritesRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const userNotePiningsRepository = { findBy: vi.fn().mockResolvedValue([]) };
		const linkHeader = vi.fn().mockReturnValue('<next>; rel="next"');
		const toMisskey = vi.fn().mockReturnValue({ limit: 20 });
		const offsetLinkHeader = vi.fn((_requestUrl: string, offset: number, limit: number, hasMore: boolean) => {
			const links = [
				...(hasMore ? [`<next:${offset + limit}>; rel="next"`] : []),
				...(offset > 0 ? [`<prev:${Math.max(0, offset - limit)}>; rel="prev"`] : []),
			];
			return links.length === 0 ? null : links.join(', ');
		});
		const stateRows = new Map<string, {
			id: string;
			userId: string;
			tokenId: string | null;
			kind: string;
			key: string;
			value: unknown;
			version: number;
			createdAt: Date;
			updatedAt: Date;
			expiresAt: Date | null;
		}>();
		const stateKey = (kind: string, key: string) => `${kind}:${key}`;
		let pushStateSequence = 0;
		let stateLockTail = Promise.resolve();
		const mastodonApiStateService = {
			list: vi.fn(async (userId: string, kind: string) => [...stateRows.values()].filter(row => row.userId === userId && row.kind === kind)),
			get: vi.fn(async (userId: string, kind: string, key: string) => {
				const row = stateRows.get(stateKey(kind, key));
				return row?.userId === userId ? row : null;
			}),
			getMany: vi.fn(async (userId: string, kind: string, keys: string[]) => new Map(keys.flatMap(key => {
				const row = stateRows.get(stateKey(kind, key));
				return row?.userId === userId ? [[key, row] as const] : [];
			}))),
			getById: vi.fn(async (id: string) => [...stateRows.values()].find(row => row.id === id) ?? null),
			put: vi.fn(async (input: { userId: string; tokenId?: string | null; kind: string; key: string; value: unknown; expiresAt?: Date | null }) => {
				const mapKey = stateKey(input.kind, input.key);
				const previous = stateRows.get(mapKey);
				const now = new Date();
				const row = {
					id: previous?.id ?? `state-${mapKey}`,
					userId: input.userId,
					tokenId: input.tokenId ?? null,
					kind: input.kind,
					key: input.key,
					value: input.value,
					version: (previous?.version ?? 0) + 1,
					createdAt: previous?.createdAt ?? now,
					updatedAt: now,
					expiresAt: input.expiresAt ?? null,
				};
				stateRows.set(mapKey, row);
				return row;
			}),
			createIfAbsent: vi.fn(async (input: { userId: string; tokenId?: string | null; kind: string; key: string; value: unknown; expiresAt?: Date | null }) => {
				const mapKey = stateKey(input.kind, input.key);
				if (stateRows.has(mapKey)) {
					throw Object.assign(new MastodonApiError(409, 'conflict', 'The compatibility state has changed'), { code: 'conflict' });
				}
				const now = new Date();
				const row = {
					id: `state-${mapKey}`,
					userId: input.userId,
					tokenId: input.tokenId ?? null,
					kind: input.kind,
					key: input.key,
					value: input.value,
					version: 1,
					createdAt: now,
					updatedAt: now,
					expiresAt: input.expiresAt ?? null,
				};
				stateRows.set(mapKey, row);
				return row;
			}),
			createWithId: vi.fn(async (input: { id: string; userId: string; tokenId?: string | null; kind: string; key: string; value: unknown; expiresAt?: Date | null }) => {
				const mapKey = stateKey(input.kind, input.key);
				if (stateRows.has(mapKey)) throw new MastodonApiError(409, 'conflict', 'The compatibility state has changed');
				const now = new Date();
				const row = { ...input, tokenId: input.tokenId ?? null, version: 1, createdAt: now, updatedAt: now, expiresAt: input.expiresAt ?? null };
				stateRows.set(mapKey, row);
				return row;
			}),
			compareAndSet: vi.fn(async (input: { userId: string; kind: string; key: string; expectedVersion: number; value: unknown }) => {
				const mapKey = stateKey(input.kind, input.key);
				const previous = stateRows.get(mapKey);
				if (previous == null || previous.userId !== input.userId || previous.version !== input.expectedVersion) {
					throw Object.assign(new MastodonApiError(409, 'conflict', 'The compatibility state has changed'), { code: 'conflict' });
				}
				const row = { ...previous, value: input.value, version: previous.version + 1, updatedAt: new Date() };
				stateRows.set(mapKey, row);
				return row;
			}),
			delete: vi.fn(async (userId: string, kind: string, key: string) => {
				const mapKey = stateKey(kind, key);
				const row = stateRows.get(mapKey);
				return row?.userId === userId ? stateRows.delete(mapKey) : false;
			}),
			withUserKindLock: vi.fn(async (_userId: string, _kind: string, callback: (service: unknown) => Promise<unknown>) => {
				const previous = stateLockTail;
				let release!: () => void;
				stateLockTail = new Promise<void>(resolve => {
					release = resolve;
				});
				await previous;
				try {
					return await callback(mastodonApiStateService);
				} finally {
					release();
				}
			}),
			withUserKindLocks: vi.fn(async (_locks: unknown[], callback: (service: unknown) => Promise<unknown>) => await callback(mastodonApiStateService)),
		};
		const mastodonPushSubscriptionService = new MastodonPushSubscriptionService({
			enableServiceWorker: true,
			swPublicKey: 'BFoYnP6n4Huwsti9ptCZtqxxQTT5KpSdGfB8loT2pXzzZYNhOJ4lzcAmndO7ad8LFftUdmUXIZ3Zg-5JSZiu4f0',
			swPrivateKey: 'nCqedreHEKZ54ZtuMX-1ZPkyK1H7e7itEemL_afgvUE',
		} as never, mastodonApiStateService as never, { gen: vi.fn(() => `push-state-${++pushStateSequence}`) } as never);
		const mastodonStreamingEventService = {
			filtersChanged: vi.fn(),
			notificationsMerged: vi.fn(),
			followedTagChanged: vi.fn(),
		};
		const mastodonStreamingApiServerService = {
			handleSse: vi.fn((_request: unknown, reply: { send: (value: string) => unknown }) => reply.send('')),
		};
		const mastodonFilterService = new MastodonFilterService(mastodonApiStateService as never, mastodonStreamingEventService as never);
		const mastodonMarkerService = new MastodonMarkerService(mastodonApiStateService as never);
		const profiles = new Map([['user-id', { userId: 'user-id', mutedInstances: [] as string[] }]]);
		const profileRepository = {
			findOne: vi.fn(async ({ where }: { where: { userId: string } }) => {
				const profile = profiles.get(where.userId);
				return profile == null ? null : { ...profile, mutedInstances: [...profile.mutedInstances] };
			}),
			update: vi.fn(async ({ userId }: { userId: string }, value: { mutedInstances: string[] }) => {
				const profile = profiles.get(userId);
				if (profile != null) profile.mutedInstances = [...value.mutedInstances];
			}),
		};
		const userProfilesRepository = {
			manager: { transaction: vi.fn(async (callback: (manager: { getRepository: () => typeof profileRepository }) => Promise<unknown>) => callback({ getRepository: () => profileRepository })) },
		};
		const mutedThreads = new Set<string>();
		const noteThreadMutingsRepository = {
			query: vi.fn(async (sql: string, parameters: unknown[]) => {
				if (sql.includes('INSERT INTO "note_thread_muting"')) {
					mutedThreads.add(parameters[2] as string);
					return [];
				}
				if (sql.includes('JOIN "note_thread_muting"')) {
					return (parameters[1] as string[]).flatMap(id => mutedThreads.has(nativeThreads.get(id) ?? id) ? [{ id }] : []);
				}
				return [];
			}),
			delete: vi.fn(async ({ threadId }: { threadId: string }) => {
				const affected = mutedThreads.delete(threadId) ? 1 : 0;
				return { affected };
			}),
		};
		const userFeatureCacheService = {
			userProfileCache: {
				fetch: vi.fn(async (userId: string) => profiles.get(userId)),
				set: vi.fn(),
				delete: vi.fn(),
			},
		};
		const existingUserIds = new Set(['target', 'not-followed']);
		const followedUserIds = new Set(['target']);
		const userFeatureUsersRepository = {
			existsBy: vi.fn(async ({ id }: { id: string }) => existingUserIds.has(id)),
			findBy: vi.fn(async () => [...existingUserIds].map(id => ({ id }))),
		};
		const userFeatureFollowingsRepository = {
			existsBy: vi.fn(async ({ followerId, followeeId }: { followerId: string; followeeId: string }) => followerId === 'user-id' && followedUserIds.has(followeeId)),
			findBy: vi.fn(async () => [...followedUserIds].map(followeeId => ({ followerId: 'user-id', followeeId }))),
		};
		const userFeatureUserEntityService = { pack: vi.fn(async () => ({ id: 'user-id' })) };
		const userFeatureGlobalEventService = { publishMainStream: vi.fn() };
		let compatibilityId = 0;
		const mastodonNotificationService = new MastodonNotificationService(
			redis as never,
			mastodonApiStateService as never,
			{ gen: () => `notification-${++compatibilityId}`, parse: () => ({ date: new Date(0) }) } as never,
			{ getUserPolicies: vi.fn(async () => ({ canPublicNote: true })) } as never,
			userFeatureUsersRepository as never,
			userFeatureFollowingsRepository as never,
			mastodonStreamingEventService as never,
		);
		const mastodonUserFeatureService = new MastodonUserFeatureService(
			mastodonApiStateService as never,
			userFeatureUsersRepository as never,
			userFeatureFollowingsRepository as never,
			userProfilesRepository as never,
			noteThreadMutingsRepository as never,
			userFeatureCacheService as never,
			{ gen: () => `compatibility-${++compatibilityId}` } as never,
			userFeatureUserEntityService as never,
			userFeatureGlobalEventService as never,
			mastodonStreamingEventService as never,
		);
		const collection = (overrides: Record<string, unknown> = {}) => ({
			id: 'collection-id',
			account_id: 'user-id',
			uri: 'https://misskey.example/api/v1/collections/collection-id',
			url: null,
			name: 'People',
			description: null,
			language: null,
			local: true,
			sensitive: false,
			discoverable: false,
			tag: null,
			item_count: 0,
			items: [],
			created_at: '2026-07-17T00:00:00.000Z',
			updated_at: '2026-07-17T00:00:00.000Z',
			...overrides,
		});
		const mastodonCollectionService = {
			create: vi.fn(async (_ownerId: string, input: Record<string, unknown>) => collection({ name: input.name })),
			get: vi.fn(async () => ({ collection: collection(), accounts: [{ id: 'user-id' }] })),
			listByAccount: vi.fn(async () => ({ items: [collection()], total: 2, hasMore: true })),
			listInCollections: vi.fn(async () => ({ items: [collection()], total: 1, hasMore: false })),
			update: vi.fn(async (_ownerId: string, _id: string, input: Record<string, unknown>) => collection({ name: input.name ?? 'People' })),
			delete: vi.fn(async () => ({})),
			addItem: vi.fn(async (_ownerId: string, _id: string, accountId: string) => ({
				id: 'item-id',
				account_id: accountId,
				state: 'accepted',
				created_at: '2026-07-17T00:00:00.000Z',
			})),
			removeItem: vi.fn(async () => ({})),
			revoke: vi.fn(async () => ({})),
		};
		const conversation = (overrides: Record<string, unknown> = {}) => ({
			id: 'conversation-id',
			unread: true,
			accounts: [{ id: 'alice', username: 'alice' }],
			lastStatus: { id: 'last-status-id' },
			...overrides,
		});
		const mastodonConversationService = {
			list: vi.fn(async () => [conversation()]),
			read: vi.fn(async () => conversation({ unread: false })),
			unread: vi.fn(async () => conversation({ unread: true })),
			delete: vi.fn(async () => ({})),
		};
		const createReport = vi.fn(async (_reporter: unknown, input: Record<string, unknown>) => ({
			report: { id: 'report-id', resolved: false, forwarded: false },
			createdAt: '2026-07-16T01:02:03.000Z',
			targetUser: { id: input.accountId, username: 'reported' },
			input,
		}));
		const getScheduledStatus = vi.fn().mockResolvedValue({
			id: 'scheduled-draft-id',
			userId: 'user-id',
			isActuallyScheduled: true,
			scheduledAt: Date.parse('2099-01-02T03:04:05.000Z'),
			text: 'Scheduled text',
			fileIds: [],
			files: [],
			cw: null,
			visibility: 'public',
			replyId: null,
			renoteId: null,
			poll: null,
		});
		type TestNote = {
			id: string;
			files?: unknown[];
			poll?: unknown;
			renote?: TestNote | null;
			text?: string | null;
			replyId?: string | null;
		};
		const serializeStatus = (value: TestNote) => {
			const files = value.files ?? [];
			const isPureRenote = value.renote != null && value.text == null && files.length === 0 && value.poll == null && value.replyId == null;
			const nestedStatus = value.renote == null ? null : { id: value.renote.id, muted: false };
			return {
				id: value.id,
				media_attachments: files,
				poll: value.poll ?? null,
				...(nestedStatus == null ? {} : isPureRenote
					? { reblog: nestedStatus }
					: { quote: { quoted_status: nestedStatus } }),
			};
		};
		const service = new MastodonApiServerService(
			{ url: 'https://misskey.example/', host: 'misskey.example', version: '2026.7.0', maxFileSize: 10_000_000 } as never,
			{
				name: 'Misskey Test',
				description: 'Test instance',
				langs: ['en'],
				bannerUrl: null,
				iconUrl: null,
				serverRules: ['Be kind'],
				policies: { pinLimit: 5 },
				...meta,
			} as never,
			notesRepository as never,
			noteFavoritesRepository as never,
			userNotePiningsRepository as never,
			{ registerApplication, getApplication } as never,
			{ authenticate } as never,
			{ assert, assertAny } as never,
			{ invoke: nativeInvoke, invokePublic: publicInvoke } as never,
			{
				account: vi.fn(value => ({ id: value.id, username: value.username })),
				credentialAccount: vi.fn(value => ({ id: value.id, username: value.username })),
				profile: vi.fn(value => ({ id: value.id, display_name: value.name ?? value.username })),
				relationship: vi.fn(value => ({ id: value.id, note: value.memo ?? '', endorsed: false })),
				tag: vi.fn((name, state = {}) => ({
					id: name.normalize('NFKC').toLowerCase(),
					name,
					url: `https://misskey.example/tags/${encodeURIComponent(name)}`,
					history: [],
					...state,
				})),
				featuredTag: vi.fn((tag, accountUrl, stats) => ({
					id: tag.id,
					name: tag.name,
					url: `${accountUrl}/tagged/${tag.name}`,
					statuses_count: stats.statusesCount.toString(),
					last_status_at: stats.lastStatusAt,
				})),
				trendLink: vi.fn(url => ({
					url,
					title: url,
					description: '',
					language: '',
					type: 'link',
					authors: [],
					author_name: '',
					author_url: '',
					provider_name: '',
					provider_url: '',
					html: '',
					width: 0,
					height: 0,
					image: null,
					image_description: '',
					embed_url: '',
					blurhash: null,
					published_at: null,
					history: [],
				})),
				status: vi.fn(serializeStatus),
				statusEdits: vi.fn(value => [...(value.history ?? []), { createdAt: value.updatedAt ?? value.createdAt }].map(edit => ({ created_at: edit.createdAt }))),
				translation: vi.fn((value, language) => ({ detected_source_language: value.sourceLang, language, content: value.text })),
				instanceActivity: vi.fn((notes, users) => notes.local.inc.length === 84 && users.local.inc.length === 84
					? Array.from({ length: 12 }, (_, index) => ({ week: index.toString(), statuses: '7', logins: '0', registrations: '7' }))
					: []),
				poll: vi.fn((noteId, poll) => ({ id: noteId, votes_count: poll.choices.reduce((total: number, choice: { votes: number }) => total + choice.votes, 0) })),
				scheduledStatus: vi.fn(value => ({ id: value.id, scheduled_at: new Date(value.scheduledAt).toISOString() })),
				announcement: vi.fn(value => ({ id: value.id, content: value.text, read: value.isRead ?? false })),
				report: vi.fn((report, _createdAt, _targetUser, input) => ({
					id: report.id,
					category: input.category,
					status_ids: input.statusIds,
				})),
				notification: vi.fn(value => value.user == null ? null : {
					id: value.id,
					type: value.type === 'reaction' || value.type === 'reaction:grouped'
						? 'favourite'
						: value.type === 'renote' || value.type === 'renote:grouped'
							? 'reblog'
							: value.type === 'note'
								? 'status'
								: value.type ?? 'mention',
					account: { id: value.user.id },
					...(value.note == null ? {} : { status: { ...serializeStatus(value.note), content: value.renderedContent ?? '' } }),
				}),
			} as never,
			{
				toMisskey,
				linkHeader,
				offsetLinkHeader,
			} as never,
			mastodonCollectionService as never,
			mastodonConversationService as never,
			mastodonFilterService,
			mastodonMarkerService,
			mastodonNotificationService,
			{ get: getScheduledStatus } as never,
			{ create: createReport } as never,
			mastodonPushSubscriptionService,
			mastodonUserFeatureService,
			redis as never,
			mastodonStreamingApiServerService as never,
		);
		const fastify = Fastify();
		registerBeforeMastodon?.(fastify);
		fastify.register(service.createServer);
		servers.push(fastify);

		return {
			fastify,
			authenticate,
			assert,
			assertAny,
			nativeInvoke,
			publicInvoke,
			registerApplication,
			getApplication,
			redis,
			notesRepository,
			noteFavoritesRepository,
			userNotePiningsRepository,
			linkHeader,
			toMisskey,
			offsetLinkHeader,
			createReport,
			getScheduledStatus,
			mastodonApiStateService,
			mastodonNotificationService,
			mastodonUserFeatureService,
			mastodonCollectionService,
			mastodonConversationService,
			mastodonFilterService,
			mastodonStreamingApiServerService,
			profiles,
			noteThreadMutingsRepository,
			mutedThreads,
			nativeThreads,
			existingUserIds,
			followedUserIds,
			userFeatureCacheService,
			userFeatureGlobalEventService,
		};
	}

	test('exposes the public streaming health response as exact no-store plain text', async () => {
		const { fastify, authenticate } = createServer();
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/streaming/health' });

		expect(response.statusCode).toBe(200);
		expect(response.body).toBe('OK');
		expect(response.headers['content-type']).toMatch(/^text\/plain(?:;|$)/u);
		expect(response.headers['cache-control']).toBe('private, no-store');
		expect(authenticate).not.toHaveBeenCalled();
	});

	test('delegates a streaming path to the SSE adapter', async () => {
		const { fastify, mastodonStreamingApiServerService } = createServer();
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/streaming/public/local?access_token=user-token',
		});

		expect(response.statusCode).toBe(200);
		expect(mastodonStreamingApiServerService.handleSse).toHaveBeenCalledOnce();
		expect(mastodonStreamingApiServerService.handleSse).toHaveBeenCalledWith(expect.objectContaining({ raw: expect.anything() }), expect.objectContaining({ raw: expect.anything() }));
	});

	test('declares all four conversation routes as implemented with the official scopes', () => {
		const contract = (method: string, path: string) => MASTODON_4_6_USER_ROUTES.find(route => route.method === method && route.path === path);

		expect(contract('GET', '/api/v1/conversations')).toMatchObject({ behavior: 'implemented', scope: 'read:statuses', entity: 'Conversation[]' });
		expect(contract('DELETE', '/api/v1/conversations/:id')).toMatchObject({ behavior: 'implemented', scope: 'write:conversations', entity: 'Object' });
		expect(contract('POST', '/api/v1/conversations/:id/read')).toMatchObject({ behavior: 'implemented', scope: 'write:conversations', entity: 'Conversation' });
		expect(contract('POST', '/api/v1/conversations/:id/unread')).toMatchObject({ behavior: 'implemented', scope: 'write:conversations', entity: 'Conversation' });
	});

	test('does not leave high-impact stateful resources on compatibility fallbacks', () => {
		const signatures = [
			'GET /api/v2/filters',
			'POST /api/v2/filters',
			'GET /api/v2/filters/:id',
			'PUT /api/v2/filters/:id',
			'DELETE /api/v2/filters/:id',
			'GET /api/v2/filters/:filter_id/keywords',
			'POST /api/v2/filters/:filter_id/keywords',
			'GET /api/v2/filters/keywords/:id',
			'PUT /api/v2/filters/keywords/:id',
			'DELETE /api/v2/filters/keywords/:id',
			'GET /api/v2/filters/:filter_id/statuses',
			'POST /api/v2/filters/:filter_id/statuses',
			'GET /api/v2/filters/statuses/:id',
			'DELETE /api/v2/filters/statuses/:id',
			'GET /api/v1/markers',
			'POST /api/v1/markers',
			'GET /api/v1/conversations',
			'DELETE /api/v1/conversations/:id',
			'POST /api/v1/conversations/:id/read',
			'POST /api/v1/conversations/:id/unread',
			'POST /api/v1/push/subscription',
			'GET /api/v1/push/subscription',
			'PUT /api/v1/push/subscription',
			'DELETE /api/v1/push/subscription',
		];

		for (const signature of signatures) {
			const [method, path] = signature.split(' ');
			expect(MASTODON_4_6_USER_ROUTES.find(route => route.method === method && route.path === path)).toMatchObject({ behavior: 'implemented' });
		}
	});

	test('lists exact conversation entities with last-status cursors and bounded min_id pagination', async () => {
		const { fastify, assert, linkHeader, mastodonConversationService } = createServer();
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/conversations?limit=999&max_id=older&min_id=newer&since_id=ignored',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([{
			id: 'conversation-id',
			unread: true,
			accounts: [{ id: 'alice', username: 'alice' }],
			last_status: expect.objectContaining({ id: 'last-status-id' }),
		}]);
		expect(mastodonConversationService.list).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-id' }), {
			limit: 40,
			maxId: 'older',
			minId: 'newer',
			sinceId: 'ignored',
		});
		expect(linkHeader).toHaveBeenCalledWith(
			'https://misskey.example/api/v1/conversations?limit=999&max_id=older&min_id=newer&since_id=ignored',
			[{ id: 'last-status-id' }],
		);
		expect(response.headers.link).toBe('<next>; rel="next"');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
	});

	test('uses a default conversation limit of 20', async () => {
		const { fastify, mastodonConversationService } = createServer();
		await fastify.inject({ method: 'GET', url: '/api/v1/conversations', headers: { authorization: 'Bearer user-token' } });

		expect(mastodonConversationService.list).toHaveBeenCalledWith(expect.anything(), {
			limit: 20,
			maxId: undefined,
			minId: undefined,
			sinceId: undefined,
		});
	});

	test.each([
		['POST', '/api/v1/conversations/conversation-id/read', 'read', false],
		['POST', '/api/v1/conversations/conversation-id/unread', 'unread', true],
	] as const)('serves conversation mutation %s %s with an exact entity', async (method, url, action, unread) => {
		const { fastify, assert, mastodonConversationService } = createServer();
		const response = await fastify.inject({ method, url, headers: { authorization: 'Bearer user-token' } });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			id: 'conversation-id',
			unread,
			accounts: [{ id: 'alice', username: 'alice' }],
			last_status: expect.objectContaining({ id: 'last-status-id' }),
		});
		expect(mastodonConversationService[action]).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-id' }), 'conversation-id');
		expect(assert).toHaveBeenCalledWith(['read'], 'write:conversations');
	});

	test('deletes a conversation projection without deleting a native note', async () => {
		const { fastify, assert, nativeInvoke, mastodonConversationService } = createServer();
		const response = await fastify.inject({
			method: 'DELETE',
			url: '/api/v1/conversations/conversation-id',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({});
		expect(mastodonConversationService.delete).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-id' }), 'conversation-id');
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/delete', expect.anything(), expect.anything(), expect.anything());
		expect(assert).toHaveBeenCalledWith(['read'], 'write:conversations');
	});

	test('requires a user token and preserves conversation 404 errors', async () => {
		const { fastify, authenticate, mastodonConversationService } = createServer();
		authenticate.mockResolvedValueOnce({ kind: 'application', token: { id: 'app-token', scopes: ['read'] } });
		const application = await fastify.inject({
			method: 'GET',
			url: '/api/v1/conversations',
			headers: { authorization: 'Bearer app-token' },
		});

		mastodonConversationService.read.mockRejectedValueOnce(new MastodonApiError(404, 'not_found', 'Conversation not found'));
		const missing = await fastify.inject({
			method: 'POST',
			url: '/api/v1/conversations/missing/read',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(application.statusCode).toBe(401);
		expect(missing.statusCode).toBe(404);
		expect(missing.json()).toEqual({ error: 'Conversation not found' });
	});

	test('preserves a conversation when a single-status thread filter would otherwise hide its last status', async () => {
		const { fastify, mastodonFilterService } = createServer();
		const apply = vi.spyOn(mastodonFilterService, 'apply').mockImplementation(async (_userId, _context, statuses, options) => options?.preserveHidden ? statuses : []);
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/conversations', headers: { authorization: 'Bearer user-token' } });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toHaveLength(1);
		expect(apply).toHaveBeenCalledWith('user-id', 'thread', expect.any(Array), expect.objectContaining({ preserveHidden: true }));
	});

	test('lists announcements for user tokens with bounded Mastodon pagination', async () => {
		const { fastify, authenticate, assert, nativeInvoke, toMisskey } = createServer();
		toMisskey.mockReturnValueOnce({ limit: 37, untilId: 'older' });
		nativeInvoke.mockImplementation(async name => name === 'announcements' ? [{
			id: 'announcement-id',
			createdAt: '2026-07-15T01:02:03.000Z',
			updatedAt: null,
			title: 'Notice',
			text: 'Body',
			isRead: true,
		}] : []);

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/announcements?limit=37&max_id=older',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([{ id: 'announcement-id', content: 'Body', read: true }]);
		expect(toMisskey).toHaveBeenCalledWith(expect.objectContaining({ limit: '37', max_id: 'older' }), 100);
		expect(nativeInvoke).toHaveBeenCalledWith('announcements', {
			limit: 37,
			untilId: 'older',
			isActive: true,
		}, expect.any(Object), expect.any(Object));
		expect(authenticate).toHaveBeenCalledWith('user-token');
		expect(assert).not.toHaveBeenCalled();
	});

	test('requires a user token for announcements even though the route has no named scope', async () => {
		const { fastify, authenticate } = createServer();
		const missing = await fastify.inject({ method: 'GET', url: '/api/v1/announcements' });

		authenticate.mockResolvedValueOnce({
			kind: 'application',
			user: null,
			token: { id: 'application-token', scopes: ['read'] },
		});
		const application = await fastify.inject({
			method: 'GET',
			url: '/api/v1/announcements',
			headers: { authorization: 'Bearer application-token' },
		});

		expect(missing.statusCode).toBe(401);
		expect(application.statusCode).toBe(401);
	});

	test('dismisses announcements through the native read endpoint', async () => {
		const { fastify, assert, nativeInvoke } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/announcements/announcement-id/dismiss',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({});
		expect(assert).toHaveBeenCalledWith(['read'], 'write:accounts');
		expect(nativeInvoke).toHaveBeenCalledWith('i/read-announcement', {
			announcementId: 'announcement-id',
		}, expect.any(Object), expect.any(Object));
	});

	test.each(['PUT', 'DELETE'] as const)('authenticates announcement reaction %s before returning 422', async method => {
		const { fastify, assert } = createServer();
		const response = await fastify.inject({
			method,
			url: '/api/v1/announcements/announcement-id/reactions/wave',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(422);
		expect(assert).toHaveBeenCalledWith(['read'], 'write:accounts');
	});

	test('lists and gets scheduled statuses through Note drafts', async () => {
		const { fastify, assert, nativeInvoke, toMisskey, getScheduledStatus } = createServer();
		toMisskey.mockReturnValueOnce({ limit: 21, untilId: 'older' });
		nativeInvoke.mockImplementation(async name => name === 'notes/drafts/list' ? [{
			id: 'scheduled-draft-id',
			isActuallyScheduled: true,
			scheduledAt: Date.parse('2099-01-02T03:04:05.000Z'),
		}] : []);

		const list = await fastify.inject({
			method: 'GET',
			url: '/api/v1/scheduled_statuses?limit=21&max_id=older',
			headers: { authorization: 'Bearer user-token' },
		});
		const show = await fastify.inject({
			method: 'GET',
			url: '/api/v1/scheduled_statuses/scheduled-draft-id',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(list.statusCode).toBe(200);
		expect(list.json()).toEqual([{ id: 'scheduled-draft-id', scheduled_at: '2099-01-02T03:04:05.000Z' }]);
		expect(toMisskey).toHaveBeenCalledWith(expect.objectContaining({ limit: '21', max_id: 'older' }), 100);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/drafts/list', {
			limit: 21,
			untilId: 'older',
			scheduled: true,
		}, expect.any(Object), expect.any(Object));
		expect(show.statusCode).toBe(200);
		expect(show.json()).toEqual({ id: 'scheduled-draft-id', scheduled_at: '2099-01-02T03:04:05.000Z' });
		expect(getScheduledStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-id' }), 'scheduled-draft-id');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
	});

	test('reschedules and deletes only an owned scheduled Note draft', async () => {
		const { fastify, assert, nativeInvoke, getScheduledStatus } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => name === 'notes/drafts/update'
			? { updatedDraft: { ...await getScheduledStatus(), scheduledAt: data.scheduledAt } }
			: []);

		const update = await fastify.inject({
			method: 'PUT',
			url: '/api/v1/scheduled_statuses/scheduled-draft-id',
			headers: { authorization: 'Bearer user-token' },
			payload: { scheduled_at: '2099-02-03T04:05:06.000Z', status: 'must not overwrite the draft' },
		});
		const remove = await fastify.inject({
			method: 'DELETE',
			url: '/api/v1/scheduled_statuses/scheduled-draft-id',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(update.statusCode).toBe(200);
		expect(update.json()).toEqual({ id: 'scheduled-draft-id', scheduled_at: '2099-02-03T04:05:06.000Z' });
		expect(nativeInvoke).toHaveBeenCalledWith('notes/drafts/update', {
			draftId: 'scheduled-draft-id',
			scheduledAt: Date.parse('2099-02-03T04:05:06.000Z'),
			isActuallyScheduled: true,
		}, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('notes/drafts/delete', {
			draftId: 'scheduled-draft-id',
		}, expect.any(Object), expect.any(Object));
		expect(getScheduledStatus).toHaveBeenCalledTimes(3);
		expect(remove.statusCode).toBe(200);
		expect(remove.json()).toEqual({});
		expect(assert).toHaveBeenCalledWith(['read'], 'write:statuses');
	});

	test('creates a future scheduled status as a Note draft with all supported fields', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name === 'notes/drafts/create') return { createdDraft: {
				id: 'new-scheduled-id',
				isActuallyScheduled: true,
				scheduledAt: data.scheduledAt,
			} };
			return {};
		});

		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token' },
			payload: {
				status: 'Scheduled text',
				spoiler_text: 'CW',
				visibility: 'unlisted',
				in_reply_to_id: 'reply-id',
				quoted_status_id: 'quote-id',
				quote_approval_policy: 'public',
				media_ids: ['file-id'],
				sensitive: true,
				poll: { options: ['A', 'B'], multiple: true, expires_in: 3600 },
				language: 'en',
				scheduled_at: '2099-01-02T03:04:05.000Z',
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: 'new-scheduled-id', scheduled_at: '2099-01-02T03:04:05.000Z' });
		expect(nativeInvoke).toHaveBeenCalledWith('notes/drafts/create', {
			text: 'Scheduled text',
			cw: 'CW',
			visibility: 'home',
			replyId: 'reply-id',
			renoteId: 'quote-id',
			fileIds: ['file-id'],
			poll: { choices: ['A', 'B'], multiple: true, expiredAfter: 3600000 },
			scheduledAt: Date.parse('2099-01-02T03:04:05.000Z'),
			isActuallyScheduled: true,
		}, expect.any(Object), expect.any(Object));
		expect(nativeInvoke.mock.calls.find(([name]) => name === 'notes/drafts/create')?.[1]).not.toHaveProperty('language');
		expect(nativeInvoke).toHaveBeenCalledWith('drive/files/update', {
			fileId: 'file-id',
			isSensitive: true,
		}, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/create', expect.anything(), expect.anything(), expect.anything());
	});

	test('maps an immediate quote and rejects semantics that Misskey cannot enforce', async () => {
		const { fastify, nativeInvoke } = createServer();
		const quote = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'Quoted', quoted_status_id: 'quote-id' },
		});
		const invalidPolicy = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'No', quote_approval_policy: 'followers' },
		});
		const allowedMentions = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'No', allowed_mentions: { replied_to: false } },
		});

		expect(quote.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/create', expect.objectContaining({
			text: 'Quoted',
			renoteId: 'quote-id',
		}), expect.any(Object), expect.any(Object));
		expect([invalidPolicy.statusCode, allowedMentions.statusCode]).toEqual([422, 422]);
	});

	test('accepts a status language from Mastodon clients when Notes cannot persist it', async () => {
		const { fastify, nativeInvoke } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'Posted from Elk', language: 'en' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/create', expect.objectContaining({
			text: 'Posted from Elk',
		}), expect.any(Object), expect.any(Object));
		expect(nativeInvoke.mock.calls.find(([name]) => name === 'notes/create')?.[1]).not.toHaveProperty('language');
	});

	test.each([
		['malformed', 'not-a-date', 400],
		['past', '2000-01-02T03:04:05.000Z', 422],
	] as const)('rejects a %s scheduled_at without creating a Note draft', async (_label, scheduledAt, statusCode) => {
		const { fastify, nativeInvoke } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'No', scheduled_at: scheduledAt },
		});

		expect(response.statusCode).toBe(statusCode);
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/drafts/create', expect.anything(), expect.anything(), expect.anything());
	});

	test('serves status edit history publicly and scope-checks an explicitly supplied token', async () => {
		const { fastify, authenticate, assert, nativeInvoke } = createServer();
		nativeInvoke.mockResolvedValue({
			id: 'note-id',
			createdAt: '2025-01-01T00:00:00.000Z',
			updatedAt: '2025-01-02T00:00:00.000Z',
			history: [{ createdAt: '2025-01-01T00:00:00.000Z', text: 'old' }],
		});

		const anonymous = await fastify.inject({ method: 'GET', url: '/api/v1/statuses/note-id/history' });
		const authenticated = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id/history',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(anonymous.statusCode).toBe(200);
		expect(anonymous.json()).toEqual([
			{ created_at: '2025-01-01T00:00:00.000Z' },
			{ created_at: '2025-01-02T00:00:00.000Z' },
		]);
		expect(authenticated.statusCode).toBe(200);
		expect(authenticate).toHaveBeenCalledWith('user-token');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
	});

	test('translates statuses using lang and Accept-Language, and reports unavailable translation truthfully', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'notes/translate'
			? { sourceLang: 'JA', text: 'Hello' }
			: []);
		const explicit = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses/note-id/translate',
			headers: { authorization: 'Bearer user-token' },
			payload: { lang: 'fr' },
		});
		const header = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses/note-id/translate',
			headers: { authorization: 'Bearer user-token', 'accept-language': 'de-DE,de;q=0.8' },
		});

		expect(explicit.statusCode).toBe(200);
		expect(explicit.json()).toEqual({ detected_source_language: 'JA', language: 'fr', content: 'Hello' });
		expect(header.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/translate', { noteId: 'note-id', targetLang: 'fr' }, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('notes/translate', { noteId: 'note-id', targetLang: 'de-DE' }, expect.any(Object), expect.any(Object));

		nativeInvoke.mockResolvedValueOnce(undefined);
		const unavailable = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses/note-id/translate?lang=en',
			headers: { authorization: 'Bearer user-token' },
		});
		expect(unavailable.statusCode).toBe(422);
	});

	test('lists quote Notes for application tokens and filters pure boosts', async () => {
		const { fastify, authenticate, assert, nativeInvoke, linkHeader } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token', scopes: ['read'] },
		});
		nativeInvoke.mockImplementation(async name => name === 'notes/renotes' ? [
			{ id: 'boost-id', renoteId: 'note-id', text: null, cw: null, files: [], poll: null, replyId: null },
			{ id: 'quote-id', renoteId: 'note-id', text: 'My quote', cw: null, files: [], poll: null, replyId: null },
		] : []);

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id/quotes?limit=20',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([expect.objectContaining({ id: 'quote-id' })]);
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
		expect(nativeInvoke).toHaveBeenCalledWith('notes/renotes', expect.objectContaining({ noteId: 'note-id', limit: 20 }), null, expect.any(Object));
		expect(linkHeader).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ id: 'quote-id' })]);
	});

	test.each([
		['POST', '/api/v1/statuses/status-id/quotes/quote-id/revoke'],
		['PUT', '/api/v1/statuses/status-id/interaction_policy'],
	] as const)('authenticates unsupported status-policy write %s %s before returning 422', async (method, url) => {
		const { fastify, assert } = createServer();
		const response = await fastify.inject({ method, url, headers: { authorization: 'Bearer user-token' } });

		expect(response.statusCode).toBe(422);
		expect(assert).toHaveBeenCalledWith(['read'], 'write:statuses');
	});

	test('preserves an omitted CW on status edits and rejects unsupported edit semantics', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => {
			if (name === 'notes/show') return { id: 'note-id', text: 'old', cw: 'Existing CW', fileIds: [] };
			if (name === 'notes/update') return { updatedNote: { id: 'note-id' } };
			return [];
		});
		const edit = await fastify.inject({
			method: 'PUT',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'edited' },
		});
		const poll = await fastify.inject({
			method: 'PUT',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'edited', poll: { options: ['A', 'B'] } },
		});
		const quotePolicy = await fastify.inject({
			method: 'PUT',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'edited', quote_approval_policy: 'followers' },
		});

		expect(edit.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/update', expect.objectContaining({ cw: 'Existing CW' }), expect.any(Object), expect.any(Object));
		expect([poll.statusCode, quotePolicy.statusCode]).toEqual([422, 422]);
	});

	test('accepts a status language on edits when Notes cannot persist it', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => {
			if (name === 'notes/show') return { id: 'note-id', text: 'old', cw: null, fileIds: [] };
			if (name === 'notes/update') return { updatedNote: { id: 'note-id' } };
			return [];
		});
		const response = await fastify.inject({
			method: 'PUT',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer user-token' },
			payload: { status: 'edited from Elk', language: 'en' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/update', expect.objectContaining({
			text: 'edited from Elk',
		}), expect.any(Object), expect.any(Object));
		expect(nativeInvoke.mock.calls.find(([name]) => name === 'notes/update')?.[1]).not.toHaveProperty('language');
	});

	test('projects legacy v1 suggestions as Accounts while preserving v2 Suggestion envelopes', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'users/recommendation'
			? [{ id: 'recommended-id', username: 'recommended' }]
			: []);

		const v1 = await fastify.inject({
			method: 'GET',
			url: '/api/v1/suggestions?limit=7',
			headers: { authorization: 'Bearer user-token' },
		});
		const v2 = await fastify.inject({
			method: 'GET',
			url: '/api/v2/suggestions?limit=7',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(v1.statusCode).toBe(200);
		expect(v1.json()).toEqual([{ id: 'recommended-id', username: 'recommended' }]);
		expect(v2.statusCode).toBe(200);
		expect(v2.json()).toEqual([expect.objectContaining({
			source: 'global',
			account: { id: 'recommended-id', username: 'recommended' },
		})]);
		expect(nativeInvoke).toHaveBeenCalledWith('users/recommendation', { limit: 7, offset: 0 }, expect.any(Object), expect.any(Object));
	});

	test('updates an account note and removes a follower before deriving a fresh Relationship', async () => {
		const { fastify, assert, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => name === 'users/show'
			? { id: data.userId, username: 'target', memo: name === 'users/show' ? 'review later' : '' }
			: {});

		const note = await fastify.inject({
			method: 'POST',
			url: '/api/v1/accounts/target-id/note',
			headers: { authorization: 'Bearer user-token' },
			payload: { comment: 'review later' },
		});
		const remove = await fastify.inject({
			method: 'POST',
			url: '/api/v1/accounts/target-id/remove_from_followers',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(note.statusCode).toBe(200);
		expect(remove.statusCode).toBe(200);
		expect(note.json()).toEqual(expect.objectContaining({ id: 'target-id' }));
		expect(remove.json()).toEqual(expect.objectContaining({ id: 'target-id' }));
		expect(nativeInvoke).toHaveBeenCalledWith('users/update-memo', {
			userId: 'target-id',
			memo: 'review later',
		}, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('following/invalidate', {
			userId: 'target-id',
		}, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('users/show', { userId: 'target-id' }, expect.any(Object), expect.any(Object));
		expect(assert).toHaveBeenCalledWith(['read'], 'write:accounts');
		expect(assert).toHaveBeenCalledWith(['read'], 'write:follows');
	});

	test('requires a string account note and does not report success after native action failures', async () => {
		const { fastify, nativeInvoke } = createServer();
		const missingComment = await fastify.inject({
			method: 'POST',
			url: '/api/v1/accounts/target-id/note',
			headers: { authorization: 'Bearer user-token' },
			payload: {},
		});
		expect(missingComment.statusCode).toBe(400);
		expect(nativeInvoke).not.toHaveBeenCalledWith('users/update-memo', expect.anything(), expect.anything(), expect.anything());

		nativeInvoke.mockImplementation(async name => {
			if (name === 'users/update-memo') throw new ApiError({
				message: 'No such user.',
				code: 'NO_SUCH_USER',
				id: 'missing-user',
				httpStatusCode: 404,
			});
			if (name === 'following/invalidate') throw new ApiError({
				message: 'Forbidden.',
				code: 'FORBIDDEN',
				id: 'forbidden',
				kind: 'permission',
			});
			return { id: 'target-id' };
		});
		const missing = await fastify.inject({
			method: 'POST',
			url: '/api/v1/accounts/target-id/note',
			headers: { authorization: 'Bearer user-token' },
			payload: { comment: 'memo' },
		});
		const forbidden = await fastify.inject({
			method: 'POST',
			url: '/api/v1/accounts/target-id/remove_from_followers',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(missing.statusCode).toBe(404);
		expect(forbidden.statusCode).toBe(403);
		expect(nativeInvoke).not.toHaveBeenCalledWith('users/show', expect.anything(), expect.anything(), expect.anything());
	});

	test('maps the public directory to alive users with bounded offset pagination', async () => {
		const { fastify, publicInvoke, offsetLinkHeader } = createServer();
		publicInvoke.mockImplementation(async name => name === 'users'
			? [{ id: 'directory-user', username: 'directory' }]
			: []);

		const localNew = await fastify.inject({
			method: 'GET',
			url: '/api/v1/directory?order=new&local=true&limit=100&offset=5',
		});
		const active = await fastify.inject({
			method: 'GET',
			url: '/api/v1/directory?order=active&local=false&limit=20',
		});

		expect(localNew.statusCode).toBe(200);
		expect(localNew.json()).toEqual([{ id: 'directory-user', username: 'directory' }]);
		expect(localNew.headers.link).toContain('rel="prev"');
		expect(publicInvoke).toHaveBeenCalledWith('users', {
			limit: 80,
			offset: 5,
			sort: '-createdAt',
			state: 'alive',
			origin: 'local',
		}, null, expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('users', {
			limit: 20,
			offset: 0,
			sort: '-updatedAt',
			state: 'alive',
			origin: 'combined',
		}, null, expect.any(Object));
		expect(offsetLinkHeader).toHaveBeenCalledWith(expect.any(String), 5, 80, false);
		expect(active.statusCode).toBe(200);
	});

	test('returns unique lowercase federation peer hostnames', async () => {
		const { fastify, publicInvoke } = createServer();
		publicInvoke.mockImplementation(async name => name === 'federation/instances' ? [
			{ host: 'Remote.Example' },
			{ host: 'remote.example' },
			{ host: 'Other.Example' },
			{ host: '' },
			{},
		] : []);

		const response = await fastify.inject({ method: 'GET', url: '/api/v1/instance/peers' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(['remote.example', 'other.example']);
		expect(publicInvoke).toHaveBeenCalledWith('federation/instances', { limit: 100, offset: 0 }, null, expect.any(Object));
	});

	test('starts when the core API server already owns the instance peers route', async () => {
		const { fastify, publicInvoke } = createServer({}, server => {
			server.register(async (coreApi: FastifyInstance) => {
				coreApi.get('/v1/instance/peers', async () => ['core.example']);
			}, { prefix: '/api' });
		});

		await fastify.ready();
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/instance/peers' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(['core.example']);
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('builds instance activity from 84 daily Note and user chart points and preserves rule source', async () => {
		const { fastify, publicInvoke } = createServer();
		publicInvoke.mockImplementation(async name => name === 'charts/notes' || name === 'charts/users'
			? { local: { inc: Array.from({ length: 84 }, () => 1) } }
			: []);

		const activity = await fastify.inject({ method: 'GET', url: '/api/v1/instance/activity' });
		const rules = await fastify.inject({ method: 'GET', url: '/api/v1/instance/rules' });

		expect(activity.statusCode).toBe(200);
		expect(activity.json()).toHaveLength(12);
		expect(activity.json()[0]).toEqual({ week: '0', statuses: '7', logins: '0', registrations: '7' });
		expect(publicInvoke).toHaveBeenCalledWith('charts/notes', { span: 'day', limit: 84 }, null, expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('charts/users', { span: 'day', limit: 84 }, null, expect.any(Object));
		expect(rules.json()).toEqual([{ id: '1', text: 'Be kind', hint: '' }]);
	});

	test('returns no instance activity when chart data is empty', async () => {
		const { fastify, publicInvoke } = createServer();
		publicInvoke.mockResolvedValue({ local: { inc: [] } });
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/instance/activity' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
	});

	test('enforces every declared fallback shape, authentication boundary, and error envelope', async () => {
		const { fastify, authenticate, assert, assertAny } = createServer();
		const routes = MASTODON_4_6_USER_ROUTES.filter(route => route.behavior !== 'implemented' && route.transport !== 'websocket');

		for (const route of routes) {
			const key = `${route.method} ${route.path}`;
			const url = new URL(route.samplePath, 'https://misskey.example');
			for (const name of route.requiredQuery ?? []) url.searchParams.set(name, 'value');
			const payload = Object.fromEntries((route.requiredBody ?? []).map(name => [name, 'value']));
			const request = {
				method: route.method,
				url: `${url.pathname}${url.search}`,
				...(route.auth === 'public' ? {} : { headers: { authorization: 'Bearer user-token' } }),
				...(Object.keys(payload).length === 0 ? {} : { payload }),
			} as const;

			assert.mockClear();
			assertAny.mockClear();
			const response = await fastify.inject(request);
			const body = response.json();

			if (route.behavior === 'safe-array') {
				expect(response.statusCode, key).toBe(200);
				expect(body, key).toEqual(route.fallbackBody ?? []);
				expect(Array.isArray(body), key).toBe(true);
			} else if (route.behavior === 'safe-object') {
				expect(response.statusCode, key).toBe(200);
				expect(body, key).toEqual(route.fallbackBody ?? {});
				expect(Array.isArray(body), key).toBe(false);
				expect(body, key).toBeTypeOf('object');
			} else if (route.behavior === 'singleton-not-found') {
				expect(response.statusCode, key).toBe(404);
				expect(body, key).toEqual({ error: 'Record not found' });
			} else {
				expect(response.statusCode, key).toBe(422);
				expect(body, key).toEqual({ error: 'This operation is not supported by this server' });
			}
			expect(JSON.stringify(body), key).not.toMatch(/stack|nativeError|queryFailedError/iu);

			if (route.auth === 'public' || route.scope == null) {
				expect(assert, key).not.toHaveBeenCalled();
				expect(assertAny, key).not.toHaveBeenCalled();
			} else if (typeof route.scope === 'string') {
				expect(assert, key).toHaveBeenCalledWith(['read'], route.scope);
			} else {
				expect(assertAny, key).toHaveBeenCalledWith(['read'], route.scope);
			}

			if (route.auth === 'public') {
				authenticate.mockRejectedValueOnce(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));
				const invalid = await fastify.inject({
					...request,
					headers: { authorization: 'Bearer invalid-token' },
				});
				expect(invalid.statusCode, `${key} invalid token`).toBe(401);
			} else if (route.behavior === 'unsupported-write') {
				const unauthenticated = await fastify.inject({ ...request, headers: {} });
				expect(unauthenticated.statusCode, `${key} unauthenticated`).toBe(401);
			}
		}
	});

	test('registers every documented Mastodon 4.6.3 Fastify route exactly once', async () => {
		const { fastify } = createServer();
		await fastify.ready();
		const keys = new Set<string>();

		for (const route of MASTODON_4_6_USER_ROUTES) {
			const key = `${route.method} ${route.path}`;
			expect(keys.has(key), `duplicate contract route: ${key}`).toBe(false);
			keys.add(key);
			expect(route.path).not.toMatch(/^\/api\/(?:v1|v2)\/admin(?:\/|$)|^\/api\/v1_alpha(?:\/|$)/u);
			expect(route.introducedIn).toMatch(/^\d+\.\d+\.\d+$/u);
			const [major, minor, patch] = route.introducedIn.split('.').map(Number) as [number, number, number];
			expect(
				major < 4 ||
				(major === 4 && minor < 6) ||
				(major === 4 && minor === 6 && patch <= 3),
				`contract route is newer than 4.6.3: ${key}`,
			).toBe(true);
			if (route.transport !== 'websocket') {
				expect(fastify.hasRoute({ method: route.method, url: route.path }), `unregistered contract route: ${key}`).toBe(true);
			}
		}
	});

	test('declares the complete user push-subscription lifecycle as implemented with push scope', () => {
		const contract = (method: string) => MASTODON_4_6_USER_ROUTES.find(route => route.method === method && route.path === '/api/v1/push/subscription');

		for (const method of ['POST', 'GET', 'PUT', 'DELETE']) {
			expect(contract(method)).toMatchObject({
				behavior: 'implemented',
				auth: 'user',
				scope: 'push',
			});
		}
		expect(contract('POST')?.requiredBody).toBeUndefined();
	});

	test('declares exact stateful tag, endorsement, domain-block, and status-mute contracts', () => {
		const contract = (method: string, path: string) => MASTODON_4_6_USER_ROUTES.find(route => route.method === method && route.path === path);
		expect(contract('POST', '/api/v1/tags/:name/follow')).toMatchObject({ behavior: 'implemented', scope: 'write:follows', entity: 'Tag', introducedIn: '4.0.0' });
		expect(contract('POST', '/api/v1/tags/:name/feature')).toMatchObject({ behavior: 'implemented', scope: 'write:accounts', entity: 'Tag', introducedIn: '4.4.0' });
		expect(contract('GET', '/api/v1/accounts/:id/featured_tags')).toMatchObject({ behavior: 'implemented', auth: 'public', entity: 'FeaturedTag[]', introducedIn: '3.3.0' });
		expect(contract('GET', '/api/v1/accounts/:id/endorsements')).toMatchObject({ behavior: 'implemented', auth: 'public', entity: 'Account[]', introducedIn: '4.4.0' });
		expect(contract('POST', '/api/v1/accounts/:id/endorse')).toMatchObject({ behavior: 'implemented', scope: 'write:accounts', entity: 'Relationship', introducedIn: '4.4.0' });
		expect(contract('GET', '/api/v1/domain_blocks')).toMatchObject({ behavior: 'implemented', scope: 'read:blocks', entity: 'String[]', introducedIn: '1.4.0' });
		expect(contract('POST', '/api/v1/domain_blocks')).toMatchObject({ behavior: 'implemented', scope: 'write:blocks', entity: 'Object', introducedIn: '1.4.0' });
		expect(contract('GET', '/api/v1/domain_blocks/preview')).toMatchObject({ behavior: 'unsupported-write', scope: 'read:blocks' });
		expect(contract('POST', '/api/v1/statuses/:id/mute')).toMatchObject({ behavior: 'implemented', scope: 'write:mutes', entity: 'Status', introducedIn: '1.4.2' });
		expect(MASTODON_4_6_USER_ROUTES.some(route => route.path.startsWith('/api/v1/tags/:id/'))).toBe(false);
	});

	test('declares the official July 2026 collection contracts', () => {
		const contract = (method: string, path: string) => MASTODON_4_6_USER_ROUTES.find(route => route.method === method && route.path === path);
		expect(contract('POST', '/api/v1/collections')).toMatchObject({ behavior: 'implemented', auth: 'user', scope: 'write:collections', entity: 'WrappedCollection', requiredBody: ['name'] });
		expect(contract('GET', '/api/v1/collections/:id')).toMatchObject({ behavior: 'implemented', auth: 'public', scope: 'read:collections', entity: 'CollectionWithAccounts' });
		expect(contract('GET', '/api/v1/accounts/:account_id/collections')).toMatchObject({ behavior: 'implemented', auth: 'public', scope: 'read:collections', entity: 'Collections' });
		expect(contract('GET', '/api/v1/accounts/:account_id/in_collections')).toMatchObject({ behavior: 'implemented', auth: 'user', scope: 'read:collections', entity: 'Collections' });
		expect(contract('PATCH', '/api/v1/collections/:id')).toMatchObject({ behavior: 'implemented', entity: 'WrappedCollection' });
		expect(contract('PUT', '/api/v1/collections/:id')).toMatchObject({ behavior: 'implemented', entity: 'WrappedCollection' });
		expect(contract('POST', '/api/v1/collections/:collection_id/items')).toMatchObject({ behavior: 'implemented', requiredBody: ['account_id'], entity: 'WrappedCollectionItem' });
		expect(contract('DELETE', '/api/v1/collections/:collection_id/items/:id')).toMatchObject({ behavior: 'implemented', entity: 'Empty' });
		expect(contract('POST', '/api/v1/collections/:collection_id/items/:id/revoke')).toMatchObject({ behavior: 'implemented', entity: 'Empty' });
		expect(contract('POST', '/api/v1/collections/:collection_id/items/:id')).toBeUndefined();
	});

	test('serves collection create with the wrapped official response', async () => {
		const { fastify, mastodonCollectionService } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/collections',
			headers: { authorization: 'Bearer user-token' },
			payload: { name: 'People' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ collection: { name: 'People' } });
		expect(mastodonCollectionService.create).toHaveBeenCalledWith('user-id', { name: 'People' });
	});

	test('normalizes a single form account_ids[] field for collection create', async () => {
		const { fastify, mastodonCollectionService } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/collections',
			headers: {
				authorization: 'Bearer user-token',
				'content-type': 'application/x-www-form-urlencoded',
			},
			payload: 'name=People&account_ids%5B%5D=target-id',
		});

		expect(response.statusCode).toBe(200);
		expect(mastodonCollectionService.create).toHaveBeenCalledWith('user-id', {
			name: 'People',
			account_ids: ['target-id'],
		});
	});

	test('rejects collection offsets beyond the bounded scan window', async () => {
		const { fastify, mastodonCollectionService } = createServer();
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/user-id/in_collections?offset=961',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(422);
		expect(response.json()).toMatchObject({ error: 'collection window exceeds 1000' });
		expect(mastodonCollectionService.listInCollections).not.toHaveBeenCalled();
	});

	test('serves all collection reads, mutations, wrappers, pagination, and empty objects', async () => {
		const { fastify, assert, offsetLinkHeader, mastodonCollectionService } = createServer();
		const inject = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>, authenticated = true) => await fastify.inject({
			method,
			url,
			...(authenticated ? { headers: { authorization: 'Bearer user-token' } } : {}),
			...(payload == null ? {} : { payload }),
		});

		const single = await inject('GET', '/api/v1/collections/collection-id', undefined, false);
		expect(single.statusCode).toBe(200);
		expect(single.json()).toMatchObject({ collection: { id: 'collection-id' }, accounts: [{ id: 'user-id' }] });
		expect(mastodonCollectionService.get).toHaveBeenCalledWith('collection-id', null);

		const accountPage = await inject('GET', '/api/v1/accounts/user-id/collections?limit=999&offset=40', undefined, false);
		expect(accountPage.json()).toMatchObject({ collections: [{ id: 'collection-id' }] });
		expect(accountPage.headers.link).toBe('<next:120>; rel="next", <prev:0>; rel="prev"');
		expect(mastodonCollectionService.listByAccount).toHaveBeenCalledWith('user-id', null, { limit: 80, offset: 40 });
		expect(offsetLinkHeader).toHaveBeenCalledWith(expect.stringContaining('/api/v1/accounts/user-id/collections'), 40, 80, true);

		const boundaryPage = await inject('GET', '/api/v1/accounts/user-id/collections?limit=80&offset=920', undefined, false);
		expect(boundaryPage.headers.link).toBe('<prev:840>; rel="prev"');
		expect(offsetLinkHeader).toHaveBeenCalledWith(expect.stringContaining('/api/v1/accounts/user-id/collections'), 920, 80, false);
		const nearBoundaryPage = await inject('GET', '/api/v1/accounts/user-id/collections?limit=80&offset=900', undefined, false);
		expect(nearBoundaryPage.headers.link).toBe('<prev:820>; rel="prev"');
		expect(offsetLinkHeader).toHaveBeenCalledWith(expect.stringContaining('/api/v1/accounts/user-id/collections'), 900, 80, false);

		const memberships = await inject('GET', '/api/v1/accounts/user-id/in_collections?limit=20&offset=0');
		expect(memberships.json()).toMatchObject({ collections: [{ id: 'collection-id' }] });
		expect(mastodonCollectionService.listInCollections).toHaveBeenCalledWith('user-id', 'user-id', { limit: 20, offset: 0 });

		for (const method of ['PATCH', 'PUT'] as const) {
			const updated = await inject(method, '/api/v1/collections/collection-id', { name: `${method} name` });
			expect(updated.json()).toMatchObject({ collection: { name: `${method} name` } });
		}

		const added = await inject('POST', '/api/v1/collections/collection-id/items', { account_id: 'target-id' });
		expect(added.json()).toEqual({
			collection_item: {
				id: 'item-id',
				account_id: 'target-id',
				state: 'accepted',
				created_at: '2026-07-17T00:00:00.000Z',
			},
		});

		for (const [method, url] of [
			['DELETE', '/api/v1/collections/collection-id'],
			['DELETE', '/api/v1/collections/collection-id/items/item-id'],
			['POST', '/api/v1/collections/collection-id/items/item-id/revoke'],
		] as const) {
			const response = await inject(method, url);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({});
		}

		expect(assert.mock.calls.map(call => call[1] ?? call[0])).toEqual(expect.arrayContaining([
			'read:collections',
			'write:collections',
		]));
	});

	test('persists v2 filters and exposes their v1 keyword projections', async () => {
		const { fastify } = createServer();
		const created = await fastify.inject({
			method: 'POST',
			url: '/api/v2/filters',
			headers: { authorization: 'Bearer user-token' },
			payload: {
				title: 'spoilers',
				context: ['home'],
				filter_action: 'warn',
				keywords: [{ keyword: 'ending', whole_word: true }],
			},
		});
		const filters = await fastify.inject({
			method: 'GET',
			url: '/api/v2/filters',
			headers: { authorization: 'Bearer user-token' },
		});
		const legacy = await fastify.inject({
			method: 'GET',
			url: '/api/v1/filters',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(created.statusCode).toBe(200);
		expect(filters.statusCode).toBe(200);
		expect(filters.json()).toEqual([expect.objectContaining({ title: 'spoilers' })]);
		expect(legacy.statusCode).toBe(200);
		expect(legacy.json()).toEqual([expect.objectContaining({ phrase: 'ending', whole_word: true })]);
	});

	test('accepts JSON and form bracket marker updates with independently versioned timelines', async () => {
		const { fastify } = createServer();
		const json = await fastify.inject({
			method: 'POST',
			url: '/api/v1/markers',
			headers: { authorization: 'Bearer user-token' },
			payload: { home: { last_read_id: '10' } },
		});
		const form = await fastify.inject({
			method: 'POST',
			url: '/api/v1/markers',
			headers: {
				authorization: 'Bearer user-token',
				'content-type': 'application/x-www-form-urlencoded',
			},
			payload: 'notifications%5Blast_read_id%5D=20',
		});
		const read = await fastify.inject({
			method: 'GET',
			url: '/api/v1/markers?timeline%5B%5D=home&timeline%5B%5D=notifications',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(json.statusCode).toBe(200);
		expect(json.json()).toMatchObject({ home: { last_read_id: '10', version: 1 } });
		expect(form.statusCode).toBe(200);
		expect(form.json()).toMatchObject({ notifications: { last_read_id: '20', version: 1 } });
		expect(read.statusCode).toBe(200);
		expect(read.json()).toMatchObject({
			home: { last_read_id: '10' },
			notifications: { last_read_id: '20' },
		});
	});

	test('removes hidden matches from home collections but preserves a single status response', async () => {
		const { fastify } = createServer();
		const created = await fastify.inject({
			method: 'POST',
			url: '/api/v2/filters',
			headers: { authorization: 'Bearer user-token' },
			payload: {
				title: 'hide note',
				context: ['home', 'thread'],
				filter_action: 'hide',
				statuses: [{ status_id: 'note-id' }],
			},
		});
		const timeline = await fastify.inject({
			method: 'GET',
			url: '/api/v1/timelines/home',
			headers: { authorization: 'Bearer user-token' },
		});
		const single = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(created.statusCode).toBe(200);
		expect(timeline.statusCode).toBe(200);
		expect(timeline.json()).toEqual([]);
		expect(single.statusCode).toBe(200);
		expect(single.json()).toMatchObject({ id: 'note-id', filtered: [expect.any(Object)] });
	});

	test('builds filter text from native Note fields, including nested renotes', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'notes/timeline' ? [{
			id: 'native-note',
			text: 'body needle',
			cw: 'cw needle',
			files: [{ comment: 'media needle' }],
			poll: { choices: [{ text: 'poll needle' }] },
			renote: {
				id: 'renoted-note',
				text: 'renote needle',
				cw: null,
				files: [],
				poll: null,
				renote: null,
			},
		}] : []);
		const keywords = ['body needle', 'cw needle', 'media needle', 'poll needle', 'renote needle'];
		const created = await fastify.inject({
			method: 'POST',
			url: '/api/v2/filters',
			headers: { authorization: 'Bearer user-token' },
			payload: {
				title: 'native fields',
				context: ['home'],
				filter_action: 'warn',
				keywords: keywords.map(keyword => ({ keyword, whole_word: false })),
			},
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/timelines/home',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(created.statusCode).toBe(200);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject([{
			id: 'native-note',
			filtered: [{ keyword_matches: keywords }],
		}]);
	});

	test('authenticates unavailable singleton reads before returning 404', async () => {
		const { fastify } = createServer();
		const unauthenticated = await fastify.inject({ method: 'GET', url: '/api/v1/push/subscription' });
		const authenticated = await fastify.inject({
			method: 'GET',
			url: '/api/v1/push/subscription',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(unauthenticated.statusCode).toBe(401);
		expect(authenticated.statusCode).toBe(404);
		expect(authenticated.json()).toEqual({ error: 'Record not found' });
	});

	test('serves the JSON and bracket-form push subscription lifecycle per bearer token', async () => {
		const { fastify, assert } = createServer();
		const headers = { authorization: 'Bearer user-token' };
		const p256dh = 'BFoYnP6n4Huwsti9ptCZtqxxQTT5KpSdGfB8loT2pXzzZYNhOJ4lzcAmndO7ad8LFftUdmUXIZ3Zg-5JSZiu4f0';
		const clientAuth = 'MLACbMpb8aYGL4nf4aiwCA';
		const created = await fastify.inject({ method: 'POST', url: '/api/v1/push/subscription', headers, payload: {
			subscription: { endpoint: 'https://push.example/json', keys: { p256dh, auth: clientAuth }, standard: true },
			data: { policy: 'all', alerts: { mention: true } },
		} });
		expect(created.statusCode).toBe(200);
		expect(created.json()).toMatchObject({ id: 'push-state-1', endpoint: 'https://push.example/json', standard: true });
		expect(created.json()).not.toHaveProperty('policy');
		expect((await fastify.inject({ method: 'GET', url: '/api/v1/push/subscription', headers })).json()).toEqual(created.json());

		const updated = await fastify.inject({ method: 'PUT', url: '/api/v1/push/subscription', headers, payload: { data: { alerts: { poll: true } } } });
		expect(updated.json()).toMatchObject({ id: 'push-state-1', endpoint: 'https://push.example/json', alerts: { mention: false, poll: true } });

		const form = new URLSearchParams({
			'subscription[endpoint]': 'https://push.example/form',
			'subscription[keys][p256dh]': p256dh,
			'subscription[keys][auth]': clientAuth,
			'data[policy]': 'followed',
			'data[alerts][quote]': 'true',
		});
		const replaced = await fastify.inject({ method: 'POST', url: '/api/v1/push/subscription', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: form.toString() });
		expect(replaced.statusCode).toBe(200);
		expect(replaced.json()).toMatchObject({ id: 'push-state-2', endpoint: 'https://push.example/form', alerts: { quote: true } });
		expect(assert).toHaveBeenCalledWith(['read'], 'push');

		expect((await fastify.inject({ method: 'DELETE', url: '/api/v1/push/subscription', headers })).json()).toEqual({});
		expect((await fastify.inject({ method: 'GET', url: '/api/v1/push/subscription', headers })).statusCode).toBe(404);
	});

	test('persists filter writes only after authentication and scope checks', async () => {
		const { fastify, assert } = createServer();
		const payload = { phrase: 'spoiler', context: ['home'] };
		const unauthenticated = await fastify.inject({ method: 'POST', url: '/api/v1/filters', payload });

		assert.mockImplementationOnce(() => {
			throw new MastodonApiError(403, 'insufficient_scope', 'Scope write:filters is required');
		});
		const insufficient = await fastify.inject({
			method: 'POST',
			url: '/api/v1/filters',
			headers: { authorization: 'Bearer user-token' },
			payload,
		});
		const authorized = await fastify.inject({
			method: 'POST',
			url: '/api/v1/filters',
			headers: { authorization: 'Bearer user-token' },
			payload,
		});

		expect(unauthenticated.statusCode).toBe(401);
		expect(insufficient.statusCode).toBe(403);
		expect(authorized.statusCode).toBe(200);
		expect(authorized.json()).toMatchObject({ phrase: 'spoiler', context: ['home'] });
	});

	test('rejects unauthenticated filter writes before validating their parameters', async () => {
		const { fastify, authenticate } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/filters',
			payload: { context: ['home'] },
		});

		expect(response.statusCode).toBe(401);
		expect(authenticate).not.toHaveBeenCalled();
	});

	test('rejects application tokens on user-only compatibility routes with 401', async () => {
		const { fastify, authenticate } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token-id', scopes: ['read:filters'] },
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/filters',
			headers: { authorization: 'Bearer application-token' },
		});

		expect(response.statusCode).toBe(401);
	});

	test('maps and applies notification type and account filters', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [
			{ id: 'notification-a', type: 'mention', user: { id: 'account-a' } },
			{ id: 'notification-b', type: 'mention', user: { id: 'account-b' } },
		] : []);

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/notifications?types[]=mention&types[]=favourite&exclude_types[]=follow&exclude_types[]=reblog&account_id=account-a',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([
			expect.objectContaining({ id: 'notification-a', account: { id: 'account-a' } }),
		]);
		expect(nativeInvoke).toHaveBeenCalledWith('i/notifications', {
			limit: 40,
			markAsRead: false,
			includeTypes: ['mention', 'reply', 'quote', 'reaction'],
		}, expect.any(Object), expect.any(Object));
	});

	test('keeps v1 notification group_key on server grouping when grouped_types is empty', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [{
			id: 'grouped-v1', type: 'reaction', createdAt: '2026-07-17T10:00:00.000Z', user: { id: 'actor-a' }, note: { id: 'status-1' },
		}] : []);
		const headers = { authorization: 'Bearer user-token' };

		const list = await fastify.inject({ method: 'GET', url: '/api/v1/notifications?grouped_types[]=', headers });
		const show = await fastify.inject({ method: 'GET', url: '/api/v1/notifications/grouped-v1?grouped_types[]=', headers });

		expect(list.json()[0].group_key).toMatch(/^favourite-status-1-/u);
		expect(show.json().group_key).toMatch(/^favourite-status-1-/u);
	});

	test('applies notification filters against the native notification Note', async () => {
		const { fastify, nativeInvoke, linkHeader } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [{
			id: 'notification-native',
			type: 'note',
			user: { id: 'account-a' },
			note: { id: 'notification-note', text: 'notification needle', cw: null, files: [], poll: null, renote: null },
			renderedContent: '<p>unrelated generated content</p>',
		}] : []);
		await fastify.inject({
			method: 'POST',
			url: '/api/v2/filters',
			headers: { authorization: 'Bearer user-token' },
			payload: {
				title: 'hide native notification',
				context: ['notifications'],
				filter_action: 'hide',
				keywords: [{ keyword: 'notification needle', whole_word: false }],
			},
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/notifications',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
		expect(linkHeader).toHaveBeenCalledWith(expect.stringContaining('/api/v1/notifications'), [{ id: 'notification-native' }]);
	});

	test('keeps v1 notification pagination links when policy filtering hides the whole native page', async () => {
		const { fastify, nativeInvoke, linkHeader } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [{
			id: 'hidden-notification',
			type: 'follow',
			createdAt: '2026-07-17T10:00:00.000Z',
			user: { id: 'actor-a' },
		}] : []);
		const headers = { authorization: 'Bearer user-token' };
		await fastify.inject({ method: 'PATCH', url: '/api/v2/notifications/policy', headers, payload: { for_not_following: 'filter' } });

		const response = await fastify.inject({ method: 'GET', url: '/api/v1/notifications?limit=999&max_id=next-page', headers });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
		expect(linkHeader).toHaveBeenCalledWith(expect.stringContaining('/api/v1/notifications'), [{ id: 'hidden-notification' }]);
		expect(nativeInvoke).toHaveBeenCalledWith('i/notifications', { limit: 80, markAsRead: false }, expect.any(Object), expect.any(Object));
	});

	test('keeps v2 notification pagination links on raw page boundaries when policy hides every group', async () => {
		const { fastify, nativeInvoke, linkHeader } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [
			{ id: 'hidden-new', type: 'follow', createdAt: '2026-07-17T11:00:00.000Z', user: { id: 'actor-a' } },
			{ id: 'hidden-old', type: 'follow', createdAt: '2026-07-17T10:00:00.000Z', user: { id: 'actor-b' } },
		] : []);
		const headers = { authorization: 'Bearer user-token' };
		await fastify.inject({ method: 'PATCH', url: '/api/v2/notifications/policy', headers, payload: { for_not_following: 'drop' } });

		const response = await fastify.inject({ method: 'GET', url: '/api/v2/notifications', headers });

		expect(response.json()).toEqual({ accounts: [], statuses: [], notification_groups: [] });
		expect(linkHeader).toHaveBeenCalledWith(expect.stringContaining('/api/v2/notifications'), [{ id: 'hidden-new' }, { id: 'hidden-old' }]);
	});

	test('subtracts excluded notification types from includes before native grouped filtering', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name !== 'i/notifications') return [];
			const notifications = [
				{ id: 'favourite', type: 'reaction', user: { id: 'account-a' } },
				{ id: 'reblog', type: 'renote', user: { id: 'account-b' } },
			];
			if (Array.isArray(data.includeTypes)) {
				const includeTypes = data.includeTypes as string[];
				return notifications.filter(notification => includeTypes.includes(notification.type));
			}
			return notifications;
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/notifications?types[]=favourite&types[]=reblog&exclude_types[]=favourite',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([
			expect.objectContaining({ id: 'reblog', type: 'reblog' }),
		]);
		expect(nativeInvoke).toHaveBeenCalledWith('i/notifications', {
			limit: 40,
			markAsRead: false,
			includeTypes: ['reaction', 'renote'],
		}, expect.any(Object), expect.any(Object));
	});

	test('keeps distinct status and mention filters separate after Mastodon conversion', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name !== 'i/notifications') return [];
			const notifications = [
				{ id: 'status', type: 'note', user: { id: 'account-a' } },
				{ id: 'mention', type: 'mention', user: { id: 'account-b' } },
			];
			const includeTypes = Array.isArray(data.includeTypes) ? data.includeTypes as string[] : null;
			return includeTypes == null ? notifications : notifications.filter(notification => includeTypes.includes(notification.type));
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/notifications?types[]=status&exclude_types[]=mention',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([expect.objectContaining({ id: 'status', type: 'status' })]);
		expect(nativeInvoke).toHaveBeenCalledWith('i/notifications', {
			limit: 40,
			markAsRead: false,
			includeTypes: ['note'],
		}, expect.any(Object), expect.any(Object));
	});

	test('applies exact notification exclusions after Mastodon conversion', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name !== 'i/notifications') return [];
			const notifications = [{ id: 'status', type: 'note', user: { id: 'account-a' } }];
			const includeTypes = Array.isArray(data.includeTypes) ? data.includeTypes as string[] : null;
			return includeTypes == null ? notifications : notifications.filter(notification => includeTypes.includes(notification.type));
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/notifications?types[]=status&exclude_types[]=status',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
		expect(nativeInvoke).toHaveBeenCalledWith('i/notifications', {
			limit: 40,
			markAsRead: false,
			includeTypes: ['note'],
		}, expect.any(Object), expect.any(Object));
	});

	test('dismisses one notification without deleting native notifications', async () => {
		const { fastify, assert, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [
			{ id: 'notification-a', type: 'mention', user: { id: 'account-a' } },
			{ id: 'notification-b', type: 'mention', user: { id: 'account-b' } },
		] : []);
		const headers = { authorization: 'Bearer user-token' };

		const dismissed = await fastify.inject({
			method: 'POST',
			url: '/api/v1/notifications/notification-a/dismiss',
			headers,
		});
		const list = await fastify.inject({ method: 'GET', url: '/api/v1/notifications', headers });
		const single = await fastify.inject({ method: 'GET', url: '/api/v1/notifications/notification-a', headers });

		expect(dismissed.statusCode).toBe(200);
		expect(dismissed.json()).toEqual({});
		expect(list.statusCode).toBe(200);
		expect(list.json()).toEqual([
			expect.objectContaining({ id: 'notification-b' }),
		]);
		expect(single.statusCode).toBe(404);
		expect(assert).toHaveBeenCalledWith(['read'], 'write:notifications');
		expect(nativeInvoke).not.toHaveBeenCalledWith(expect.stringContaining('delete'), expect.anything(), expect.anything(), expect.anything());
	});

	test('declares notification groups, policies, requests, and the canonical merged route as implemented', () => {
		const contract = (method: string, path: string) => MASTODON_4_6_USER_ROUTES.find(route => route.method === method && route.path === path);

		for (const [method, path] of [
			['GET', '/api/v1/notifications/unread_count'],
			['GET', '/api/v2/notifications'],
			['GET', '/api/v2/notifications/:group_key'],
			['GET', '/api/v2/notifications/:group_key/accounts'],
			['POST', '/api/v2/notifications/:group_key/dismiss'],
			['POST', '/api/v2/notifications/clear'],
			['GET', '/api/v2/notifications/unread_count'],
			['GET', '/api/v1/notifications/requests'],
			['GET', '/api/v1/notifications/requests/:id'],
			['GET', '/api/v1/notifications/requests/merged'],
			['POST', '/api/v1/notifications/requests/accept'],
			['POST', '/api/v1/notifications/requests/dismiss'],
			['POST', '/api/v1/notifications/requests/:id/accept'],
			['POST', '/api/v1/notifications/requests/:id/dismiss'],
			['GET', '/api/v1/notifications/policy'],
			['PATCH', '/api/v1/notifications/policy'],
			['PUT', '/api/v1/notifications/policy'],
			['GET', '/api/v2/notifications/policy'],
			['PATCH', '/api/v2/notifications/policy'],
			['PUT', '/api/v2/notifications/policy'],
		] as const) {
			expect(contract(method, path), `${method} ${path}`).toMatchObject({ behavior: 'implemented' });
		}
		expect(contract('GET', '/api/v1/notifications/requests/:id/merged')).toBeUndefined();
	});

	test('serves exact v2 grouped wrappers, account expansion, unread counts, dismissal, and clear from one bounded native source', async () => {
		const { fastify, nativeInvoke, assert, linkHeader } = createServer();
		const notifications = [
			{ id: '302', type: 'reaction', createdAt: '2026-07-17T10:45:00.000Z', user: { id: 'actor-b' }, note: { id: 'status-1' } },
			{ id: '301', type: 'reaction', createdAt: '2026-07-17T10:15:00.000Z', user: { id: 'actor-a' }, note: { id: 'status-1' } },
		];
		nativeInvoke.mockImplementation(async (name, data) => name === 'i/notifications' ? notifications
			.filter(notification => typeof data.untilId !== 'string' || notification.id < data.untilId)
			.filter(notification => typeof data.sinceId !== 'string' || notification.id > data.sinceId) : []);
		const headers = { authorization: 'Bearer user-token' };

		const listed = await fastify.inject({ method: 'GET', url: '/api/v2/notifications?limit=999', headers });
		expect(listed.statusCode).toBe(200);
		expect(listed.json()).toEqual({
			accounts: [{ id: 'actor-b' }, { id: 'actor-a' }],
			statuses: [expect.objectContaining({ id: 'status-1' })],
			notification_groups: [expect.objectContaining({
				group_key: expect.stringMatching(/^favourite-status-1-/u),
				notifications_count: 2,
				type: 'favourite',
				most_recent_notification_id: '302',
				page_min_id: '301',
				page_max_id: '302',
				sample_account_ids: ['actor-b', 'actor-a'],
				status_id: 'status-1',
			})],
		});
		const groupKey = listed.json().notification_groups[0].group_key as string;
		expect(nativeInvoke).toHaveBeenCalledWith('i/notifications', { limit: 100, markAsRead: false }, expect.any(Object), expect.any(Object));
		expect(linkHeader).toHaveBeenCalledWith(expect.stringContaining('/api/v2/notifications'), [{ id: '302' }, { id: '301' }]);

		const single = await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${groupKey}`, headers });
		const accounts = await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${groupKey}/accounts`, headers });
		const firstAccountPage = await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${groupKey}/accounts?limit=1`, headers });
		const nextAccountPage = await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${groupKey}/accounts?limit=1&max_id=302`, headers });
		const unread = await fastify.inject({ method: 'GET', url: '/api/v2/notifications/unread_count', headers });
		expect(single.json()).toEqual(listed.json());
		expect(accounts.json()).toEqual([{ id: 'actor-b' }, { id: 'actor-a' }]);
		expect(firstAccountPage.json()).toEqual([{ id: 'actor-b' }]);
		expect(nextAccountPage.json()).toEqual([{ id: 'actor-a' }]);
		expect(linkHeader).toHaveBeenCalledWith(expect.stringContaining(`/api/v2/notifications/${groupKey}/accounts`), [expect.objectContaining({ id: '302' })]);
		linkHeader.mockClear();
		const partialAccountPage = await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${groupKey}/accounts?limit=2&max_id=302`, headers });
		const exhaustedAccountPage = await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${groupKey}/accounts?limit=1&max_id=301`, headers });
		const missingAccountPage = await fastify.inject({ method: 'GET', url: '/api/v2/notifications/missing-group/accounts?limit=1', headers });
		expect(partialAccountPage.json()).toEqual([{ id: 'actor-a' }]);
		expect(exhaustedAccountPage.statusCode).toBe(200);
		expect(exhaustedAccountPage.json()).toEqual([]);
		expect(missingAccountPage.statusCode).toBe(200);
		expect(missingAccountPage.json()).toEqual([]);
		expect(linkHeader).not.toHaveBeenCalled();
		expect(unread.json()).toEqual({ count: 1 });

		const ungroupedList = await fastify.inject({ method: 'GET', url: '/api/v2/notifications?grouped_types[]=mention', headers });
		const ungroupedKey = ungroupedList.json().notification_groups[0].group_key as string;
		expect(ungroupedKey).toBe('ungrouped-302');
		expect((await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${ungroupedKey}`, headers })).json()).toMatchObject({
			notification_groups: [expect.objectContaining({ group_key: ungroupedKey })],
		});
		expect((await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${ungroupedKey}/accounts`, headers })).json()).toEqual([{ id: 'actor-b' }]);
		expect((await fastify.inject({ method: 'POST', url: `/api/v2/notifications/${ungroupedKey}/dismiss`, headers })).json()).toEqual({});
		expect((await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${ungroupedKey}`, headers })).statusCode).toBe(404);
		expect((await fastify.inject({ method: 'GET', url: '/api/v1/notifications', headers })).json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: '302' })]));

		const dismissed = await fastify.inject({ method: 'POST', url: `/api/v2/notifications/${groupKey}/dismiss`, headers });
		expect(dismissed.json()).toEqual({});
		expect((await fastify.inject({ method: 'GET', url: `/api/v2/notifications/${groupKey}`, headers })).statusCode).toBe(404);
		expect((await fastify.inject({ method: 'GET', url: '/api/v2/notifications?grouped_types[]=mention', headers })).json()).toEqual({ accounts: [], statuses: [], notification_groups: [] });
		notifications.unshift({ id: '303', type: 'reaction', createdAt: '2026-07-17T10:55:00.000Z', user: { id: 'actor-c' }, note: { id: 'status-1' } });
		expect((await fastify.inject({ method: 'GET', url: '/api/v2/notifications', headers })).json()).toMatchObject({
			notification_groups: [expect.objectContaining({ most_recent_notification_id: '303' })],
		});
		expect((await fastify.inject({ method: 'POST', url: '/api/v2/notifications/clear', headers })).json()).toEqual({});
		expect(nativeInvoke).toHaveBeenCalledWith('notifications/mark-all-as-read', {}, expect.any(Object), expect.any(Object));
		expect(assert).toHaveBeenCalledWith(['read'], 'write:notifications');
	});

	test('uses bounded interleaved group consumption and global notification Link boundaries', async () => {
		const { fastify, nativeInvoke, linkHeader } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [
			{ id: '103', type: 'reaction', createdAt: '2026-07-17T10:30:00.000Z', user: { id: 'actor-a' }, note: { id: 'status-a' } },
			{ id: '102', type: 'reaction', createdAt: '2026-07-17T10:20:00.000Z', user: { id: 'actor-b' }, note: { id: 'status-b' } },
			{ id: '101', type: 'reaction', createdAt: '2026-07-17T10:10:00.000Z', user: { id: 'actor-c' }, note: { id: 'status-a' } },
		] : []);
		const headers = { authorization: 'Bearer user-token' };

		const one = await fastify.inject({ method: 'GET', url: '/api/v2/notifications?limit=1', headers });
		expect(one.json().notification_groups).toEqual([expect.objectContaining({ notifications_count: 1, page_min_id: '103', page_max_id: '103' })]);
		expect(linkHeader).toHaveBeenLastCalledWith(expect.stringContaining('/api/v2/notifications'), [{ id: '103' }, { id: '103' }]);
		const two = await fastify.inject({ method: 'GET', url: '/api/v2/notifications?limit=2', headers });
		expect(two.json().notification_groups).toHaveLength(2);
		expect(linkHeader).toHaveBeenLastCalledWith(expect.stringContaining('/api/v2/notifications'), [{ id: '103' }, { id: '101' }]);
	});

	test('supports canonical and legacy notification policy shapes, PATCH and PUT aliases, strict enums, and bounded dynamic summary', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [{
			id: '401', type: 'follow', createdAt: '2026-07-17T10:00:00.000Z', user: { id: 'actor-a' },
		}] : []);
		const headers = { authorization: 'Bearer user-token' };

		const defaults = await fastify.inject({ method: 'GET', url: '/api/v2/notifications/policy', headers });
		expect(defaults.json()).toEqual({
			for_not_following: 'accept', for_not_followers: 'accept', for_new_accounts: 'accept',
			for_private_mentions: 'drop', for_limited_accounts: 'filter',
			summary: { pending_requests_count: 0, pending_notifications_count: 0 },
		});
		const patched = await fastify.inject({ method: 'PATCH', url: '/api/v2/notifications/policy', headers, payload: { for_not_following: 'filter' } });
		expect(patched.json()).toMatchObject({ for_not_following: 'filter', summary: { pending_requests_count: 1, pending_notifications_count: 1 } });
		const put = await fastify.inject({ method: 'PUT', url: '/api/v2/notifications/policy', headers, payload: { for_not_followers: 'drop' } });
		expect(put.json()).toMatchObject({ for_not_following: 'filter', for_not_followers: 'drop' });
		const invalid = await fastify.inject({ method: 'PATCH', url: '/api/v2/notifications/policy', headers, payload: { for_new_accounts: 'later' } });
		expect(invalid.statusCode).toBe(422);

		const legacy = await fastify.inject({ method: 'GET', url: '/api/v1/notifications/policy', headers });
		expect(legacy.json()).toEqual({
			filter_not_following: true,
			filter_not_followers: true,
			filter_new_accounts: false,
			filter_private_mentions: true,
			summary: expect.any(Object),
		});
		const legacyUpperTrue = await fastify.inject({ method: 'PATCH', url: '/api/v1/notifications/policy', headers, payload: { filter_new_accounts: 'TRUE' } });
		expect(legacyUpperTrue.json()).toMatchObject({ filter_new_accounts: true });
		const legacyUpperOff = await fastify.inject({ method: 'PUT', url: '/api/v1/notifications/policy', headers, payload: { filter_new_accounts: 'OFF' } });
		expect(legacyUpperOff.json()).toMatchObject({ filter_new_accounts: false });
	});

	test('lists actor requests with public-id cursors and handles canonical merged and bracketed bulk actions', async () => {
		const { fastify, nativeInvoke, linkHeader } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i/notifications' ? [
			{ id: '502', type: 'follow', createdAt: '2026-07-17T11:00:00.000Z', user: { id: 'actor-a' } },
			{ id: '501', type: 'follow', createdAt: '2026-07-17T10:00:00.000Z', user: { id: 'actor-a' } },
		] : []);
		const headers = { authorization: 'Bearer user-token' };
		await fastify.inject({ method: 'PATCH', url: '/api/v2/notifications/policy', headers, payload: { for_not_following: 'filter' } });

		const list = await fastify.inject({ method: 'GET', url: '/api/v1/notifications/requests?limit=999&max_id=zzzz', headers });
		expect(list.statusCode).toBe(200);
		expect(list.json()).toEqual([{
			id: expect.any(String),
			created_at: '2026-07-17T10:00:00.000Z',
			updated_at: '2026-07-17T11:00:00.000Z',
			notifications_count: '2',
			account: { id: 'actor-a' },
			last_status: null,
		}]);
		const requestId = list.json()[0].id as string;
		expect(linkHeader).toHaveBeenCalledWith(expect.stringContaining('/api/v1/notifications/requests'), [expect.objectContaining({ id: requestId })]);
		expect((await fastify.inject({ method: 'GET', url: `/api/v1/notifications/requests/${requestId}`, headers })).json()).toEqual(list.json()[0]);
		expect((await fastify.inject({ method: 'GET', url: '/api/v1/notifications/requests/merged', headers })).json()).toEqual({ merged: true });

		const accepted = await fastify.inject({ method: 'POST', url: '/api/v1/notifications/requests/accept', headers, payload: { 'id[]': [requestId] } });
		expect(accepted.json()).toEqual({});
		expect((await fastify.inject({ method: 'GET', url: '/api/v1/notifications/requests', headers })).json()).toEqual([]);
	});

	test('registers Mastodon applications from JSON', async () => {
		const { fastify, registerApplication } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/apps',
			payload: { client_name: 'Elk', redirect_uris: 'https://elk.example/callback', scopes: 'read write' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			client_id: 'client-id', client_secret: 'client-secret',
			vapid_key: 'BFoYnP6n4Huwsti9ptCZtqxxQTT5KpSdGfB8loT2pXzzZYNhOJ4lzcAmndO7ad8LFftUdmUXIZ3Zg-5JSZiu4f0',
		});
		expect(registerApplication).toHaveBeenCalledWith(expect.objectContaining({ client_name: 'Elk' }));
	});

	test('rejects query-string bearer tokens on REST routes', async () => {
		const { fastify, authenticate } = createServer();
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/verify_credentials?access_token=secret' });

		expect(response.statusCode).toBe(401);
		expect(authenticate).not.toHaveBeenCalled();
	});

	test('accepts an application token for app verification', async () => {
		const { fastify, authenticate, getApplication, assert } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
		});
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/apps/verify_credentials',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ vapid_key: 'BFoYnP6n4Huwsti9ptCZtqxxQTT5KpSdGfB8loT2pXzzZYNhOJ4lzcAmndO7ad8LFftUdmUXIZ3Zg-5JSZiu4f0' });
		expect(getApplication).toHaveBeenCalledWith('client-id');
		expect(assert).not.toHaveBeenCalled();
	});

	test('rejects an application token on user-only routes', async () => {
		const { fastify, authenticate } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
		});
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/verify_credentials',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(401);
	});

	test('reads Profile with profile, read, or read:accounts and rejects unrelated scopes', async () => {
		const { fastify, authenticate, assertAny, nativeInvoke } = createServer();
		const scopes = new Map([
			['profile-token', ['profile']],
			['read-token', ['read']],
			['accounts-token', ['read:accounts']],
			['statuses-token', ['read:statuses']],
		]);
		authenticate.mockImplementation(async token => ({
			kind: 'user',
			user: { id: 'user-id' },
			token: { id: 'token-id', scopes: scopes.get(token) ?? [] },
		}));
		const scopeService = new MastodonScopeService();
		assertAny.mockImplementation((tokenScopes, requiredScopes) => scopeService.assertAny(tokenScopes, requiredScopes));
		nativeInvoke.mockImplementation(async name => name === 'i'
			? { id: 'user-id', username: 'alice', name: 'Alice' }
			: []);

		for (const token of ['profile-token', 'read-token', 'accounts-token']) {
			const response = await fastify.inject({
				method: 'GET',
				url: '/api/v1/profile',
				headers: { authorization: `Bearer ${token}` },
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({ id: 'user-id', display_name: 'Alice' });
		}
		const unrelated = await fastify.inject({
			method: 'GET',
			url: '/api/v1/profile',
			headers: { authorization: 'Bearer statuses-token' },
		});

		expect(unrelated.statusCode).toBe(403);
		expect(assertAny).toHaveBeenCalledWith(expect.any(Array), ['profile', 'read:accounts']);
	});

	test('updates Profile from JSON and preserves ordered fields', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => name === 'i'
			? { id: 'user-id', username: 'alice', name: data.name ?? 'Updated Alice' }
			: {});

		const response = await fastify.inject({
			method: 'PATCH',
			url: '/api/v1/profile',
			headers: { authorization: 'Bearer user-token' },
			payload: {
				display_name: 'Updated Alice',
				note: 'Updated bio',
				locked: true,
				discoverable: false,
				bot: true,
				fields_attributes: [
					{ name: 'First', value: 'one' },
					{ name: 'Second', value: 'two' },
				],
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: 'user-id', display_name: 'Updated Alice' });
		expect(nativeInvoke).toHaveBeenCalledWith('i/update', {
			name: 'Updated Alice',
			description: 'Updated bio',
			isLocked: true,
			isExplorable: false,
			isBot: true,
			fields: [
				{ name: 'First', value: 'one' },
				{ name: 'Second', value: 'two' },
			],
		}, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('i', {}, expect.any(Object), expect.any(Object));
	});

	test('updates credential account from URL-encoded bracket fields and accepts matching defaults', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i'
			? { id: 'user-id', username: 'alice' }
			: {});
		const body = new URLSearchParams({
			display_name: 'Alice URL',
			'fields_attributes[1][name]': 'Second',
			'fields_attributes[1][value]': 'two',
			'fields_attributes[0][name]': 'First',
			'fields_attributes[0][value]': 'one',
			'source[privacy]': 'public',
			'source[sensitive]': 'false',
			'source[language]': '',
			avatar_description: '',
			header_description: '',
			hide_collections: 'false',
			indexable: 'false',
			show_media: 'true',
			show_media_replies: 'true',
			show_featured: 'true',
			'attribution_domains[]': '',
		}).toString();

		const response = await fastify.inject({
			method: 'PATCH',
			url: '/api/v1/accounts/update_credentials',
			headers: {
				authorization: 'Bearer user-token',
				'content-type': 'application/x-www-form-urlencoded',
			},
			payload: body,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: 'user-id', username: 'alice' });
		expect(nativeInvoke).toHaveBeenCalledWith('i/update', {
			name: 'Alice URL',
			fields: [
				{ name: 'First', value: 'one' },
				{ name: 'Second', value: 'two' },
			],
		}, expect.any(Object), expect.any(Object));
	});

	test.each([
		[{ source: { privacy: 'private' } }, 'privacy'],
		[{ source: { sensitive: true } }, 'sensitive'],
		[{ source: { language: 'ja' } }, 'language'],
		[{ avatar_description: 'avatar alt' }, 'avatar_description'],
		[{ header_description: 'header alt' }, 'header_description'],
		[{ hide_collections: true }, 'hide_collections'],
		[{ indexable: true }, 'indexable'],
		[{ show_media: false }, 'show_media'],
		[{ show_media_replies: false }, 'show_media_replies'],
		[{ show_featured: false }, 'show_featured'],
		[{ attribution_domains: ['example.com'] }, 'attribution_domains'],
	] as const)('rejects unsupported non-persisted Profile option %s', async (payload, key) => {
		const { fastify, nativeInvoke } = createServer();
		const response = await fastify.inject({
			method: 'PATCH',
			url: '/api/v1/profile',
			headers: { authorization: 'Bearer user-token' },
			payload,
		});

		expect(response.statusCode, key).toBe(422);
		expect(nativeInvoke).not.toHaveBeenCalledWith('i/update', expect.anything(), expect.anything(), expect.anything());
	});

	test.each([
		['avatar', { avatarId: null }],
		['header', { bannerId: null }],
	] as const)('deletes Profile %s through i/update', async (kind, update) => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'i'
			? { id: 'user-id', username: 'alice', name: 'Alice' }
			: {});
		const response = await fastify.inject({
			method: 'DELETE',
			url: `/api/v1/profile/${kind}`,
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('i/update', update, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('i', {}, expect.any(Object), expect.any(Object));
	});

	test('streams two multipart Profile images through Drive before updating the account', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name === 'drive/files/create') return { id: data.name === 'avatar.png' ? 'avatar-file' : 'header-file' };
			if (name === 'i') return { id: 'user-id', username: 'alice', name: 'Alice' };
			return {};
		});
		const boundary = 'mastodon-profile-boundary';
		const payload = [
			`--${boundary}\r\nContent-Disposition: form-data; name="display_name"\r\n\r\nMultipart Alice\r\n`,
			`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\navatar-bytes\r\n`,
			`--${boundary}\r\nContent-Disposition: form-data; name="header"; filename="header.png"\r\nContent-Type: image/png\r\n\r\nheader-bytes\r\n`,
			`--${boundary}--\r\n`,
		].join('');

		const response = await fastify.inject({
			method: 'PATCH',
			url: '/api/v1/profile',
			headers: {
				authorization: 'Bearer user-token',
				'content-type': `multipart/form-data; boundary=${boundary}`,
			},
			payload,
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('drive/files/create', { name: 'avatar.png' }, expect.any(Object), expect.any(Object), expect.objectContaining({ name: 'avatar.png', path: expect.any(String) }));
		expect(nativeInvoke).toHaveBeenCalledWith('drive/files/create', { name: 'header.png' }, expect.any(Object), expect.any(Object), expect.objectContaining({ name: 'header.png', path: expect.any(String) }));
		expect(nativeInvoke).toHaveBeenCalledWith('i/update', {
			name: 'Multipart Alice',
			avatarId: 'avatar-file',
			bannerId: 'header-file',
		}, expect.any(Object), expect.any(Object));
	});

	test('creates a persisted report after resolving every bracketed status ID', async () => {
		const { fastify, nativeInvoke, createReport } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => name === 'notes/show'
			? { id: data.noteId, userId: 'target-id' }
			: []);
		const body = new URLSearchParams();
		body.set('account_id', 'target-id');
		body.set('category', 'violation');
		body.set('forward', 'true');
		for (const id of ['status-1', 'status-2']) body.append('status_ids[]', id);
		body.append('rule_ids[]', 'rule-1');
		body.append('collection_ids[]', 'collection-1');
		body.append('forward_to_domains[]', 'moderation.example');

		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/reports',
			headers: {
				authorization: 'Bearer user-token',
				'content-type': 'application/x-www-form-urlencoded',
			},
			payload: body.toString(),
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ id: 'report-id', category: 'violation', status_ids: ['status-1', 'status-2'] });
		expect(nativeInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'status-1' }, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'status-2' }, expect.any(Object), expect.any(Object));
		expect(createReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-id' }), {
			accountId: 'target-id',
			comment: '',
			category: 'violation',
			statusIds: ['status-1', 'status-2'],
			ruleIds: ['rule-1'],
			collectionIds: ['collection-1'],
			forwardToDomains: ['moderation.example'],
			forward: true,
		});
	});

	test('rejects a report status authored by another account', async () => {
		const { fastify, nativeInvoke, createReport } = createServer();
		nativeInvoke.mockResolvedValueOnce({ id: 'status-1', userId: 'different-user' });

		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/reports',
			headers: { authorization: 'Bearer user-token' },
			payload: { account_id: 'target-id', status_ids: ['status-1'] },
		});

		expect(response.statusCode).toBe(422);
		expect(createReport).not.toHaveBeenCalled();
	});

	test('requires report account_id without invoking persistence', async () => {
		const { fastify, createReport } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/reports',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(400);
		expect(createReport).not.toHaveBeenCalled();
	});

	test('serves public routes anonymously when Authorization is absent', async () => {
		const { fastify, authenticate, nativeInvoke, notesRepository, noteFavoritesRepository, userNotePiningsRepository } = createServer();
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/statuses/note-id' });

		expect(response.statusCode).toBe(200);
		expect(authenticate).not.toHaveBeenCalled();
		expect(nativeInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-id' }, null, expect.any(Object));
		expect(notesRepository.findBy).not.toHaveBeenCalled();
		expect(noteFavoritesRepository.findBy).not.toHaveBeenCalled();
		expect(userNotePiningsRepository.findBy).not.toHaveBeenCalled();
	});

	test('uses a user token and viewer state on public routes', async () => {
		const { fastify, authenticate, assert, nativeInvoke, notesRepository, noteFavoritesRepository, userNotePiningsRepository } = createServer();
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'bEaReR mastodon-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(authenticate).toHaveBeenCalledWith('mastodon-token');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
		expect(nativeInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-id' }, expect.objectContaining({ kind: 'user' }), expect.any(Object));
		expect(notesRepository.findBy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-id' }));
		expect(noteFavoritesRepository.findBy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-id' }));
		expect(userNotePiningsRepository.findBy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-id' }));
	});

	test('treats an application token as anonymous on public routes', async () => {
		const { fastify, authenticate, assert, nativeInvoke, notesRepository } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			user: null,
			token: { id: 'app-token', clientId: 'client-id', scopes: ['read'] },
		});
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-id' }, null, expect.any(Object));
		expect(assert).not.toHaveBeenCalled();
		expect(notesRepository.findBy).not.toHaveBeenCalled();
	});

	test('rejects malformed and invalid Authorization on public routes', async () => {
		const { fastify, authenticate, nativeInvoke } = createServer();
		const malformed = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Basic mastodon-token' },
		});
		expect(malformed.statusCode).toBe(401);
		expect(authenticate).not.toHaveBeenCalled();

		authenticate.mockRejectedValueOnce(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));
		const invalid = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer invalid-token' },
		});

		expect(invalid.statusCode).toBe(401);
		expect(nativeInvoke).not.toHaveBeenCalled();
	});

	test('serves token-authenticated batch accounts and statuses in input order', async () => {
		const { fastify, authenticate, publicInvoke } = createServer();
		const accounts = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts?id[]=user-a&id[]=user-b',
			headers: { authorization: 'Bearer user-token' },
		});
		const statuses = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses?id[]=note-a&id[]=note-b',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(accounts.statusCode).toBe(200);
		expect(accounts.json()).toEqual([
			expect.objectContaining({ id: 'user-a' }),
			expect.objectContaining({ id: 'user-b' }),
		]);
		expect(statuses.statusCode).toBe(200);
		expect(statuses.json()).toEqual([
			expect.objectContaining({ id: 'note-a' }),
			expect.objectContaining({ id: 'note-b' }),
		]);
		expect(authenticate).toHaveBeenCalledWith('user-token');
		expect(publicInvoke).toHaveBeenCalledWith('users/show', { userId: 'user-a' }, expect.objectContaining({ kind: 'user' }), expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-a' }, expect.objectContaining({ kind: 'user' }), expect.any(Object));
	});

	test('fetches batch IDs once while preserving duplicates and omitting inaccessible records', async () => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name !== 'users/show') return [];
			if (data.userId === 'missing') throw new ApiError({
				message: 'No such user.',
				code: 'NO_SUCH_USER',
				id: 'missing-user',
				httpStatusCode: 404,
			});
			if (data.userId === 'hidden') throw new ApiError({
				message: 'Content restricted.',
				code: 'CONTENT_RESTRICTED_BY_USER',
				id: 'hidden-user',
			});
			return { id: data.userId, username: data.userId };
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts?id[]=user-a&id[]=missing&id[]=hidden&id[]=user-a&id[]=user-b',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([
			expect.objectContaining({ id: 'user-a' }),
			expect.objectContaining({ id: 'user-a' }),
			expect.objectContaining({ id: 'user-b' }),
		]);
		expect(publicInvoke).toHaveBeenCalledTimes(4);
	});

	test('caps the original batch sequence at 40 positions before de-duplicating fetches', async () => {
		const { fastify, publicInvoke } = createServer();
		const cappedIds = ['user-a', 'user-a', ...Array.from({ length: 38 }, (_, index) => `user-${index}`)];
		const ids = [...cappedIds, 'outside-cap'];
		const query = ids.map(id => `id[]=${id}`).join('&');

		const response = await fastify.inject({
			method: 'GET',
			url: `/api/v1/accounts?${query}`,
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json().map((account: { id: string }) => account.id)).toEqual(cappedIds);
		expect(publicInvoke).toHaveBeenCalledTimes(39);
		expect(publicInvoke).not.toHaveBeenCalledWith('users/show', { userId: 'outside-cap' }, expect.anything(), expect.anything());
	});

	test.each([500, 429])('rethrows %i failures from batch requests', async statusCode => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockRejectedValue(new MastodonApiError(statusCode, 'server_error', 'Failure'));

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/statuses?id[]=note-a&id[]=note-b',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(statusCode);
	});

	test('searches accounts with the authenticated native endpoint mapping', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockResolvedValueOnce([{ id: 'user-a', username: 'alice' }]);
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/search?q=alice&limit=5',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([expect.objectContaining({ id: 'user-a', username: 'alice' })]);
		expect(nativeInvoke).toHaveBeenCalledWith('users/search', {
			query: 'alice',
			limit: 5,
			offset: 0,
		}, expect.any(Object), expect.any(Object));
	});

	test.each([
		['accounts', 'users/search'],
		['statuses', 'notes/search'],
		['hashtags', 'hashtags/search'],
	] as const)('dispatches Mastodon search type=%s only to %s and keeps a stable result envelope', async (type, endpoint) => {
		const { fastify, authenticate, nativeInvoke, publicInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => {
			if (name === 'users/search') return [{ id: 'user-a', username: 'alice' }];
			if (name === 'notes/search') return [{ id: 'note-a' }];
			if (name === 'hashtags/search') return ['Fediverse'];
			return [];
		});

		const response = await fastify.inject({ method: 'GET', url: `/api/v2/search?q=fediverse&type=${type}` });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			accounts: type === 'accounts' ? [{ id: 'user-a', username: 'alice' }] : [],
			statuses: type === 'statuses' ? [expect.objectContaining({ id: 'note-a' })] : [],
			hashtags: type === 'hashtags' ? [{ id: 'fediverse', name: 'Fediverse', url: 'https://misskey.example/tags/Fediverse', history: [] }] : [],
		});
		expect(authenticate).not.toHaveBeenCalled();
		expect(publicInvoke).toHaveBeenCalledTimes(1);
		expect(publicInvoke).toHaveBeenCalledWith(endpoint, expect.any(Object), null, expect.any(Object));
	});

	test('dispatches an untyped public search to all compatible native searches', async () => {
		const { fastify, authenticate, publicInvoke } = createServer();

		const response = await fastify.inject({ method: 'GET', url: '/api/v2/search?q=fediverse' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ accounts: [], statuses: [], hashtags: [] });
		expect(authenticate).not.toHaveBeenCalled();
		expect(publicInvoke).toHaveBeenCalledTimes(3);
		expect(publicInvoke).toHaveBeenCalledWith('users/search', expect.any(Object), null, expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('notes/search', expect.any(Object), null, expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('hashtags/search', expect.any(Object), null, expect.any(Object));
	});

	test('rejects an invalid Mastodon search type before dispatch', async () => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();

		const response = await fastify.inject({ method: 'GET', url: '/api/v2/search?q=fediverse&type=invalid' });

		expect(response.statusCode).toBe(400);
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('translates Mastodon search filters while ignoring offset for an untyped search after authentication', async () => {
		const { fastify, publicInvoke } = createServer();

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse&account_id=user-a&max_id=older&min_id=newer&limit=39&offset=7',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(publicInvoke).toHaveBeenCalledWith('users/search', {
			query: 'fediverse',
			limit: 39,
			offset: 0,
		}, expect.any(Object), expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('notes/search', {
			query: 'fediverse',
			limit: 39,
			userId: 'user-a',
			untilId: 'older',
			sinceId: 'newer',
		}, expect.any(Object), expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('hashtags/search', {
			query: 'fediverse',
			limit: 39,
			offset: 0,
		}, expect.any(Object), expect.any(Object));
	});

	test.each([
		['accounts', 'users/search'],
		['hashtags', 'hashtags/search'],
	] as const)('passes offset to the native %s search when following is false', async (type, endpoint) => {
		const { fastify, publicInvoke } = createServer();

		const response = await fastify.inject({
			method: 'GET',
			url: `/api/v2/search?q=fediverse&type=${type}&limit=3&offset=7`,
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(publicInvoke).toHaveBeenCalledWith(endpoint, {
			query: 'fediverse',
			limit: 3,
			offset: 7,
		}, expect.any(Object), expect.any(Object));
	});

	test('requires a user token for following-only account search', async () => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();

		const response = await fastify.inject({ method: 'GET', url: '/api/v2/search?q=fediverse&type=accounts&following=true' });

		expect(response.statusCode).toBe(401);
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('rejects an application token for following-only account search', async () => {
		const { fastify, authenticate, nativeInvoke, publicInvoke } = createServer();
		authenticate.mockResolvedValue({ kind: 'application', token: { id: 'app-token', scopes: ['read'] } });

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse&type=accounts&following=true',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(401);
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('requires the read:search scope for following-only account search', async () => {
		const { fastify, assert, nativeInvoke, publicInvoke } = createServer();
		assert.mockImplementation(() => {
			throw new MastodonApiError(403, 'insufficient_scope', 'Scope read:search is required');
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse&type=accounts&following=true',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(403);
		expect(assert).toHaveBeenCalledWith(['read'], 'read:search');
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('filters a bounded detailed account search to followed users before applying offset and limit', async () => {
		const { fastify, assert, nativeInvoke, publicInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'users/search' ? [
			{ id: 'followed-0', username: 'followed0', isFollowing: true },
			{ id: 'unfollowed', username: 'unfollowed', isFollowing: false },
			{ id: 'followed-1', username: 'followed1', isFollowing: true },
			{ id: 'followed-2', username: 'followed2', isFollowing: true },
		] : []);

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse&type=accounts&following=true&offset=1&limit=2',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			accounts: [
				{ id: 'followed-1', username: 'followed1' },
				{ id: 'followed-2', username: 'followed2' },
			],
			statuses: [],
			hashtags: [],
		});
		expect(assert).toHaveBeenCalledWith(['read'], 'read:search');
		expect(publicInvoke).toHaveBeenCalledWith('users/search', {
			query: 'fediverse',
			limit: 100,
			offset: 0,
			detail: true,
		}, expect.any(Object), expect.any(Object));
	});

	test('keeps following authentication semantic when accounts are excluded without filtering statuses', async () => {
		const { fastify, assert, nativeInvoke, publicInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'notes/search' ? [{ id: 'note-a' }] : []);

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse&type=statuses&following=true',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ accounts: [], statuses: [expect.objectContaining({ id: 'note-a' })], hashtags: [] });
		expect(assert).toHaveBeenCalledWith(['read'], 'read:search');
		expect(publicInvoke).toHaveBeenCalledWith('notes/search', { query: 'fediverse', limit: 20 }, expect.any(Object), expect.any(Object));
		expect(publicInvoke).not.toHaveBeenCalledWith('users/search', expect.anything(), expect.anything(), expect.anything());
	});

	test.each([
		'',
		'&type=hashtags',
	])('rejects exclude_unreviewed for hashtag results before native dispatch: %s', async typeQuery => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();

		const response = await fastify.inject({
			method: 'GET',
			url: `/api/v2/search?q=fediverse&exclude_unreviewed=true${typeQuery}`,
		});

		expect(response.statusCode).toBe(422);
		expect(response.json()).toEqual({ error: 'exclude_unreviewed is not supported for hashtag searches' });
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test.each([
		['accounts', 'users/search'],
		['statuses', 'notes/search'],
	] as const)('ignores exclude_unreviewed when type=%s excludes hashtag results', async (type, endpoint) => {
		const { fastify, publicInvoke } = createServer();

		const response = await fastify.inject({ method: 'GET', url: `/api/v2/search?q=fediverse&exclude_unreviewed=true&type=${type}` });

		expect(response.statusCode).toBe(200);
		expect(publicInvoke).toHaveBeenCalledWith(endpoint, expect.any(Object), null, expect.any(Object));
	});

	test('applies status offset locally after requesting the bounded native result window', async () => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => name === 'notes/search'
			? Array.from({ length: data.limit as number }, (_, index) => ({ id: `note-${index}` }))
			: []);

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse&type=statuses&account_id=user-a&max_id=older&min_id=newer&offset=2&limit=2',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			accounts: [],
			statuses: [expect.objectContaining({ id: 'note-2' }), expect.objectContaining({ id: 'note-3' })],
			hashtags: [],
		});
		expect(publicInvoke).toHaveBeenCalledWith('notes/search', {
			query: 'fediverse',
			limit: 4,
			userId: 'user-a',
			untilId: 'older',
			sinceId: 'newer',
		}, expect.any(Object), expect.any(Object));
	});

	test.each([
		'/api/v2/search?q=fediverse&type=statuses&offset=61&limit=40',
		'/api/v2/search?q=fediverse&type=accounts&following=true&offset=61&limit=40',
	])('rejects a bounded local search window larger than 100 before native dispatch: %s', async url => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();

		const response = await fastify.inject({
			method: 'GET',
			url,
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(422);
		expect(response.json()).toEqual({ error: 'The requested search window exceeds 100 results' });
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test.each([
		'/api/v2/search?q=fediverse',
		'/api/v2/search?q=fediverse&resolve=false',
	])('allows public Mastodon search without user-only parameters: %s', async url => {
		const { fastify, authenticate } = createServer();

		const response = await fastify.inject({ method: 'GET', url });

		expect(response.statusCode).toBe(200);
		expect(authenticate).not.toHaveBeenCalled();
	});

	test.each([
		'/api/v2/search?q=https%3A%2F%2Fremote.example%2Fnotes%2F1&resolve=true',
		'/api/v2/search?q=fediverse&offset=0',
		'/api/v2/search?q=fediverse&offset=7',
	])('requires a user token for user-only Mastodon search parameters: %s', async url => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();

		const response = await fastify.inject({ method: 'GET', url });

		expect(response.statusCode).toBe(401);
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('checks the mapped read:search scope for user-authenticated search', async () => {
		const { fastify, assert, nativeInvoke, publicInvoke } = createServer();
		assert.mockImplementation(() => {
			throw new MastodonApiError(403, 'insufficient_scope', 'Scope read:search is required');
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse&offset=0',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(403);
		expect(assert).toHaveBeenCalledWith(['read'], 'read:search');
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('does not accept an application token for a resolve search', async () => {
		const { fastify, authenticate, nativeInvoke } = createServer();
		authenticate.mockResolvedValue({ kind: 'application', token: { id: 'app-token', scopes: ['read'] } });

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=https%3A%2F%2Fremote.example%2Fnotes%2F1&resolve=true',
			headers: { authorization: 'Bearer app-token' },
		});

		expect(response.statusCode).toBe(401);
		expect(nativeInvoke).not.toHaveBeenCalled();
	});

	test('rejects an explicitly invalid bearer token for an otherwise-public search', async () => {
		const { fastify, authenticate, nativeInvoke, publicInvoke } = createServer();
		authenticate.mockRejectedValue(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse',
			headers: { authorization: 'Bearer invalid-token' },
		});

		expect(response.statusCode).toBe(401);
		expect(authenticate).toHaveBeenCalledWith('invalid-token');
		expect(nativeInvoke).not.toHaveBeenCalled();
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test.each([
		['statuses', { type: 'Note', object: { id: 'resolved-note' } }, { accounts: [], statuses: [expect.objectContaining({ id: 'resolved-note' })], hashtags: [] }],
		['accounts', { type: 'User', object: { id: 'resolved-user', username: 'alice' } }, { accounts: [{ id: 'resolved-user', username: 'alice' }], statuses: [], hashtags: [] }],
	] as const)('resolves an HTTP URL to the matching Mastodon search type %s', async (type, resolved, expected) => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockResolvedValue(resolved);

		const response = await fastify.inject({
			method: 'GET',
			url: `/api/v2/search?q=https%3A%2F%2Fremote.example%2Fobjects%2F1&resolve=true&type=${type}`,
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual(expected);
		expect(nativeInvoke).toHaveBeenCalledWith('ap/show', { uri: 'https://remote.example/objects/1' }, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledTimes(1);
	});

	test.each([
		['accounts', { type: 'Note', object: { id: 'resolved-note' } }],
		['statuses', { type: 'User', object: { id: 'resolved-user', username: 'alice' } }],
	] as const)('does not leak a resolved object through the incompatible Mastodon search type %s', async (type, resolved) => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockResolvedValue(resolved);

		const response = await fastify.inject({
			method: 'GET',
			url: `/api/v2/search?q=https%3A%2F%2Fremote.example%2Fobjects%2F1&resolve=true&type=${type}`,
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ accounts: [], statuses: [], hashtags: [] });
	});

	test.each(['NO_SUCH_OBJECT', 'REQUEST_FAILED'])('treats the safe ap/show resolver miss %s as an empty search result', async code => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockRejectedValue(new ApiError({ message: 'Resolver miss.', code, id: `resolver-${code}` }));

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=https%3A%2F%2Fremote.example%2Fobjects%2Fmissing&resolve=true',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ accounts: [], statuses: [], hashtags: [] });
	});

	test('propagates unexpected ap/show resolver errors', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockRejectedValue(new ApiError({ message: 'Resolver broke.', code: 'INTERNAL_ERROR', id: 'resolver-broke', kind: 'server' }));

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=https%3A%2F%2Fremote.example%2Fobjects%2F1&resolve=true',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(500);
	});

	test('never invokes ap/show for a non-HTTP query even when resolution is requested', async () => {
		const { fastify, nativeInvoke } = createServer();

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/search?q=fediverse&resolve=true&type=statuses',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/search', expect.any(Object), expect.any(Object), expect.any(Object));
		expect(nativeInvoke).not.toHaveBeenCalledWith('ap/show', expect.anything(), expect.anything(), expect.anything());
	});

	test('propagates native search failures instead of replacing them with an empty array', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockRejectedValue(new ApiError({ message: 'Search unavailable.', code: 'UNAVAILABLE', id: 'search-unavailable', kind: 'server' }));

		const response = await fastify.inject({ method: 'GET', url: '/api/v2/search?q=fediverse&type=statuses' });

		expect(response.statusCode).toBe(500);
	});

	test('retrieves a poll publicly through its note', async () => {
		const { fastify, authenticate, publicInvoke } = createServer();
		const response = await fastify.inject({ method: 'GET', url: '/api/v1/polls/note-with-poll' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ id: 'note-with-poll', votes_count: 2 });
		expect(authenticate).not.toHaveBeenCalled();
		expect(publicInvoke).toHaveBeenCalledWith('notes/show', { noteId: 'note-with-poll' }, null, expect.any(Object));
	});

	test('deletes media with a user token', async () => {
		const { fastify, assert, nativeInvoke } = createServer();
		const response = await fastify.inject({
			method: 'DELETE',
			url: '/api/v1/media/file-id',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({});
		expect(assert).toHaveBeenCalledWith(['read'], 'write:media');
		expect(nativeInvoke).toHaveBeenCalledWith('drive/files/delete', { fileId: 'file-id' }, expect.any(Object), expect.any(Object));
	});

	test('maps public account status media and pinned filters', async () => {
		const { fastify, nativeInvoke, publicInvoke } = createServer();
		const media = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?only_media=true' });

		expect(media.statusCode).toBe(200);
		expect(publicInvoke).toHaveBeenCalledWith('users/notes', expect.objectContaining({
			userId: 'user-id',
			withReplies: true,
			withRenotes: true,
		}), null, expect.any(Object));
		expect(publicInvoke).not.toHaveBeenCalledWith('users/notes', expect.objectContaining({ withReplies: true, withFiles: true }), null, expect.any(Object));

		publicInvoke.mockClear();
		nativeInvoke.mockResolvedValueOnce({
			id: 'user-id',
			username: 'alice',
			pinnedNotes: [{ id: 'pinned-a' }, { id: 'pinned-b' }],
		});
		const pinned = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?pinned=true' });

		expect(pinned.statusCode).toBe(200);
		expect(pinned.json()).toEqual([
			expect.objectContaining({ id: 'pinned-a' }),
			expect.objectContaining({ id: 'pinned-b' }),
		]);
		expect(publicInvoke).toHaveBeenCalledWith('users/show', { userId: 'user-id' }, null, expect.any(Object));
		expect(publicInvoke).not.toHaveBeenCalledWith('users/notes', expect.anything(), expect.anything(), expect.anything());
	});

	test('composes media, reply, and reblog filters without the rejected native combination', async () => {
		const { fastify, publicInvoke } = createServer();
		publicInvoke.mockImplementation(async (name, data) => {
			if (name !== 'users/notes') return [];
			if (data.withReplies === true && data.withFiles === true) {
				throw new ApiError({
					message: 'Specifying both withReplies and withFiles is not supported',
					code: 'BOTH_WITH_REPLIES_AND_WITH_FILES',
					id: '91c8cb9f-36ed-46e7-9ca2-7df96ed6e222',
				});
			}
			return [
				{ id: 'media-reply', replyId: 'parent', renoteId: null, files: [{ id: 'file-a' }] },
				{ id: 'media-status', replyId: null, renoteId: null, files: [{ id: 'file-b' }] },
				{ id: 'text-status', replyId: null, renoteId: null, files: [] },
			];
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/user-id/statuses?only_media=true',
		});

		expect(response.statusCode).toBe(200);
		expect(response.json().map((status: { id: string }) => status.id)).toEqual(['media-reply', 'media-status']);
		expect(publicInvoke).toHaveBeenCalledWith('users/notes', expect.objectContaining({
			userId: 'user-id',
			withReplies: true,
			withRenotes: true,
		}), null, expect.any(Object));
		expect(publicInvoke).not.toHaveBeenCalledWith('users/notes', expect.objectContaining({ withReplies: true, withFiles: true }), null, expect.any(Object));
	});

	test('keeps the native account-status cursor when a media filter empties the converted page', async () => {
		const { fastify, publicInvoke, linkHeader } = createServer();
		const nativePage = [{ id: 'text-status', replyId: null, renoteId: null, files: [] }];
		publicInvoke.mockResolvedValueOnce(nativePage);

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/user-id/statuses?only_media=true',
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual([]);
		expect(response.headers.link).toBe('<next>; rel="next"');
		expect(linkHeader).toHaveBeenCalledWith('https://misskey.example/api/v1/accounts/user-id/statuses?only_media=true', nativePage);
	});

	test('applies media, reply, and reblog filters to pinned statuses', async () => {
		const { fastify, nativeInvoke } = createServer();
		const pinnedNotes = [
			{ id: 'media-reply', replyId: 'parent', renoteId: null, renote: null, files: [{ id: 'file-a' }] },
			{ id: 'media-renote', replyId: null, renoteId: 'original', renote: { id: 'original' }, text: null, cw: null, files: [], poll: null },
			{ id: 'text-status', replyId: null, renoteId: null, renote: null, files: [] },
			{ id: 'media-status', replyId: null, renoteId: null, renote: null, files: [{ id: 'file-c' }] },
		];
		nativeInvoke.mockImplementation(async name => name === 'users/show'
			? { id: 'user-id', username: 'alice', pinnedNotes }
			: []);

		const media = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?pinned=true&only_media=true' });
		const noReplies = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?pinned=true&exclude_replies=true' });
		const noReblogs = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?pinned=true&exclude_reblogs=true' });

		expect(media.statusCode).toBe(200);
		expect(media.json().map((status: { id: string }) => status.id)).toEqual(['media-reply', 'media-status']);
		expect(noReplies.json().map((status: { id: string }) => status.id)).toEqual(['media-renote', 'text-status', 'media-status']);
		expect(noReblogs.json().map((status: { id: string }) => status.id)).toEqual(['media-reply', 'text-status', 'media-status']);
	});

	test('characterizes the native users/notes rejection for reply plus file filtering', async () => {
		const endpoint = new UsersNotesEndpoint(
			{ enableFanoutTimeline: false } as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
		);

		await expect(endpoint.exec({
			userId: 'userid',
			withReplies: true,
			withFiles: true,
		}, null, null)).rejects.toMatchObject({ code: 'BOTH_WITH_REPLIES_AND_WITH_FILES' });
	});

	test('maps supported public and hashtag timeline filters', async () => {
		const { fastify, publicInvoke } = createServer();
		const publicTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/public?only_media=true' });
		const plainHashtagTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/tag/fediverse' });
		const hashtagTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/tag/fediverse?only_media=true&local=true' });

		expect(publicTimeline.statusCode).toBe(200);
		expect(plainHashtagTimeline.statusCode).toBe(200);
		expect(hashtagTimeline.statusCode).toBe(200);
		expect(publicInvoke).toHaveBeenCalledWith('notes/global-timeline', expect.objectContaining({ withFiles: true }), null, expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('notes/search-by-tag', {
			limit: 20,
			tag: 'fediverse',
			withFiles: false,
			localHostOnly: false,
		}, null, expect.any(Object));
		expect(publicInvoke).toHaveBeenCalledWith('notes/search-by-tag', expect.objectContaining({
			tag: 'fediverse',
			withFiles: true,
			localHostOnly: true,
		}), null, expect.any(Object));
	});

	test.each([
		['mixed any aliases', 'any%5B%5D=&any=activitypub'],
		['plain all key', 'all=activitypub'],
		['repeated none[] values', 'none%5B%5D=activitypub&none%5B%5D=fediverse'],
	])('rejects unsupported non-empty %s before native hashtag timeline invocation', async (_case, query) => {
		const { fastify, publicInvoke } = createServer();
		const response = await fastify.inject({
			method: 'GET',
			url: `/api/v1/timelines/tag/fediverse?${query}`,
		});

		expect(response.statusCode).toBe(422);
		expect(response.json()).toEqual({ error: 'Compound tag filters are not supported' });
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('accepts empty and whitespace-only compound hashtag filters', async () => {
		const { fastify, publicInvoke } = createServer();
		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/timelines/tag/fediverse?any%5B%5D=&any=%20%20&all=&none%5B%5D=%20',
		});

		expect(response.statusCode).toBe(200);
		expect(publicInvoke).toHaveBeenCalledWith('notes/search-by-tag', expect.objectContaining({
			tag: 'fediverse',
		}), null, expect.any(Object));
	});

	test('rejects unsupported remote-only public and hashtag timelines', async () => {
		const { fastify, publicInvoke } = createServer();
		const publicTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/public?remote=true' });
		const hashtagTimeline = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/tag/fediverse?remote=true' });

		expect(publicTimeline.statusCode).toBe(422);
		expect(hashtagTimeline.statusCode).toBe(422);
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('creates scheduled statuses without creating a native note', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => name === 'notes/drafts/create'
			? { createdDraft: { id: 'draft-id', isActuallyScheduled: true, scheduledAt: data.scheduledAt } }
			: []);
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
			payload: { status: 'later', scheduled_at: '2099-01-01T00:00:00.000Z' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/drafts/create', expect.objectContaining({
			isActuallyScheduled: true,
		}), expect.anything(), expect.anything());
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/create', expect.anything(), expect.anything(), expect.anything());
	});

	test.each([
		{
			name: 'an array from repeated JSON fields',
			headers: { 'content-type': 'application/json' },
			payload: { status: 'later', scheduled_at: ['', '2099-01-01T00:00:00.000Z'] },
		},
		{
			name: 'an invalid null value',
			headers: { 'content-type': 'application/json' },
			payload: { status: 'later', scheduled_at: null },
		},
		{
			name: 'repeated form fields',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			payload: 'status=later&scheduled_at=&scheduled_at=2099-01-01T00%3A00%3A00.000Z',
		},
	])('rejects scheduled_at represented as $name before idempotency or note creation', async ({ headers, payload }) => {
		const { fastify, nativeInvoke, redis } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token', 'idempotency-key': 'schedule-test', ...headers },
			payload,
		});

		expect(response.statusCode).toBe(400);
		expect(redis.get).not.toHaveBeenCalled();
		expect(redis.set).not.toHaveBeenCalled();
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/create', expect.anything(), expect.anything(), expect.anything());
	});

	test('treats an explicitly empty scalar scheduled_at as unscheduled', async () => {
		const { fastify, nativeInvoke } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
			payload: { status: 'now', scheduled_at: '' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/create', expect.anything(), expect.anything(), expect.anything());
	});

	test('returns deleted status text while preserving media attachments and poll', async () => {
		const { fastify, nativeInvoke } = createServer();
		const media = [{ id: 'file-id' }];
		const poll = { choices: [{ text: 'A', votes: 1 }] };
		nativeInvoke.mockImplementation(async name => name === 'notes/show'
			? { id: 'note-id', text: 'plain text', files: media, poll }
			: undefined);
		const response = await fastify.inject({
			method: 'DELETE',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			id: 'note-id',
			text: 'plain text',
			media_attachments: media,
			poll,
		});
	});

	test('rejects unknown and recipient-less direct visibility instead of publishing publicly', async () => {
		const { fastify, nativeInvoke } = createServer();
		const headers = { authorization: 'Bearer mastodon-token', 'content-type': 'application/json' };
		const unknown = await fastify.inject({ method: 'POST', url: '/api/v1/statuses', headers, payload: { status: 'private', visibility: 'friends' } });
		const direct = await fastify.inject({ method: 'POST', url: '/api/v1/statuses', headers, payload: { status: 'secret', visibility: 'direct' } });

		expect(unknown.statusCode).toBe(422);
		expect(direct.statusCode).toBe(422);
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/create', expect.anything(), expect.anything(), expect.anything());
	});

	test('maps account status filters and media sensitivity to native parameters', async () => {
		const { fastify, nativeInvoke } = createServer();
		const headers = { authorization: 'Bearer mastodon-token' };
		await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/statuses?exclude_replies=true&exclude_reblogs=true', headers });
		await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses',
			headers: { ...headers, 'content-type': 'application/json' },
			payload: { status: 'sensitive', visibility: 'private', sensitive: true, media_ids: ['file-id'] },
		});

		expect(nativeInvoke).toHaveBeenCalledWith('users/notes', expect.objectContaining({ withReplies: false, withRenotes: false }), expect.anything(), expect.anything());
		expect(nativeInvoke).toHaveBeenCalledWith('drive/files/update', { fileId: 'file-id', isSensitive: true }, expect.anything(), expect.anything());
		expect(nativeInvoke).toHaveBeenCalledWith('notes/create', expect.objectContaining({ visibility: 'followers', fileIds: ['file-id'] }), expect.anything(), expect.anything());
	});

	test('preserves attachments on text-only edits and never clears file sensitivity', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => {
			if (name === 'notes/show') return { id: 'note-id', text: 'old', fileIds: ['existing-file'] };
			if (name === 'notes/update') return { updatedNote: { id: 'note-id' } };
			return [];
		});
		const response = await fastify.inject({
			method: 'PUT',
			url: '/api/v1/statuses/note-id',
			headers: { authorization: 'Bearer mastodon-token', 'content-type': 'application/json' },
			payload: { status: 'edited', sensitive: false },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/update', expect.objectContaining({ fileIds: ['existing-file'], text: 'edited' }), expect.anything(), expect.anything());
		expect(nativeInvoke).not.toHaveBeenCalledWith('drive/files/update', expect.anything(), expect.anything(), expect.anything());
	});

	test('orders thread ancestors from root to immediate parent', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'notes/conversation'
			? [{ id: 'parent' }, { id: 'root' }]
			: name === 'notes/children'
				? []
				: []);
		const response = await fastify.inject({
			method: 'GET', url: '/api/v1/statuses/note-id/context', headers: { authorization: 'Bearer mastodon-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json().ancestors).toEqual([
			expect.objectContaining({ id: 'root' }),
			expect.objectContaining({ id: 'parent' }),
		]);
	});

	test('unreblogs only pure renotes and preserves quote posts', async () => {
		const { fastify, nativeInvoke, notesRepository } = createServer();
		notesRepository.findBy.mockResolvedValue([
			{ id: 'quote-id', text: 'my quote', cw: null, fileIds: [], hasPoll: false, replyId: null, renoteId: 'target-id' },
			{ id: 'pure-id', text: null, cw: null, fileIds: [], hasPoll: false, replyId: null, renoteId: 'target-id' },
		]);
		nativeInvoke.mockImplementation(async name => name === 'notes/show' ? { id: 'target-id' } : undefined);
		const response = await fastify.inject({
			method: 'POST', url: '/api/v1/statuses/target-id/unreblog', headers: { authorization: 'Bearer mastodon-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/delete', { noteId: 'pure-id' }, expect.anything(), expect.anything());
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/delete', { noteId: 'quote-id' }, expect.anything(), expect.anything());
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/unrenote', expect.anything(), expect.anything(), expect.anything());
	});

	test('rate limits dynamic application registration', async () => {
		const { fastify, registerApplication, redis } = createServer();
		redis.incr.mockResolvedValue(61);
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/apps',
			payload: { client_name: 'Elk', redirect_uris: 'https://elk.example/callback' },
		});

		expect(response.statusCode).toBe(429);
		expect(registerApplication).not.toHaveBeenCalled();
	});

	test('publishes truthful Mastodon instance discovery without authentication', async () => {
		const { fastify, authenticate } = createServer();
		const v1 = await fastify.inject({ method: 'GET', url: '/api/v1/instance' });
		const v2 = await fastify.inject({ method: 'GET', url: '/api/v2/instance' });

		expect(v1.statusCode).toBe(200);
		expect(v1.json()).toMatchObject({
			version: '4.6.0 (compatible; Misskey 2026.7.0)',
			thumbnail: 'https://misskey.example/favicon.ico',
			rules: [{ id: '1', text: 'Be kind', hint: '' }],
		});
		expect(v2.statusCode).toBe(200);
		expect(v2.json()).toMatchObject({
			domain: 'misskey.example',
			title: 'Misskey Test',
			version: '4.6.0 (compatible; Misskey 2026.7.0)',
			api_versions: { mastodon: 11 },
			thumbnail: { url: 'https://misskey.example/favicon.ico' },
			configuration: {
				accounts: { max_pinned_statuses: 5 },
				urls: { streaming: 'wss://misskey.example/api/v1/streaming' },
				vapid: { public_key: 'BFoYnP6n4Huwsti9ptCZtqxxQTT5KpSdGfB8loT2pXzzZYNhOJ4lzcAmndO7ad8LFftUdmUXIZ3Zg-5JSZiu4f0' },
			},
			rules: [{ id: '1', text: 'Be kind', hint: '' }],
		});
		expect(authenticate).not.toHaveBeenCalled();
	});

	test('uses the instance icon as the discovery image when no banner is configured', async () => {
		const { fastify } = createServer({
			bannerUrl: null,
			iconUrl: 'https://misskey.example/files/icon.png',
		});
		const v1 = await fastify.inject({ method: 'GET', url: '/api/v1/instance' });
		const v2 = await fastify.inject({ method: 'GET', url: '/api/v2/instance' });

		expect(v1.json().thumbnail).toBe('https://misskey.example/files/icon.png');
		expect(v2.json().thumbnail.url).toBe('https://misskey.example/files/icon.png');
	});

	test('maps public instance rules and custom emojis from Misskey', async () => {
		const { fastify, authenticate, publicInvoke } = createServer();
		const rules = await fastify.inject({ method: 'GET', url: '/api/v1/instance/rules' });
		const emojis = await fastify.inject({ method: 'GET', url: '/api/v1/custom_emojis' });

		expect(rules.statusCode).toBe(200);
		expect(rules.json()).toEqual([
			{ id: '1', text: 'Be kind', hint: '' },
		]);
		expect(emojis.statusCode).toBe(200);
		expect(emojis.json()).toEqual([
			{
				shortcode: 'blobcat',
				url: 'https://misskey.example/files/blobcat.png',
				static_url: 'https://misskey.example/files/blobcat.png',
				visible_in_picker: true,
				category: 'Animals',
			},
		]);
		expect(authenticate).not.toHaveBeenCalled();
		expect(publicInvoke).toHaveBeenCalledWith('emojis', {}, null, expect.any(Object));
	});

	test.each(['/api/v1/instance/rules', '/api/v1/custom_emojis'])('rejects invalid Authorization on public discovery route %s', async url => {
		const { fastify, authenticate, publicInvoke } = createServer();
		authenticate.mockRejectedValue(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));

		const response = await fastify.inject({
			method: 'GET',
			url,
			headers: { authorization: 'Bearer invalid-token' },
		});

		expect(response.statusCode).toBe(401);
		expect(authenticate).toHaveBeenCalledWith('invalid-token');
		expect(publicInvoke).not.toHaveBeenCalled();
	});

	test('maps status trends with user state and status-specific pagination bounds', async () => {
		const { fastify, assert, nativeInvoke, publicInvoke, offsetLinkHeader } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => name === 'notes/featured'
			? Array.from({ length: data.limit as number }, (_, index) => ({ id: `featured-${index}` }))
			: []);

		const defaultPage = await fastify.inject({
			method: 'GET',
			url: '/api/v1/trends/statuses',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(defaultPage.statusCode).toBe(200);
		expect(defaultPage.json()).toHaveLength(20);
		expect(defaultPage.json()[0]).toMatchObject({
			id: 'featured-0',
			reblogged: false,
			bookmarked: false,
			pinned: false,
		});
		expect(publicInvoke).toHaveBeenCalledWith('notes/featured', { limit: 21 }, expect.objectContaining({ kind: 'user' }), expect.any(Object));
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
		expect(offsetLinkHeader).toHaveBeenCalledWith('https://misskey.example/api/v1/trends/statuses', 0, 20, true);
		expect(defaultPage.headers.link).toBe('<next:20>; rel="next"');

		publicInvoke.mockClear();
		offsetLinkHeader.mockClear();
		const boundedPage = await fastify.inject({ method: 'GET', url: '/api/v1/trends/statuses?limit=999&offset=-5' });

		expect(boundedPage.statusCode).toBe(200);
		expect(boundedPage.json()).toHaveLength(40);
		expect(publicInvoke).toHaveBeenCalledWith('notes/featured', { limit: 41 }, null, expect.any(Object));
		expect(offsetLinkHeader).toHaveBeenCalledWith('https://misskey.example/api/v1/trends/statuses?limit=999&offset=-5', 0, 40, true);
	});

	test('maps tag trends for the current and legacy routes with tag-specific pagination', async () => {
		const { fastify, nativeInvoke, publicInvoke, offsetLinkHeader } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'hashtags/trend'
			? Array.from({ length: 25 }, (_, index) => ({ tag: `tag ${index}`, chart: [index], usersCount: index }))
			: []);

		const legacy = await fastify.inject({ method: 'GET', url: '/api/v1/trends' });
		expect(legacy.statusCode).toBe(200);
		expect(legacy.json()).toHaveLength(10);
		expect(legacy.json()[0]).toEqual({
			id: 'tag 0',
			name: 'tag 0',
			url: 'https://misskey.example/tags/tag%200',
			history: [],
		});
		expect(publicInvoke).toHaveBeenCalledWith('hashtags/trend', {}, null, expect.any(Object));

		const page = await fastify.inject({ method: 'GET', url: '/api/v1/trends/tags?limit=2&offset=1' });
		expect(page.statusCode).toBe(200);
		expect(page.json().map((tag: { name: string }) => tag.name)).toEqual(['tag 1', 'tag 2']);
		expect(page.headers.link).toBe('<next:3>; rel="next", <prev:0>; rel="prev"');
		expect(offsetLinkHeader).toHaveBeenCalledWith('https://misskey.example/api/v1/trends/tags?limit=2&offset=1', 1, 2, true);

		const boundedPage = await fastify.inject({ method: 'GET', url: '/api/v1/trends/tags?limit=999&offset=-5' });
		expect(boundedPage.statusCode).toBe(200);
		expect(boundedPage.json()).toHaveLength(20);
		expect(boundedPage.json().every((tag: { history: unknown[] }) => tag.history.length === 0)).toBe(true);
	});

	test('derives bounded unique HTTP trend links in first-seen order without fetching them', async () => {
		const { fastify, nativeInvoke, publicInvoke, offsetLinkHeader } = createServer();
		const externalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected external fetch'));
		nativeInvoke.mockImplementation(async name => name === 'notes/featured' ? [
			{
				id: 'featured-a',
				text: 'https://first.example/path [Second](https://second.example/article) https://first.example/path [FTP](ftp://files.example/archive) http://%',
			},
			{ id: 'featured-b', text: 'https://third.example/story' },
			{ id: 'featured-c', text: '[Fourth](http://fourth.example/page)' },
		] : []);

		try {
			const response = await fastify.inject({ method: 'GET', url: '/api/v1/trends/links?limit=2&offset=1' });

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual([
				{
					url: 'https://second.example/article',
					title: 'https://second.example/article',
					description: '',
					language: '',
					type: 'link',
					authors: [],
					author_name: '',
					author_url: '',
					provider_name: '',
					provider_url: '',
					html: '',
					width: 0,
					height: 0,
					image: null,
					image_description: '',
					embed_url: '',
					blurhash: null,
					published_at: null,
					history: [],
				},
				expect.objectContaining({ url: 'https://third.example/story', history: [] }),
			]);
			expect(publicInvoke).toHaveBeenCalledWith('notes/featured', { limit: 100 }, null, expect.any(Object));
			expect(offsetLinkHeader).toHaveBeenCalledWith('https://misskey.example/api/v1/trends/links?limit=2&offset=1', 1, 2, true);
			expect(response.headers.link).toBe('<next:3>; rel="next", <prev:0>; rel="prev"');
			expect(externalFetch).not.toHaveBeenCalled();
		} finally {
			externalFetch.mockRestore();
		}
	});

	test('applies link-specific default and maximum limits', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'notes/featured'
			? Array.from({ length: 25 }, (_, index) => ({ id: `featured-${index}`, text: `https://link-${index}.example/` }))
			: []);

		const defaultPage = await fastify.inject({ method: 'GET', url: '/api/v1/trends/links' });
		const boundedPage = await fastify.inject({ method: 'GET', url: '/api/v1/trends/links?limit=999&offset=-5' });

		expect(defaultPage.statusCode).toBe(200);
		expect(defaultPage.json()).toHaveLength(10);
		expect(boundedPage.statusCode).toBe(200);
		expect(boundedPage.json()).toHaveLength(20);
	});

	test('serves all trend routes anonymously', async () => {
		const { fastify, authenticate } = createServer();
		for (const url of ['/api/v1/trends', '/api/v1/trends/tags', '/api/v1/trends/statuses', '/api/v1/trends/links']) {
			const response = await fastify.inject({ method: 'GET', url });
			expect(response.statusCode).toBe(200);
		}
		expect(authenticate).not.toHaveBeenCalled();
	});

	test('requires account read access for bounded Mastodon suggestions and wraps every account', async () => {
		const { fastify, assert, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => name === 'users/recommendation'
			? Array.from({ length: data.limit as number }, (_, index) => ({ id: `account-${index}`, username: `user-${index}` }))
			: []);

		const missingToken = await fastify.inject({ method: 'GET', url: '/api/v2/suggestions' });
		expect(missingToken.statusCode).toBe(401);

		const defaultPage = await fastify.inject({
			method: 'GET',
			url: '/api/v2/suggestions',
			headers: { authorization: 'Bearer user-token' },
		});
		expect(defaultPage.statusCode).toBe(200);
		expect(defaultPage.json()).toHaveLength(40);
		expect(defaultPage.json()[0]).toEqual({
			source: 'global',
			sources: ['most_followed'],
			account: { id: 'account-0', username: 'user-0' },
		});
		expect(nativeInvoke).toHaveBeenCalledWith('users/recommendation', { limit: 40, offset: 0 }, expect.objectContaining({ kind: 'user' }), expect.any(Object));
		expect(assert).toHaveBeenCalledWith(['read'], 'read:accounts');

		nativeInvoke.mockClear();
		const boundedPage = await fastify.inject({
			method: 'GET',
			url: '/api/v2/suggestions?limit=999&offset=-5',
			headers: { authorization: 'Bearer user-token' },
		});
		expect(boundedPage.statusCode).toBe(200);
		expect(boundedPage.json()).toHaveLength(80);
		expect(nativeInvoke).toHaveBeenCalledWith('users/recommendation', { limit: 80, offset: 0 }, expect.any(Object), expect.any(Object));
	});

	test('rejects application tokens for suggestions', async () => {
		const { fastify, authenticate, nativeInvoke } = createServer();
		authenticate.mockResolvedValue({
			kind: 'application',
			token: { id: 'application-token', scopes: ['read'] },
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v2/suggestions',
			headers: { authorization: 'Bearer application-token' },
		});

		expect(response.statusCode).toBe(401);
		expect(nativeInvoke).not.toHaveBeenCalledWith('users/recommendation', expect.anything(), expect.anything(), expect.anything());
	});

	test('maps public tag metadata through hashtags/show and the central tag serializer', async () => {
		const { fastify, authenticate, nativeInvoke, publicInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => name === 'hashtags/show' ? { tag: 'Fediverse News' } : []);

		const response = await fastify.inject({ method: 'GET', url: '/api/v1/tags/fediverse%20news' });

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			id: 'fediverse news',
			name: 'Fediverse News',
			url: 'https://misskey.example/tags/Fediverse%20News',
			history: [],
		});
		expect(authenticate).not.toHaveBeenCalled();
		expect(publicInvoke).toHaveBeenCalledWith('hashtags/show', { tag: 'fediverse news' }, null, expect.any(Object));
	});

	test('validates an explicitly supplied token before reading tag metadata', async () => {
		const { fastify, authenticate, publicInvoke } = createServer();
		authenticate.mockRejectedValue(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/tags/fediverse',
			headers: { authorization: 'Bearer invalid-token' },
		});

		expect(response.statusCode).toBe(401);
		expect(authenticate).toHaveBeenCalledWith('invalid-token');
		expect(publicInvoke).not.toHaveBeenCalledWith('hashtags/show', expect.anything(), expect.anything(), expect.anything());
	});

	test('implements followed-tag CRUD with normalized Tag state and pagination', async () => {
		const { fastify, assert } = createServer();
		const followed = await fastify.inject({
			method: 'POST',
			url: '/api/v1/tags/%EF%BC%ADissKey/follow',
			headers: { authorization: 'Bearer user-token' },
		});
		const repeated = await fastify.inject({
			method: 'POST',
			url: '/api/v1/tags/misskey/follow',
			headers: { authorization: 'Bearer user-token' },
		});
		const listed = await fastify.inject({
			method: 'GET',
			url: '/api/v1/followed_tags?limit=20',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(followed.statusCode).toBe(200);
		expect(followed.json()).toMatchObject({ id: 'misskey', name: 'misskey', following: true, featuring: false });
		expect(repeated.json()).toEqual(followed.json());
		expect(listed.json()).toEqual([followed.json()]);
		expect(listed.headers.link).toBe('<next>; rel="next"');
		expect(assert).toHaveBeenCalledWith(['read'], 'write:follows');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:follows');

		const unfollowed = await fastify.inject({
			method: 'POST',
			url: '/api/v1/tags/MISSKEY/unfollow',
			headers: { authorization: 'Bearer user-token' },
		});
		expect(unfollowed.json()).toMatchObject({ following: false, featuring: false });
	});

	test('uses compatibility pagination defaults without changing the global pagination default', async () => {
		const { fastify, toMisskey } = createServer();
		const headers = { authorization: 'Bearer user-token' };

		await fastify.inject({ method: 'GET', url: '/api/v1/followed_tags', headers });
		expect(toMisskey).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }), 200);
		await fastify.inject({ method: 'GET', url: '/api/v1/domain_blocks', headers });
		expect(toMisskey).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100 }), 200);
		await fastify.inject({ method: 'GET', url: '/api/v1/endorsements', headers });
		expect(toMisskey).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 40 }), 80);
	});

	test('implements featured tags using one visibility-bounded aggregate, suggestions, public account lists, and both feature route styles', async () => {
		const { fastify, nativeInvoke, notesRepository } = createServer();
		notesRepository.query.mockResolvedValue([{ tag: 'art', statusesCount: 2, lastStatusAt: new Date('2026-07-17T03:00:00.000Z') }]);
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name === 'users/show') return { id: data.userId, username: 'alice', url: 'https://misskey.example/@alice' };
			if (name === 'users/notes') return [
				{ id: 'note-2', createdAt: '2026-07-17T03:00:00.000Z', tags: ['Art', 'News'] },
				{ id: 'note-1', createdAt: '2026-07-16T03:00:00.000Z', tags: ['art'] },
			];
			return [];
		});

		const created = await fastify.inject({
			method: 'POST',
			url: '/api/v1/featured_tags',
			headers: { authorization: 'Bearer user-token', 'content-type': 'application/x-www-form-urlencoded' },
			payload: 'name=%EF%BC%A1rt',
		});
		expect(created.statusCode).toBe(200);
		expect(created.json()).toMatchObject({ name: 'art', statuses_count: '2', last_status_at: '2026-07-17' });
		expect(notesRepository.query).toHaveBeenCalledWith(
			expect.stringMatching(/unnest\(note\."tags"\)[\s\S]*note\."visibility" IN \('public', 'home'\)[\s\S]*GROUP BY/u),
			['user-id', ['art']],
		);
		expect(notesRepository.query.mock.calls[0]?.[0]).toContain('note."localOnly" = FALSE');
		expect(notesRepository.query.mock.calls[0]?.[0]).toContain('note."channelId" IS NULL');
		expect(nativeInvoke).not.toHaveBeenCalledWith('users/notes', expect.objectContaining({ userId: 'user-id', limit: 100 }), expect.anything(), expect.anything());

		const own = await fastify.inject({ method: 'GET', url: '/api/v1/featured_tags', headers: { authorization: 'Bearer user-token' } });
		const account = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/featured_tags' });
		const suggestions = await fastify.inject({ method: 'GET', url: '/api/v1/featured_tags/suggestions', headers: { authorization: 'Bearer user-token' } });
		expect(own.json()).toEqual([created.json()]);
		expect(account.json()).toEqual([created.json()]);
		expect(suggestions.json()).toEqual([expect.objectContaining({ name: 'news', following: false, featuring: false })]);

		const featured = await fastify.inject({ method: 'POST', url: '/api/v1/tags/News/feature', headers: { authorization: 'Bearer user-token' } });
		expect(featured.json()).toMatchObject({ name: 'news', featuring: true });
		const unfeatured = await fastify.inject({ method: 'POST', url: '/api/v1/tags/NEWS/unfeature', headers: { authorization: 'Bearer user-token' } });
		expect(unfeatured.json()).toMatchObject({ name: 'news', featuring: false });

		const deleted = await fastify.inject({ method: 'DELETE', url: `/api/v1/featured_tags/${created.json().id}`, headers: { authorization: 'Bearer user-token' } });
		expect(deleted.statusCode).toBe(200);
		expect(deleted.json()).toEqual({});
	});

	test('accepts a valid optional token without read:accounts on public user-feature routes', async () => {
		const { fastify, authenticate, assert } = createServer();
		authenticate.mockResolvedValue({
			kind: 'user',
			user: { id: 'viewer-id' },
			token: { id: 'token-id', scopes: ['write:statuses'] },
		});

		const featured = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/user-id/featured_tags',
			headers: { authorization: 'Bearer limited-token' },
		});
		const endorsements = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/user-id/endorsements',
			headers: { authorization: 'Bearer limited-token' },
		});

		expect(featured.statusCode).toBe(200);
		expect(endorsements.statusCode).toBe(200);
		expect(assert).not.toHaveBeenCalled();
	});

	test('implements endorsement lists and current/deprecated relationship actions', async () => {
		const { fastify } = createServer();
		for (const action of ['endorse', 'pin'] as const) {
			const response = await fastify.inject({ method: 'POST', url: `/api/v1/accounts/target/${action}`, headers: { authorization: 'Bearer user-token' } });
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({ id: 'target', endorsed: true });
		}
		const own = await fastify.inject({ method: 'GET', url: '/api/v1/endorsements', headers: { authorization: 'Bearer user-token' } });
		const account = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/endorsements' });
		const relationships = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/relationships?id[]=target', headers: { authorization: 'Bearer user-token' } });
		expect(own.json()).toEqual([{ id: 'target', username: 'target' }]);
		expect(account.json()).toEqual(own.json());
		expect(relationships.json()).toEqual([expect.objectContaining({ id: 'target', endorsed: true })]);

		for (const action of ['unendorse', 'unpin'] as const) {
			const response = await fastify.inject({ method: 'POST', url: `/api/v1/accounts/target/${action}`, headers: { authorization: 'Bearer user-token' } });
			expect(response.json()).toMatchObject({ id: 'target', endorsed: false });
		}
		for (const target of ['missing-user', 'not-followed']) {
			const response = await fastify.inject({ method: 'POST', url: `/api/v1/accounts/${target}/endorse`, headers: { authorization: 'Bearer user-token' } });
			expect(response.statusCode).toBe(422);
			expect(response.json()).toEqual({ error: 'You can endorse only an account you follow' });
		}
	});

	test('prunes stale endorsements from relationship and public account views', async () => {
		const { fastify, mastodonUserFeatureService, mastodonApiStateService, followedUserIds } = createServer();
		await mastodonUserFeatureService.endorse('user-id', 'target');
		followedUserIds.delete('target');

		const relationships = await fastify.inject({
			method: 'GET',
			url: '/api/v1/accounts/relationships?id[]=target',
			headers: { authorization: 'Bearer user-token' },
		});
		const own = await fastify.inject({ method: 'GET', url: '/api/v1/endorsements', headers: { authorization: 'Bearer user-token' } });
		const account = await fastify.inject({ method: 'GET', url: '/api/v1/accounts/user-id/endorsements' });

		expect(relationships.json()).toEqual([expect.objectContaining({ id: 'target', endorsed: false })]);
		expect(own.json()).toEqual([]);
		expect(account.json()).toEqual([]);
		expect(await mastodonApiStateService.get('user-id', 'endorsement', 'target')).toBeNull();
	});

	test('removes an endorsement immediately after unfollowing through the Mastodon route', async () => {
		const { fastify, mastodonUserFeatureService, mastodonApiStateService, nativeInvoke } = createServer();
		await mastodonUserFeatureService.endorse('user-id', 'target');

		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/accounts/target/unfollow',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(response.statusCode).toBe(200);
		expect(nativeInvoke).toHaveBeenCalledWith('following/delete', { userId: 'target' }, expect.any(Object), expect.any(Object));
		expect(await mastodonApiStateService.get('user-id', 'endorsement', 'target')).toBeNull();
	});

	test('loads up to 80 endorsements in one native batch while preserving state order and omitting unavailable users', async () => {
		const {
			fastify,
			mastodonApiStateService,
			existingUserIds,
			followedUserIds,
			nativeInvoke,
			toMisskey,
			linkHeader,
		} = createServer();
		const ids = Array.from({ length: 82 }, (_, index) => `account-${index.toString().padStart(3, '0')}`);
		for (const id of ids) {
			existingUserIds.add(id);
			followedUserIds.add(id);
			await mastodonApiStateService.put({ userId: 'user-id', kind: 'endorsement', key: id, value: {} });
		}
		toMisskey.mockReturnValueOnce({ limit: 80 });
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name !== 'users/show' || !Array.isArray(data.userIds)) return [];
			return [...data.userIds]
				.reverse()
				.filter(id => id !== 'account-010')
				.map(id => ({ id, username: id }));
		});

		const response = await fastify.inject({
			method: 'GET',
			url: '/api/v1/endorsements?limit=80',
			headers: { authorization: 'Bearer user-token' },
		});
		const expectedIds = ids.slice(0, 80).filter(id => id !== 'account-010');

		expect(response.statusCode).toBe(200);
		expect(response.json().map((account: { id: string }) => account.id)).toEqual(expectedIds);
		expect(nativeInvoke.mock.calls.filter(([name]) => name === 'users/show')).toEqual([[
			'users/show',
			{ userIds: ids.slice(0, 80) },
			expect.any(Object),
			expect.any(Object),
		]]);
		expect(linkHeader).toHaveBeenCalledWith(expect.any(String), ids.slice(0, 80).map(id => expect.objectContaining({ id })));
	});

	test('keeps endorsement cursors reachable when users/show omits an entire state page', async () => {
		const {
			fastify,
			mastodonApiStateService,
			existingUserIds,
			followedUserIds,
			nativeInvoke,
			toMisskey,
			linkHeader,
		} = createServer();
		const ids = ['account-003', 'account-002', 'account-001'];
		for (const id of ids) {
			existingUserIds.add(id);
			followedUserIds.add(id);
			await mastodonApiStateService.put({ userId: 'user-id', kind: 'endorsement', key: id, value: {} });
		}
		toMisskey.mockImplementation((query: Record<string, unknown>) => ({
			limit: 2,
			...(typeof query.max_id === 'string' ? { untilId: query.max_id } : {}),
		}));
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name !== 'users/show' || !Array.isArray(data.userIds)) return [];
			return data.userIds.includes('account-001') ? [{ id: 'account-001', username: 'account-001' }] : [];
		});

		const omitted = await fastify.inject({
			method: 'GET',
			url: '/api/v1/endorsements?limit=2',
			headers: { authorization: 'Bearer user-token' },
		});
		const older = await fastify.inject({
			method: 'GET',
			url: '/api/v1/endorsements?limit=2&max_id=account-002',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(omitted.json()).toEqual([]);
		expect(older.json()).toEqual([{ id: 'account-001', username: 'account-001' }]);
		expect(linkHeader).toHaveBeenNthCalledWith(1, expect.any(String), [{ id: 'account-003' }, { id: 'account-002' }]);
		expect(linkHeader).toHaveBeenNthCalledWith(2, expect.any(String), [{ id: 'account-001' }]);
	});

	test('stores domain blocks as normalized strings on the native profile', async () => {
		const { fastify, profiles, toMisskey, userFeatureCacheService, userFeatureGlobalEventService } = createServer();
		toMisskey.mockImplementation((query: Record<string, unknown>) => ({
			limit: 20,
			...(typeof query.max_id === 'string' ? { untilId: query.max_id } : {}),
			...(typeof query.since_id === 'string' ? { sinceId: query.since_id } : {}),
		}));
		const blocked = await fastify.inject({
			method: 'POST',
			url: '/api/v1/domain_blocks',
			headers: { authorization: 'Bearer user-token', 'content-type': 'application/json' },
			payload: { domain: 'B脺CHER.Example' },
		});
		const listed = await fastify.inject({ method: 'GET', url: '/api/v1/domain_blocks', headers: { authorization: 'Bearer user-token' } });
		const afterCursor = await fastify.inject({ method: 'GET', url: '/api/v1/domain_blocks?since_id=zzzz', headers: { authorization: 'Bearer user-token' } });
		expect(blocked.statusCode).toBe(200);
		expect(blocked.json()).toEqual({});
		expect(listed.json()).toEqual(['xn--bcher-kva.example']);
		expect(afterCursor.json()).toEqual([]);
		expect(profiles.get('user-id')?.mutedInstances).toEqual(['xn--bcher-kva.example']);
		expect(userFeatureCacheService.userProfileCache.delete).toHaveBeenCalledWith('user-id');
		expect(userFeatureGlobalEventService.publishMainStream).toHaveBeenCalledWith('user-id', 'meUpdated', { id: 'user-id' });

		const unblocked = await fastify.inject({
			method: 'DELETE',
			url: '/api/v1/domain_blocks',
			headers: { authorization: 'Bearer user-token', 'content-type': 'application/x-www-form-urlencoded' },
			payload: 'domain=xn--bcher-kva.example',
		});
		expect(unblocked.json()).toEqual({});
	});

	test.each([
		['missing', {}],
		['blank', { domain: '   ' }],
	] as const)('rejects a %s domain block as unprocessable', async (_label, payload) => {
		const { fastify } = createServer();
		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/domain_blocks',
			headers: { authorization: 'Bearer user-token' },
			payload,
		});

		expect(response.statusCode).toBe(422);
	});

	test('sorts domain blocks before applying cursors and builds links from the returned page', async () => {
		const { fastify, profiles, linkHeader, toMisskey } = createServer();
		profiles.get('user-id')!.mutedInstances = ['alpha.example', 'zeta.example', 'middle.example'];
		toMisskey.mockImplementation((query: Record<string, unknown>) => ({
			limit: Number(query.limit),
			...(typeof query.max_id === 'string' ? { untilId: query.max_id } : {}),
		}));

		const first = await fastify.inject({
			method: 'GET',
			url: '/api/v1/domain_blocks?limit=2',
			headers: { authorization: 'Bearer user-token' },
		});
		const next = await fastify.inject({
			method: 'GET',
			url: '/api/v1/domain_blocks?limit=2&max_id=middle.example',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(first.json()).toEqual(['zeta.example', 'middle.example']);
		expect(next.json()).toEqual(['alpha.example']);
		expect(linkHeader).toHaveBeenNthCalledWith(1, expect.any(String), [{ id: 'zeta.example' }, { id: 'middle.example' }]);
		expect(linkHeader).toHaveBeenNthCalledWith(2, expect.any(String), [{ id: 'alpha.example' }]);
	});

	test('mutes accessible status threads directly and returns the requested status override', async () => {
		const { fastify, nativeInvoke, noteThreadMutingsRepository } = createServer();
		const muted = await fastify.inject({ method: 'POST', url: '/api/v1/statuses/reply-note/mute', headers: { authorization: 'Bearer user-token' } });
		const repeated = await fastify.inject({ method: 'POST', url: '/api/v1/statuses/reply-note/mute', headers: { authorization: 'Bearer user-token' } });
		expect(muted.statusCode).toBe(200);
		expect(muted.json()).toMatchObject({ id: 'reply-note', muted: true });
		expect(repeated.statusCode).toBe(200);
		expect(noteThreadMutingsRepository.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT'), [expect.any(String), 'user-id', 'root-note']);

		const unmuted = await fastify.inject({ method: 'POST', url: '/api/v1/statuses/reply-note/unmute', headers: { authorization: 'Bearer user-token' } });
		expect(unmuted.json()).toMatchObject({ id: 'reply-note', muted: false });

		nativeInvoke.mockRejectedValueOnce(new ApiError({ message: 'Hidden', code: 'CONTENT_RESTRICTED_BY_USER', id: 'hidden' }));
		const hidden = await fastify.inject({ method: 'POST', url: '/api/v1/statuses/hidden/mute', headers: { authorization: 'Bearer user-token' } });
		expect(hidden.statusCode).toBe(404);
		expect(noteThreadMutingsRepository.query.mock.calls.filter(([sql]) => (sql as string).includes('INSERT INTO "note_thread_muting"'))).toHaveLength(2);
	});

	test('applies a persisted thread mute to sibling statuses, timelines, and notifications with one lookup per batch', async () => {
		const { fastify, nativeInvoke, noteThreadMutingsRepository } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name === 'notes/show') return { id: data.noteId };
			if (name === 'notes/timeline') return [{ id: 'sibling-note' }, { id: 'other-note' }];
			if (name === 'i/notifications') return [{
				id: 'notification-id',
				type: 'note',
				user: { id: 'target' },
				note: { id: 'sibling-note', text: 'same thread', cw: null, files: [], poll: null, renote: null },
			}];
			return [];
		});
		await fastify.inject({ method: 'POST', url: '/api/v1/statuses/reply-note/mute', headers: { authorization: 'Bearer user-token' } });
		noteThreadMutingsRepository.query.mockClear();

		const status = await fastify.inject({ method: 'GET', url: '/api/v1/statuses/sibling-note', headers: { authorization: 'Bearer user-token' } });
		const home = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/home', headers: { authorization: 'Bearer user-token' } });
		const notifications = await fastify.inject({ method: 'GET', url: '/api/v1/notifications', headers: { authorization: 'Bearer user-token' } });
		const singleNotification = await fastify.inject({ method: 'GET', url: '/api/v1/notifications/notification-id', headers: { authorization: 'Bearer user-token' } });

		expect(status.json()).toMatchObject({ id: 'sibling-note', muted: true });
		expect(home.json()).toEqual([
			expect.objectContaining({ id: 'sibling-note', muted: true }),
			expect.objectContaining({ id: 'other-note', muted: false }),
		]);
		expect(notifications.json()).toEqual([
			expect.objectContaining({ status: expect.objectContaining({ id: 'sibling-note', muted: true }) }),
		]);
		expect(singleNotification.json()).toMatchObject({ status: { id: 'sibling-note', muted: true } });
		const lookups = noteThreadMutingsRepository.query.mock.calls.filter(([sql]) => (sql as string).includes('JOIN "note_thread_muting"'));
		expect(lookups).toHaveLength(4);
		expect(lookups[1]?.[1]).toEqual(['user-id', ['sibling-note', 'other-note']]);
	});

	test('applies persisted thread mute state to every authenticated Status mutation', async () => {
		const { fastify, noteThreadMutingsRepository } = createServer();
		const headers = { authorization: 'Bearer user-token' };
		await fastify.inject({ method: 'POST', url: '/api/v1/statuses/reply-note/mute', headers });
		noteThreadMutingsRepository.query.mockClear();
		const mutations = [
			{ method: 'DELETE', url: '/api/v1/statuses/reply-note' },
			{ method: 'POST', url: '/api/v1/statuses/reply-note/favourite' },
			{ method: 'POST', url: '/api/v1/statuses/reply-note/unfavourite' },
			{ method: 'POST', url: '/api/v1/statuses/reply-note/bookmark' },
			{ method: 'POST', url: '/api/v1/statuses/reply-note/unbookmark' },
			{ method: 'POST', url: '/api/v1/statuses/reply-note/reblog' },
			{ method: 'POST', url: '/api/v1/statuses/reply-note/unreblog' },
			{ method: 'POST', url: '/api/v1/statuses/reply-note/pin' },
			{ method: 'POST', url: '/api/v1/statuses/reply-note/unpin' },
			{ method: 'POST', url: '/api/v1/statuses', payload: { status: 'created status' } },
		] as const;

		for (const mutation of mutations) {
			const response = await fastify.inject({ ...mutation, headers });
			expect(response.statusCode, `${mutation.method} ${mutation.url}`).toBe(200);
			expect(response.json(), `${mutation.method} ${mutation.url}`).toMatchObject({ muted: true });
		}
		const lookups = noteThreadMutingsRepository.query.mock.calls.filter(([sql]) => (sql as string).includes('JOIN "note_thread_muting"'));
		expect(lookups).toHaveLength(mutations.length);
	});

	test('looks up nested reblog and quote mutes once per authenticated batch while anonymous statuses stay false', async () => {
		const { fastify, nativeInvoke, noteThreadMutingsRepository } = createServer();
		const notes = [
			{ id: 'boost-note', text: null, files: [], poll: null, replyId: null, renote: { id: 'sibling-note' } },
			{ id: 'quote-note', text: 'quoted', files: [], poll: null, replyId: null, renote: { id: 'sibling-note' } },
		];
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name === 'notes/show') return { id: data.noteId };
			if (name === 'notes/timeline' || name === 'notes/global-timeline') return notes;
			if (name === 'i/notifications') return [{
				id: 'nested-notification',
				type: 'note',
				user: { id: 'target' },
				note: { id: 'notification-note', text: 'quoted', files: [], poll: null, replyId: null, renote: { id: 'sibling-note' } },
			}];
			return [];
		});
		await fastify.inject({ method: 'POST', url: '/api/v1/statuses/reply-note/mute', headers: { authorization: 'Bearer user-token' } });
		noteThreadMutingsRepository.query.mockClear();

		const authenticated = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/home', headers: { authorization: 'Bearer user-token' } });
		const anonymous = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/public' });
		const notifications = await fastify.inject({ method: 'GET', url: '/api/v1/notifications', headers: { authorization: 'Bearer user-token' } });
		const authenticatedById = new Map(authenticated.json().map((status: { id: string }) => [status.id, status]));
		const anonymousById = new Map(anonymous.json().map((status: { id: string }) => [status.id, status]));

		expect(authenticatedById.get('boost-note')).toMatchObject({ reblog: { id: 'sibling-note', muted: true } });
		expect(authenticatedById.get('quote-note')).toMatchObject({ quote: { quoted_status: { id: 'sibling-note', muted: true } } });
		expect(anonymousById.get('boost-note')).toMatchObject({ reblog: { id: 'sibling-note', muted: false } });
		expect(anonymousById.get('quote-note')).toMatchObject({ quote: { quoted_status: { id: 'sibling-note', muted: false } } });
		expect(notifications.json()[0]).toMatchObject({ status: { quote: { quoted_status: { id: 'sibling-note', muted: true } } } });
		const lookups = noteThreadMutingsRepository.query.mock.calls.filter(([sql]) => (sql as string).includes('JOIN "note_thread_muting"'));
		expect(lookups).toHaveLength(2);
		expect(lookups[0]?.[1]?.[0]).toBe('user-id');
		expect(new Set(lookups[0]?.[1]?.[1] as string[])).toEqual(new Set(['boost-note', 'sibling-note', 'quote-note']));
		expect(lookups[1]?.[1]).toEqual(['user-id', ['notification-note', 'sibling-note']]);
	});

	test('enforces a transport-specific ten-per-hour mute limit without invoking the scope-incompatible native endpoint', async () => {
		const { fastify, redis, noteThreadMutingsRepository, nativeInvoke } = createServer();
		redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(11);
		const first = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses/reply-note/mute',
			headers: { authorization: 'Bearer user-token' },
		});
		noteThreadMutingsRepository.query.mockClear();

		const response = await fastify.inject({
			method: 'POST',
			url: '/api/v1/statuses/reply-note/mute',
			headers: { authorization: 'Bearer user-token' },
		});

		expect(first.statusCode).toBe(200);
		expect(response.statusCode).toBe(429);
		expect(redis.incr).toHaveBeenCalledWith('mastodon-api:thread-mute:user-id');
		expect(redis.expire).toHaveBeenCalledWith(expect.stringContaining('user-id'), 3600);
		expect(noteThreadMutingsRepository.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "note_thread_muting"'), expect.anything());
		expect(nativeInvoke).not.toHaveBeenCalledWith('notes/thread-muting/create', expect.anything(), expect.anything(), expect.anything());
	});

	test('merges followed-tag notes into home once with bounded fan-in, dedupe, and one filter pass', async () => {
		const { fastify, nativeInvoke, mastodonApiStateService, mastodonUserFeatureService, notesRepository } = createServer();
		await mastodonUserFeatureService.followTag('user-id', 'news');
		nativeInvoke.mockImplementation(async name => {
			if (name === 'notes/timeline') return [{ id: 'note-3' }, { id: 'note-2' }];
			if (name === 'notes/search-by-tag') return [{ id: 'note-4' }, { id: 'note-2' }];
			return [];
		});
		mastodonApiStateService.list.mockClear();

		const response = await fastify.inject({ method: 'GET', url: '/api/v1/timelines/home?limit=20', headers: { authorization: 'Bearer user-token' } });
		expect(response.statusCode).toBe(200);
		expect(response.json().map((status: { id: string }) => status.id)).toEqual(['note-4', 'note-3', 'note-2']);
		expect(nativeInvoke).toHaveBeenCalledWith('notes/search-by-tag', {
			limit: 60,
			query: [['news']],
		}, expect.any(Object), expect.any(Object));
		expect(notesRepository.findBy).toHaveBeenCalledTimes(1);
		expect(mastodonApiStateService.list.mock.calls.filter((call: unknown[]) => call[1] === 'filter')).toHaveLength(1);
	});

	test.each([
		['/api/v1/trends', 'Basic malformed'],
		['/api/v1/trends/tags', 'Bearer unknown-token'],
		['/api/v1/trends/statuses', 'Bearer native-token'],
		['/api/v1/trends/links', 'Bearer unknown-token'],
	])('rejects invalid Authorization on trend route %s', async (url, authorization) => {
		const { fastify, authenticate } = createServer();
		authenticate.mockRejectedValue(new MastodonApiError(401, 'invalid_token', 'The access token is invalid'));

		const response = await fastify.inject({ method: 'GET', url, headers: { authorization } });

		expect(response.statusCode).toBe(401);
		if (authorization.startsWith('Bearer ')) {
			expect(authenticate).toHaveBeenCalledWith(authorization.slice('Bearer '.length));
		} else {
			expect(authenticate).not.toHaveBeenCalled();
		}
	});

	test('maps inaccessible public records to a non-leaking 404 while preserving validation errors', async () => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async (name, data) => {
			if (name !== 'notes/show') return [];
			if (data.noteId === 'hidden') throw new ApiError({
				message: 'Content restricted by user.',
				code: 'CONTENT_RESTRICTED_BY_USER',
				id: 'restricted-note',
			});
			if (data.noteId === 'forbidden') throw new ApiError({
				message: 'Permission denied.',
				code: 'PERMISSION_DENIED',
				id: 'forbidden-note',
				kind: 'permission',
			});
			throw new ApiError({
				message: 'Invalid param.',
				code: 'INVALID_PARAM',
				id: 'invalid-param',
				kind: 'client',
			});
		});

		const hidden = await fastify.inject({ method: 'GET', url: '/api/v1/statuses/hidden' });
		const forbidden = await fastify.inject({ method: 'GET', url: '/api/v1/statuses/forbidden' });
		const invalid = await fastify.inject({ method: 'GET', url: '/api/v1/statuses/invalid' });

		expect(hidden.statusCode).toBe(404);
		expect(hidden.json()).toEqual({ error: 'Record not found' });
		expect(forbidden.statusCode).toBe(404);
		expect(forbidden.json()).toEqual({ error: 'Record not found' });
		expect(invalid.statusCode).toBe(400);
		expect(invalid.json()).toEqual({ error: 'Invalid param.' });
	});

	test.each([
		['followers', 'users/followers'],
		['following', 'users/following'],
	])('maps the native FORBIDDEN error from public %s to a non-leaking 404', async (route, endpoint) => {
		const { fastify, nativeInvoke } = createServer();
		nativeInvoke.mockImplementation(async name => {
			if (name === endpoint) throw new ApiError({
				message: 'Forbidden.',
				code: 'FORBIDDEN',
				id: 'native-forbidden',
			});
			return [];
		});

		const response = await fastify.inject({ method: 'GET', url: `/api/v1/accounts/user-id/${route}` });

		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: 'Record not found' });
	});

	test('authenticates, checks scope, and reuses native endpoints', async () => {
		const { fastify, authenticate, assert, nativeInvoke } = createServer();
		const verify = await fastify.inject({
			method: 'GET', url: '/api/v1/accounts/verify_credentials', headers: { authorization: 'Bearer mastodon-token' },
		});
		const timeline = await fastify.inject({
			method: 'GET', url: '/api/v1/timelines/home', headers: { authorization: 'Bearer mastodon-token' },
		});

		expect(verify.statusCode).toBe(200);
		expect(verify.json()).toEqual({ id: 'user-id', username: 'alice' });
		expect(timeline.statusCode).toBe(200);
		expect(timeline.json()).toEqual([expect.objectContaining({ id: 'note-id' })]);
		expect(timeline.headers.link).toBe('<next>; rel="next"');
		expect(authenticate).toHaveBeenCalledWith('mastodon-token');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:accounts');
		expect(assert).toHaveBeenCalledWith(['read'], 'read:statuses');
		expect(nativeInvoke).toHaveBeenCalledWith('i', {}, expect.any(Object), expect.any(Object));
		expect(nativeInvoke).toHaveBeenCalledWith('notes/timeline', { limit: 20 }, expect.any(Object), expect.any(Object));
	});
});
