/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import promiseLimit from 'promise-limit';
import { DataSource } from 'typeorm';
import { ModuleRef } from '@nestjs/core';
import { DI } from '@/di-symbols.js';
import type { FollowingsRepository, InstancesRepository, MiMeta, UserProfilesRepository, UserPublickeysRepository, UsersRepository } from '@/models/_.js';
import type { Config } from '@/config.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { MiUser } from '@/models/User.js';
import { truncate } from '@/misc/truncate.js';
import type { CacheService } from '@/core/CacheService.js';
import { normalizeTag } from '@/misc/normalize-tag.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';
import type Logger from '@/logger.js';
import type { MiNote } from '@/models/Note.js';
import type { IdService } from '@/core/IdService.js';
import type { MfmService } from '@/core/MfmService.js';
import { toArray } from '@/misc/prelude/array.js';
import type { GlobalEventService } from '@/core/GlobalEventService.js';
import type { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import type { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { MiUserProfile } from '@/models/UserProfile.js';
import { MiUserPublickey } from '@/models/UserPublickey.js';
import type UsersChart from '@/core/chart/charts/users.js';
import type InstanceChart from '@/core/chart/charts/instance.js';
import type { HashtagService } from '@/core/HashtagService.js';
import { MiUserNotePining } from '@/models/UserNotePining.js';
import { StatusError } from '@/misc/status-error.js';
import type { UtilityService } from '@/core/UtilityService.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import { RoleService } from '@/core/RoleService.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import type { AccountMoveService } from '@/core/AccountMoveService.js';
import { checkHttps } from '@/misc/check-https.js';
import { getApId, getApType, getOneApHrefNullable, isActor, isCollection, isCollectionOrOrderedCollection, isPropertyValue } from '../type.js';
import { extractApHashtags } from './tag.js';
import type { OnModuleInit } from '@nestjs/common';
import type { ApNoteService } from './ApNoteService.js';
import type { ApMfmService } from '../ApMfmService.js';
import type { ApResolverService, Resolver } from '../ApResolverService.js';
import type { ApLoggerService } from '../ApLoggerService.js';

import type { ApImageService } from './ApImageService.js';
import type { IActor, ICollection, IObject, IOrderedCollection } from '../type.js';

const nameLength = 128;
const summaryLength = 2048;

type Field = Record<'name' | 'value', string>;

@Injectable()
export class ApPersonService implements OnModuleInit {
	private utilityService: UtilityService;
	private userEntityService: UserEntityService;
	private driveFileEntityService: DriveFileEntityService;
	private idService: IdService;
	private globalEventService: GlobalEventService;
	private federatedInstanceService: FederatedInstanceService;
	private fetchInstanceMetadataService: FetchInstanceMetadataService;
	private cacheService: CacheService;
	private apResolverService: ApResolverService;
	private apNoteService: ApNoteService;
	private apImageService: ApImageService;
	private apMfmService: ApMfmService;
	private mfmService: MfmService;
	private hashtagService: HashtagService;
	private usersChart: UsersChart;
	private instanceChart: InstanceChart;
	private apLoggerService: ApLoggerService;
	private accountMoveService: AccountMoveService;
	private logger: Logger;

	constructor(
		private moduleRef: ModuleRef,

		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.userPublickeysRepository)
		private userPublickeysRepository: UserPublickeysRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private roleService: RoleService,
	) {
	}

	onModuleInit(): void {
		this.utilityService = this.moduleRef.get('UtilityService');
		this.userEntityService = this.moduleRef.get('UserEntityService');
		this.driveFileEntityService = this.moduleRef.get('DriveFileEntityService');
		this.idService = this.moduleRef.get('IdService');
		this.globalEventService = this.moduleRef.get('GlobalEventService');
		this.federatedInstanceService = this.moduleRef.get('FederatedInstanceService');
		this.fetchInstanceMetadataService = this.moduleRef.get('FetchInstanceMetadataService');
		this.cacheService = this.moduleRef.get('CacheService');
		this.apResolverService = this.moduleRef.get('ApResolverService');
		this.apNoteService = this.moduleRef.get('ApNoteService');
		this.apImageService = this.moduleRef.get('ApImageService');
		this.apMfmService = this.moduleRef.get('ApMfmService');
		this.mfmService = this.moduleRef.get('MfmService');
		this.hashtagService = this.moduleRef.get('HashtagService');
		this.usersChart = this.moduleRef.get('UsersChart');
		this.instanceChart = this.moduleRef.get('InstanceChart');
		this.apLoggerService = this.moduleRef.get('ApLoggerService');
		this.accountMoveService = this.moduleRef.get('AccountMoveService');
		this.logger = this.apLoggerService.logger;
	}

	@bindThis
	private validateActor(x: IObject, uri: string): IActor {
		const expectHost = this.utilityService.punyHost(uri);

		if (!isActor(x)) {
			throw new Error(`invalid Actor type '${x.type}'`);
		}

		if (!(typeof x.id === 'string' && x.id.length > 0)) {
			throw new Error('invalid Actor: wrong id');
		}

		if (!(typeof x.inbox === 'string' && x.inbox.length > 0)) {
			throw new Error('invalid Actor: wrong inbox');
		}

		if (this.utilityService.punyHost(x.inbox) !== expectHost) {
			throw new Error('invalid Actor: inbox has different host');
		}

		const sharedInboxObject = x.sharedInbox ?? (x.endpoints ? x.endpoints.sharedInbox : undefined);
		if (sharedInboxObject != null) {
			const sharedInbox = getApId(sharedInboxObject);
			if (!(typeof sharedInbox === 'string' && sharedInbox.length > 0 && new URL(sharedInbox).host === expectHost)) {
				this.logger.warn(`invalid Actor: skipping wrong shared inbox, expected host: ${expectHost}, actual URL: ${sharedInbox}`);
				x.sharedInbox = undefined;
				if (x.endpoints?.sharedInbox) {
					x.endpoints.sharedInbox = undefined;
				}
			}
		}

		for (const collection of ['outbox', 'followers', 'following'] as (keyof IActor)[]) {
			const xCollection = (x as IActor)[collection];
			if (xCollection != null) {
				const collectionUri = getApId(xCollection);
				if (typeof collectionUri === 'string' && collectionUri.length > 0) {
					if (this.utilityService.punyHost(collectionUri) !== expectHost) {
						throw new Error(`invalid Actor: ${collection} has different host`);
					}
				} else if (collectionUri != null) {
					throw new Error(`invalid Actor: wrong ${collection}`);
				}
			}
		}

		if (!(typeof x.preferredUsername === 'string' && x.preferredUsername.length > 0 && x.preferredUsername.length <= 128 && /^\w([\w-.]*\w)?$/.test(x.preferredUsername))) {
			throw new Error('invalid Actor: wrong username');
		}

		if (x.name) {
			if (!(typeof x.name === 'string' && x.name.length > 0)) {
				throw new Error('invalid Actor: wrong name');
			}
			x.name = truncate(x.name, nameLength);
		} else if (x.name === '') {
			x.name = undefined;
		}
		if (x.summary) {
			if (!(typeof x.summary === 'string' && x.summary.length > 0)) {
				throw new Error('invalid Actor: wrong summary');
			}
			x.summary = truncate(x.summary, summaryLength);
		}

		const idHost = this.utilityService.punyHost(x.id);
		if (idHost !== expectHost) {
			throw new Error('invalid Actor: id has different host');
		}

		if (x.publicKey) {
			if (typeof x.publicKey.id !== 'string') {
				throw new Error('invalid Actor: publicKey.id is not a string');
			}

			const publicKeyIdHost = this.utilityService.punyHost(x.publicKey.id);
			if (publicKeyIdHost !== expectHost) {
				throw new Error('invalid Actor: publicKey.id has different host');
			}
		}

		return x;
	}

	@bindThis
	public async fetchPerson(uri: string): Promise<MiLocalUser | MiRemoteUser | null> {
		const cached = this.cacheService.uriPersonCache.get(uri) as MiLocalUser | MiRemoteUser | null | undefined;
		if (cached) return cached;

		if (uri.startsWith(`${this.config.url}/`)) {
			const id = uri.split('/').pop();
			const u = await this.usersRepository.findOneBy({ id }) as MiLocalUser | null;
			if (u) this.cacheService.uriPersonCache.set(uri, u);
			return u;
		}

		const exist = await this.usersRepository.findOneBy({ uri }) as MiLocalUser | MiRemoteUser | null;

		if (exist) {
			this.cacheService.uriPersonCache.set(uri, exist);
			return exist;
		}

		return null;
	}

	private async resolveAvatarAndBanner(user: MiRemoteUser, icon: any, image: any): Promise<Partial<Pick<MiRemoteUser, 'avatarId' | 'bannerId' | 'avatarUrl' | 'bannerUrl' | 'avatarBlurhash' | 'bannerBlurhash'>>> {
		if (user == null) throw new Error('failed to create user: user is null');

		const [avatar, banner] = await Promise.all([icon, image].map(img => {
			if (Array.isArray(img)) {
				img = img.find(item => item && item.url) ?? null;
			}

			if ((img == null) || (typeof img === 'object' && img.url == null)) {
				return { id: null, url: null, blurhash: null };
			}

			return this.apImageService.resolveImage(user, img).catch(() => null);
		}));

		if (((avatar != null && avatar.id != null) || (banner != null && banner.id != null))
				&& !(await this.roleService.getUserPolicies(user.id)).canUpdateBioMedia) {
			return {};
		}

		return {
			...( avatar ? {
				avatarId: avatar.id,
				avatarUrl: avatar.url ? this.driveFileEntityService.getPublicUrl(avatar, 'avatar') : null,
				avatarBlurhash: avatar.blurhash,
			} : {}),
			...( banner ? {
				bannerId: banner.id,
				bannerUrl: banner.url ? this.driveFileEntityService.getPublicUrl(banner) : null,
				bannerBlurhash: banner.blurhash,
			} : {}),
		};
	}

	@bindThis
	public async createPerson(uri: string, resolver?: Resolver): Promise<MiRemoteUser> {
		if (typeof uri !== 'string') throw new Error('uri is not string');

		const host = this.utilityService.punyHost(uri);
		if (host === this.utilityService.toPuny(this.config.host)) {
			throw new StatusError('cannot resolve local user', 400, 'cannot resolve local user');
		}

		// eslint-disable-next-line no-param-reassign
		if (resolver == null) resolver = await this.apResolverService.createResolver();

		const object = await resolver.resolve(uri);
		if (object.id == null) throw new Error('invalid object.id: ' + object.id);

		const person = this.validateActor(object, uri);

		this.logger.info(`Creating the Person: ${person.id}`);

		const fields = this.analyzeAttachments(person.attachment ?? []);

		const tags = extractApHashtags(person.tag).splice(0, 32).map(normalizeTag);

		const isBot = getApType(object) === 'Service' || getApType(object) === 'Application';

		const [followingVisibility, followersVisibility] = await Promise.all(
			[
				this.isPublicCollection(person.following, resolver),
				this.isPublicCollection(person.followers, resolver),
			].map((p): Promise<'public' | 'private'> => p
				.then(isPublic => isPublic ? 'public' : 'private')
				.catch(err => {
					if (!(err instanceof StatusError) || err.isRetryable) {
						this.logger.error('error occurred while fetching following/followers collection', { stack: err });
					}
					return 'private';
				}),
			),
		);

		const bday = person['vcard:bday']?.match(/^\d{4}-\d{2}-\d{2}/);

		const url = getOneApHrefNullable(person.url);

		if (person.id == null) {
			throw new Error('Refusing to create person without id');
		}

		if (url && !checkHttps(url)) {
			throw new Error('unexpected schema of person url: ' + url);
		}

		let user: MiRemoteUser | null = null;

		const emojis = await this.apNoteService.extractEmojis(person.tag ?? [], host)
			.then(_emojis => _emojis.map(emoji => emoji.name))
			.catch(err => {
				this.logger.error('error occurred while fetching user emojis', { stack: err });
				return [];
			});

		try {
			await this.db.transaction(async transactionalEntityManager => {
				user = await transactionalEntityManager.save(new MiUser({
					id: this.idService.gen(),
					avatarId: null,
					bannerId: null,
					lastFetchedAt: new Date(),
					name: truncate(person.name, nameLength),
					isLocked: person.manuallyApprovesFollowers,
					movedToUri: person.movedTo,
					movedAt: person.movedTo ? new Date() : null,
					alsoKnownAs: toArray(person.alsoKnownAs),
					isExplorable: person.discoverable === true,
					username: person.preferredUsername,
					approved: true,
					usernameLower: person.preferredUsername?.toLowerCase(),
					host,
					inbox: person.inbox,
					sharedInbox: person.sharedInbox ?? person.endpoints?.sharedInbox ?? null,
					followersUri: person.followers ? getApId(person.followers) : undefined,
					featured: person.featured ? getApId(person.featured) : undefined,
					uri: person.id,
					tags,
					isBot,
					isCat: (person as any).isCat === true,
					requireSigninToViewContents: (person as any).requireSigninToViewContents === true,
					makeNotesFollowersOnlyBefore: (person as any).makeNotesFollowersOnlyBefore ?? null,
					makeNotesHiddenBefore: (person as any).makeNotesHiddenBefore ?? null,
					emojis,
				})) as MiRemoteUser;

				let _description: string | null = null;

				if (person._misskey_summary) {
					_description = truncate(person._misskey_summary, summaryLength);
				} else if (person.summary) {
					_description = this.apMfmService.htmlToMfm(truncate(person.summary, summaryLength), { tag: person.tag });
				}

				await transactionalEntityManager.save(new MiUserProfile({
					userId: user.id,
					description: _description,
					followedMessage: person._misskey_followedMessage != null ? truncate(person._misskey_followedMessage, 256) : null,
					url,
					fields,
					followingVisibility,
					followersVisibility,
					birthday: bday?.[0] ?? null,
					location: person['vcard:Address'] ?? null,
					userHost: host,
				}));

				if (person.publicKey) {
					await transactionalEntityManager.save(new MiUserPublickey({
						userId: user.id,
						keyId: person.publicKey.id,
						keyPem: person.publicKey.publicKeyPem,
					}));
				}
			});
		} catch (e) {
			if (isDuplicateKeyValueError(e)) {
				const u = await this.usersRepository.findOneBy({ uri: person.id });
				if (u == null) throw new Error('already registered');

				user = u as MiRemoteUser;
			} else {
				this.logger.error(e instanceof Error ? e : new Error(e as string));
				throw e;
			}
		}

		if (user == null) throw new Error('failed to create user: user is null');

		this.cacheService.uriPersonCache.set(user.uri, user);

		if (this.meta.enableStatsForFederatedInstances) {
			this.federatedInstanceService.fetchOrRegister(host).then(i => {
				this.instancesRepository.increment({ id: i.id }, 'usersCount', 1);
				if (this.meta.enableChartsForFederatedInstances) {
					this.instanceChart.newUser(i.host);
				}
				this.fetchInstanceMetadataService.fetchInstanceMetadata(i);
			});
		}

		this.usersChart.update(user, true);

		this.hashtagService.updateUsertags(user, tags);

		try {
			const updates = await this.resolveAvatarAndBanner(user, person.icon, person.image);
			await this.usersRepository.update(user.id, updates);
			user = { ...user, ...updates };

			this.cacheService.uriPersonCache.set(user.uri, user);
		} catch (err) {
			this.logger.error('error occurred while fetching user avatar/banner', { stack: err });
		}

		await this.updateFeatured(user.id, resolver).catch(err => this.logger.error(err));

		return user;
	}

	@bindThis
	public async updatePerson(uri: string, resolver?: Resolver | null, hint?: IObject, movePreventUris: string[] = []): Promise<string | void> {
		if (typeof uri !== 'string') throw new Error('uri is not string');

		if (this.utilityService.isUriLocal(uri)) return;

		const exist = await this.fetchPerson(uri) as MiRemoteUser | null;
		if (exist === null) return;

		// eslint-disable-next-line no-param-reassign
		if (resolver == null) resolver = await this.apResolverService.createResolver();

		const object = hint ?? await resolver.resolve(uri);

		const person = this.validateActor(object, uri);

		this.logger.info(`Updating the Person: ${person.id}`);

		const emojis = await this.apNoteService.extractEmojis(person.tag ?? [], exist.host).catch(e => {
			this.logger.info(`extractEmojis: ${e}`);
			return [];
		});

		const emojiNames = emojis.map(emoji => emoji.name);

		const fields = this.analyzeAttachments(person.attachment ?? []);

		const tags = extractApHashtags(person.tag).splice(0, 32).map(normalizeTag);

		const [followingVisibility, followersVisibility] = await Promise.all(
			[
				this.isPublicCollection(person.following, resolver),
				this.isPublicCollection(person.followers, resolver),
			].map((p): Promise<'public' | 'private' | undefined> => p
				.then(isPublic => isPublic ? 'public' : 'private')
				.catch(err => {
					if (!(err instanceof StatusError) || err.isRetryable) {
						this.logger.error('error occurred while fetching following/followers collection', { stack: err });
						return undefined;
					}
					return 'private';
				}),
			),
		);

		const bday = person['vcard:bday']?.match(/^\d{4}-\d{2}-\d{2}/);

		const url = getOneApHrefNullable(person.url);

		if (person.id == null) {
			throw new Error('Refusing to update person without id');
		}

		if (url != null) {
			if (!checkHttps(url)) {
				throw new Error('unexpected schema of person url: ' + url);
			}

			if (this.utilityService.punyHost(url) !== this.utilityService.punyHost(person.id)) {
				throw new Error(`person url <> uri host mismatch: ${url} <> ${person.id}`);
			}
		}

		const updates = {
			lastFetchedAt: new Date(),
			inbox: person.inbox,
			sharedInbox: person.sharedInbox ?? person.endpoints?.sharedInbox ?? null,
			followersUri: person.followers ? getApId(person.followers) : undefined,
			featured: person.featured ? getApId(person.featured) : undefined,
			emojis: emojiNames,
			name: truncate(person.name, nameLength),
			tags,
			approved: true,
			isBot: getApType(object) === 'Service' || getApType(object) === 'Application',
			isCat: (person as any).isCat === true,
			isLocked: person.manuallyApprovesFollowers,
			movedToUri: person.movedTo ?? null,
			alsoKnownAs: person.alsoKnownAs ? toArray(person.alsoKnownAs) : null,
			isExplorable: person.discoverable === true,
			...(await this.resolveAvatarAndBanner(exist, person.icon, person.image).catch(() => ({}))),
		} as Partial<MiRemoteUser> & Pick<MiRemoteUser, 'isBot' | 'isCat' | 'isLocked' | 'movedToUri' | 'alsoKnownAs' | 'isExplorable'>;

		const moving = ((): boolean => {
			if (
				exist.movedToUri === null &&
				updates.movedToUri
			) return true;

			if (
				exist.movedToUri !== null &&
				updates.movedToUri !== null &&
				exist.movedToUri !== updates.movedToUri
			) return true;

			return false;
		})();

		if (moving) updates.movedAt = new Date();

		if (!(await this.usersRepository.update({ id: exist.id, isDeleted: false }, updates)).affected) {
			return 'skip';
		}

		if (person.publicKey) {
			await this.userPublickeysRepository.update({ userId: exist.id }, {
				keyId: person.publicKey.id,
				keyPem: person.publicKey.publicKeyPem,
			});
		}

		let _description: string | null = null;

		if (person._misskey_summary) {
			_description = truncate(person._misskey_summary, summaryLength);
		} else if (person.summary) {
			_description = this.apMfmService.htmlToMfm(truncate(person.summary, summaryLength), { tag: person.tag });
		}

		await this.userProfilesRepository.update({ userId: exist.id }, {
			url,
			fields,
			description: _description,
			followedMessage: person._misskey_followedMessage != null ? truncate(person._misskey_followedMessage, 256) : null,
			followingVisibility,
			followersVisibility,
			birthday: bday?.[0] ?? null,
			location: person['vcard:Address'] ?? null,
		});

		this.globalEventService.publishInternalEvent('remoteUserUpdated', { id: exist.id });

		this.hashtagService.updateUsertags(exist, tags);

		await this.followingsRepository.update(
			{ followerId: exist.id },
			{ followerSharedInbox: person.sharedInbox ?? person.endpoints?.sharedInbox ?? null },
		);

		await this.updateFeatured(exist.id, resolver).catch(err => this.logger.error(err));

		const updated = { ...exist, ...updates };

		this.cacheService.uriPersonCache.set(uri, updated);

		if (updated.movedAt && (
			exist.movedAt == null ||
			exist.movedAt.getTime() + 1000 * 60 * 60 * 24 * 14 < updated.movedAt.getTime()
		)) {
			this.logger.info(`Start to process Move of @${updated.username}@${updated.host} (${uri})`);
			return this.processRemoteMove(updated, movePreventUris)
				.then(result => {
					this.logger.info(`Processing Move Finished [${result}] @${updated.username}@${updated.host} (${uri})`);
					return result;
				})
				.catch(e => {
					this.logger.info(`Processing Move Failed @${updated.username}@${updated.host} (${uri})`, { stack: e });
				});
		}

		return 'skip';
	}

	@bindThis
	public async resolvePerson(uri: string, resolver?: Resolver): Promise<MiLocalUser | MiRemoteUser> {
		const exist = await this.fetchPerson(uri);
		if (exist) return exist;

		// eslint-disable-next-line no-param-reassign
		if (resolver == null) resolver = await this.apResolverService.createResolver();
		return await this.createPerson(uri, resolver);
	}

	@bindThis
	public analyzeAttachments(attachments: IObject | IObject[] | undefined): Field[] {
		const fields: Field[] = [];

		if (Array.isArray(attachments)) {
			for (const attachment of attachments.filter(isPropertyValue)) {
				fields.push({
					name: attachment.name,
					value: this.mfmService.fromHtml(attachment.value),
				});
			}
		}

		return fields;
	}

	@bindThis
	public async updateFeatured(userId: MiUser['id'], resolver?: Resolver): Promise<void> {
		const user = await this.usersRepository.findOneByOrFail({ id: userId, isDeleted: false });
		if (!this.userEntityService.isRemoteUser(user)) return;
		if (!user.featured) return;

		this.logger.info(`Updating the featured: ${user.uri}`);

		const _resolver = resolver ?? await this.apResolverService.createResolver();

		const collection = await _resolver.resolveCollection(user.featured);
		if (!isCollectionOrOrderedCollection(collection)) throw new Error('Object is not Collection or OrderedCollection');

		const unresolvedItems = isCollection(collection) ? collection.items : collection.orderedItems;
		const items = await Promise.all(toArray(unresolvedItems).slice(0, 5).map(x => _resolver.resolve(x)));

		const limit = promiseLimit<MiNote | null>(2);
		const featuredNotes = await Promise.all(items
			.filter(item => getApType(item) === 'Note')
			.map(item => limit(() => this.apNoteService.resolveNote(item, {
				resolver: _resolver,
				sentFrom: new URL(user.uri),
			}))));

		await this.db.transaction(async transactionalEntityManager => {
			await transactionalEntityManager.findOneOrFail(MiUser, {
				where: { id: user.id, isDeleted: false },
				lock: { mode: 'pessimistic_write' },
			});
			await transactionalEntityManager.delete(MiUserNotePining, { userId: user.id });

			const now = Date.now();
			let td = 0;
			const pinnedNoteIds = new Set<MiNote['id']>();
			for (const note of featuredNotes.filter(x => x != null)) {
				if (pinnedNoteIds.has(note.id)) continue;
				pinnedNoteIds.add(note.id);
				td -= 1000;
				await transactionalEntityManager.insert(MiUserNotePining, {
					id: this.idService.gen(now + td),
					userId: user.id,
					noteId: note.id,
				});
			}
		});
	}

	@bindThis
	private async processRemoteMove(src: MiRemoteUser, movePreventUris: string[] = []): Promise<string> {
		if (!src.movedToUri) return 'skip: no movedToUri';
		if (src.uri === src.movedToUri) return 'skip: movedTo itself (src)';
		if (movePreventUris.length > 10) return 'skip: too many moves';

		let dst = await this.fetchPerson(src.movedToUri);

		if (dst && this.userEntityService.isLocalUser(dst)) {
			dst = await this.usersRepository.findOneByOrFail({ id: dst.id }) as MiLocalUser;
		} else if (dst) {
			if (movePreventUris.includes(src.movedToUri)) return 'skip: circular move';

			await this.updatePerson(src.movedToUri, undefined, undefined, [...movePreventUris, src.uri]);
			dst = await this.fetchPerson(src.movedToUri) ?? dst;
		} else {
			if (this.utilityService.isUriLocal(src.movedToUri)) {
				return 'failed: movedTo is local but not found';
			}

			dst = await this.resolvePerson(src.movedToUri);
		}

		const dstUri = this.userEntityService.getUserUri(dst);
		if (dst.movedToUri === dstUri) return 'skip: movedTo itself (dst)';
		if (src.movedToUri !== dstUri) return 'skip: missmatch uri';
		if (dst.movedToUri === src.uri) return 'skip: dst.movedToUri === src.uri';
		if (!dst.alsoKnownAs || dst.alsoKnownAs.length === 0) {
			return 'skip: dst.alsoKnownAs is empty';
		}
		if (!dst.alsoKnownAs.includes(src.uri)) {
			return 'skip: alsoKnownAs does not include from.uri';
		}

		await this.accountMoveService.postMoveProcess(src, dst);

		return 'ok';
	}

	@bindThis
	private async isPublicCollection(collection: string | ICollection | IOrderedCollection | undefined, resolver: Resolver): Promise<boolean> {
		if (collection) {
			const resolved = await resolver.resolveCollection(collection);
			if (resolved.first || (resolved as ICollection).items || (resolved as IOrderedCollection).orderedItems) {
				return true;
			}
		}

		return false;
	}
}
