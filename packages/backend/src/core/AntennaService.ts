/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In } from 'typeorm';
import { FanoutTimelineService } from '@/core/FanoutTimelineService.js';
import type { GlobalEvents } from '@/core/GlobalEventService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { subscribeInternalEvent } from '@/misc/redis-pubsub-bus.js';
import { UtilityService } from '@/core/UtilityService.js';
import { bindThis } from '@/decorators.js';
import { DI } from '@/di-symbols.js';
import * as Acct from '@/misc/acct.js';
import type { Packed } from '@/misc/json-schema.js';
import type { AntennasRepository, UserListMembershipsRepository } from '@/models/_.js';
import type { MiAntenna } from '@/models/Antenna.js';
import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import { CacheService } from './CacheService.js';
import type { OnApplicationShutdown } from '@nestjs/common';

type CompiledAntenna = {
	src: MiAntenna['src'];
	caseSensitive: boolean;
	usersRef: MiAntenna['users'];
	keywordsRef: MiAntenna['keywords'];
	excludeKeywordsRef: MiAntenna['excludeKeywords'];
	users: Set<string> | null;
	keywords: string[][];
	excludeKeywords: string[][];
};

type AntennaNoteMatchContext = {
	noteText: string | null;
	noteTextLower: string | null;
	matchUser?: string;
	matchWildcard?: string;
};

@Injectable()
export class AntennaService implements OnApplicationShutdown {
	private antennasFetched: boolean;
	private antennas: MiAntenna[];
	private unsubscribeInternal?: () => void;
	private compiledAntennas = new WeakMap<MiAntenna, CompiledAntenna>();

	constructor(
		@Inject(DI.redisForTimelines)
		private redisForTimelines: Redis.Redis,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.antennasRepository)
		private antennasRepository: AntennasRepository,

		@Inject(DI.userListMembershipsRepository)
		private userListMembershipsRepository: UserListMembershipsRepository,

		private cacheService: CacheService,
		private utilityService: UtilityService,
		private globalEventService: GlobalEventService,
		private fanoutTimelineService: FanoutTimelineService,
	) {
		this.antennasFetched = false;
		this.antennas = [];

		this.unsubscribeInternal = subscribeInternalEvent(this.redisForSub, this.onInternalEvent);
	}

	@bindThis
	private async onInternalEvent(event: GlobalEvents['internal']['payload']): Promise<void> {
		const { type, body } = event;
		switch (type) {
			case 'antennaCreated':
				this.antennas.push({
					...body,
					lastUsedAt: new Date(body.lastUsedAt),
					user: null,
					userList: null,
				});
				break;
			case 'antennaUpdated': {
				const idx = this.antennas.findIndex(a => a.id === body.id);
				if (idx >= 0) {
					this.antennas[idx] = {
						...body,
						lastUsedAt: new Date(body.lastUsedAt),
						user: null,
						userList: null,
					};
				} else {
					this.antennas.push({
						...body,
						lastUsedAt: new Date(body.lastUsedAt),
						user: null,
						userList: null,
					});
				}
			}
				break;
			case 'antennaDeleted':
				this.antennas = this.antennas.filter(a => a.id !== body.id);
				break;
			default:
				break;
		}
	}

	private compileAntenna(antenna: MiAntenna): CompiledAntenna {
		const cached = this.compiledAntennas.get(antenna);
		if (
			cached != null &&
			cached.src === antenna.src &&
			cached.caseSensitive === antenna.caseSensitive &&
			cached.usersRef === antenna.users &&
			cached.keywordsRef === antenna.keywords &&
			cached.excludeKeywordsRef === antenna.excludeKeywords
		) {
			return cached;
		}

		const users = (antenna.src === 'users' || antenna.src === 'users_blacklist')
			? new Set(antenna.users.map(x => {
				const { username, host } = Acct.parse(x);
				return this.utilityService.getFullApAccount(username, host).toLowerCase();
			}))
			: null;

		const normalizeGroups = (groups: string[][]): string[][] => groups
			.map(xs => xs.filter(x => x !== '').map(x => antenna.caseSensitive ? x : x.toLowerCase()))
			.filter(xs => xs.length > 0);

		const compiled: CompiledAntenna = {
			src: antenna.src,
			caseSensitive: antenna.caseSensitive,
			usersRef: antenna.users,
			keywordsRef: antenna.keywords,
			excludeKeywordsRef: antenna.excludeKeywords,
			users,
			keywords: normalizeGroups(antenna.keywords),
			excludeKeywords: normalizeGroups(antenna.excludeKeywords),
		};
		this.compiledAntennas.set(antenna, compiled);
		return compiled;
	}

	private createMatchContext(note: MiNote | Packed<'Note'>): AntennaNoteMatchContext {
		const noteText = (note.text == null && note.cw == null) ? null : ((note.text ?? '') + '\n' + (note.cw ?? ''));
		return {
			noteText,
			noteTextLower: null,
		};
	}

	private checkSyncFilters(
		antenna: MiAntenna,
		note: MiNote | Packed<'Note'>,
		noteUser: { id: MiUser['id']; username: string; host: string | null; isBot: boolean; },
		ctx: AntennaNoteMatchContext,
	): boolean {
		if (antenna.excludeNotesInSensitiveChannel && note.channel?.isSensitive) return false;
		if (antenna.excludeBots && noteUser.isBot) return false;
		if (antenna.localOnly && noteUser.host != null) return false;
		if (!antenna.withReplies && note.replyId != null) return false;

		if (note.visibility === 'specified') {
			if (note.userId !== antenna.userId) {
				if (note.visibleUserIds == null) return false;
				if (!note.visibleUserIds.includes(antenna.userId)) return false;
			}
		}

		if (antenna.withFile) {
			if (note.fileIds && note.fileIds.length === 0) return false;
		}

		if (antenna.src === 'list' && antenna.userListId == null) return false;

		const compiled = this.compileAntenna(antenna);

		if (compiled.users != null) {
			ctx.matchUser ??= this.utilityService.getFullApAccount(noteUser.username, noteUser.host).toLowerCase();
			ctx.matchWildcard ??= this.utilityService.getFullApAccount('*', noteUser.host).toLowerCase();
			const inUsers = compiled.users.has(ctx.matchUser) || compiled.users.has(ctx.matchWildcard);
			if (antenna.src === 'users' && !inUsers) return false;
			if (antenna.src === 'users_blacklist' && inUsers) return false;
		}

		if (compiled.keywords.length > 0) {
			if (ctx.noteText == null) return false;
			const targetText = antenna.caseSensitive
				? ctx.noteText
				: (ctx.noteTextLower ??= ctx.noteText.toLowerCase());
			const matched = compiled.keywords.some(and => and.every(keyword => targetText.includes(keyword)));
			if (!matched) return false;
		}

		if (compiled.excludeKeywords.length > 0) {
			if (ctx.noteText == null) return false;
			const targetText = antenna.caseSensitive
				? ctx.noteText
				: (ctx.noteTextLower ??= ctx.noteText.toLowerCase());
			const matched = compiled.excludeKeywords.some(and => and.every(keyword => targetText.includes(keyword)));
			if (matched) return false;
		}

		return true;
	}

	@bindThis
	public async addNoteToAntennas(note: MiNote, noteUser: { id: MiUser['id']; username: string; host: string | null; isBot: boolean; }): Promise<MiAntenna[]> {
		const antennas = await this.getAntennas();
		if (antennas.length === 0) return [];

		const ctx = this.createMatchContext(note);
		let candidates = antennas.filter(antenna => this.checkSyncFilters(antenna, note, noteUser, ctx));
		if (candidates.length === 0) return [];

		const candidateListIds = [...new Set(
			candidates
				.filter(antenna => antenna.src === 'list' && antenna.userListId != null)
				.map(antenna => antenna.userListId!),
		)];

		if (candidateListIds.length > 0) {
			const memberships = await this.userListMembershipsRepository.find({
				where: {
					userId: note.userId,
					userListId: In(candidateListIds),
				},
				select: { userListId: true },
			});
			const matchedListIds = new Set(memberships.map(m => m.userListId));
			candidates = candidates.filter(antenna => antenna.src !== 'list' || matchedListIds.has(antenna.userListId!));
			if (candidates.length === 0) return [];
		}

		let matchedAntennas = candidates;
		if (note.visibility === 'followers') {
			const ownerIds = [...new Set(candidates.filter(a => a.userId !== note.userId).map(a => a.userId))];
			const followingOwners = new Set<MiUser['id']>();
			await Promise.all(ownerIds.map(async ownerId => {
				const followings = await this.cacheService.userFollowingsCache.fetch(ownerId);
				if (Object.hasOwn(followings, note.userId)) {
					followingOwners.add(ownerId);
				}
			}));
			matchedAntennas = candidates.filter(antenna => antenna.userId === note.userId || followingOwners.has(antenna.userId));
		}

		if (matchedAntennas.length === 0) return [];

		const redisPipeline = this.redisForTimelines.pipeline();

		for (const antenna of matchedAntennas) {
			this.fanoutTimelineService.push(`antennaTimeline:${antenna.id}`, note.id, 200, redisPipeline);
		}

		redisPipeline.exec();

		return matchedAntennas;
	}

	@bindThis
	public async checkHitAntenna(antenna: MiAntenna, note: (MiNote | Packed<'Note'>), noteUser: { id: MiUser['id']; username: string; host: string | null; isBot: boolean; }): Promise<boolean> {
		const ctx = this.createMatchContext(note);
		if (!this.checkSyncFilters(antenna, note, noteUser, ctx)) return false;

		if (note.visibility === 'followers' && antenna.userId !== note.userId) {
			const isFollowing = Object.hasOwn(await this.cacheService.userFollowingsCache.fetch(antenna.userId), note.userId);
			if (!isFollowing) return false;
		}

		if (antenna.src === 'list') {
			if (antenna.userListId == null) return false;
			const exists = await this.userListMembershipsRepository.exists({
				where: {
					userListId: antenna.userListId,
					userId: note.userId,
				},
			});
			if (!exists) return false;
		}

		return true;
	}

	@bindThis
	public async getAntennas() {
		if (!this.antennasFetched) {
			this.antennas = await this.antennasRepository.findBy({
				isActive: true,
			});
			this.antennasFetched = true;
		}

		return this.antennas;
	}

	@bindThis
	public async onMoveAccount(src: MiUser, dst: MiUser): Promise<void> {
		const srcUserAcct = this.utilityService.getFullApAccount(src.username, src.host).toLowerCase();
		const antennasToMigrate = (await this.getAntennas()).filter(antenna => {
			return antenna.users.some(user => {
				const { username, host } = Acct.parse(user);
				return this.utilityService.getFullApAccount(username, host).toLowerCase() === srcUserAcct;
			});
		});

		if (antennasToMigrate.length === 0) return;

		const antennaIds = antennasToMigrate.map(x => x.id);

		const dstUserAcct = '@' + Acct.toString({ username: dst.username, host: dst.host });

		await this.antennasRepository.createQueryBuilder('antenna')
			.update()
			.set({
				users: () => 'array_append(antenna.users, :dstUserAcct)',
			})
			.where('antenna.id IN (:...antennaIds)', { antennaIds })
			.setParameters({ dstUserAcct })
			.execute();

		for (const newAntenna of await this.antennasRepository.findBy({ id: In(antennaIds) })) {
			this.globalEventService.publishInternalEvent('antennaUpdated', newAntenna);
		}
	}

	@bindThis
	public dispose(): void {
		this.unsubscribeInternal?.();
		this.unsubscribeInternal = undefined;
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}
