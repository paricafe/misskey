/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import type { FastifyRequest } from 'fastify';
import type { Config } from '@/config.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { QueryService } from '@/core/QueryService.js';
import { DI } from '@/di-symbols.js';
import type { Packed } from '@/misc/json-schema.js';
import type { NotesRepository, UsersRepository } from '@/models/_.js';
import { ApiError } from '@/server/api/error.js';
import { MastodonApiCallService } from './MastodonApiCallService.js';
import { MastodonApiError } from './errors.js';
import type { MastodonUserAuth } from './types.js';

type ReplyNode = { id: string; replyId?: string | null; isHidden?: boolean };

/** Traverse only visible reply edges; quote/renote edges never belong to a conversation. */
export async function collectMastodonReplies<T extends ReplyNode>(
	rootId: string,
	load: (parentIds: string[], limit: number) => Promise<T[]>,
	limits: { count: number; depth: number },
): Promise<T[]> {
	const seen = new Set([rootId]);
	const children = new Map<string, T[]>();
	let frontier = [rootId];
	let count = 0;
	for (let depth = 0; frontier.length > 0 && depth < limits.depth && count < limits.count; depth++) {
		const parentIds = new Set(frontier);
		const page = await load(frontier, limits.count - count);
		frontier = [];
		for (const note of page) {
			if (note.isHidden || note.replyId == null || !parentIds.has(note.replyId) || seen.has(note.id)) continue;
			seen.add(note.id);
			const siblings = children.get(note.replyId) ?? [];
			siblings.push(note);
			children.set(note.replyId, siblings);
			frontier.push(note.id);
			count++;
			if (count >= limits.count) break;
		}
	}

	for (const siblings of children.values()) siblings.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
	const result: T[] = [];
	const stack = [...children.get(rootId) ?? []].reverse();
	while (stack.length > 0) {
		const note = stack.pop()!;
		result.push(note);
		stack.push(...[...children.get(note.id) ?? []].reverse());
	}
	return result;
}

@Injectable()
export class MastodonQueryService {
	constructor(
		private mastodonApiCallService: MastodonApiCallService,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private queryService: QueryService,
		private noteEntityService: NoteEntityService,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.config)
		private config: Config,
	) {}

	public async context(noteId: string, auth: MastodonUserAuth | null, request: FastifyRequest): Promise<{
		ancestors: Packed<'Note'>[];
		descendants: Packed<'Note'>[];
	}> {
		const root = await this.mastodonApiCallService.invokePublic('notes/show', { noteId }, auth, request) as Packed<'Note'>;
		if (root.isHidden) throw new MastodonApiError(404, 'not_found', 'Status not found');
		const maxAncestors = auth == null ? 40 : 4096;
		const ancestors: Packed<'Note'>[] = [];
		const seen = new Set([noteId]);
		for (let offset = 0; offset < maxAncestors && root.replyId != null;) {
			const limit = Math.min(100, maxAncestors - offset);
			const page = await this.mastodonApiCallService.invokePublic('notes/conversation', { noteId, limit, offset }, auth, request) as Packed<'Note'>[];
			let unseen = false;
			for (const note of page) {
				if (seen.has(note.id)) continue;
				seen.add(note.id);
				unseen = true;
				if (!note.isHidden) ancestors.push(note);
			}
			offset += page.length;
			if (page.length < limit || !unseen) break;
		}
		const descendants = await collectMastodonReplies(noteId, async (parentIds, limit) => {
			const query = this.notesRepository.createQueryBuilder('note')
				.where('note.replyId IN (:...parentIds)', { parentIds })
				.innerJoinAndSelect('note.user', 'user')
				.leftJoinAndSelect('note.reply', 'reply')
				.leftJoinAndSelect('note.renote', 'renote')
				.leftJoinAndSelect('reply.user', 'replyUser')
				.leftJoinAndSelect('renote.user', 'renoteUser')
				.orderBy('note.id', 'ASC')
				.limit(limit);
			this.queryService.generateVisibilityQuery(query, auth?.user ?? null);
			this.queryService.generateBaseNoteFilteringQuery(query, auth?.user ?? null);
			return await this.noteEntityService.packMany(await query.getMany(), auth?.user ?? null);
		}, { count: auth == null ? 60 : 4096, depth: auth == null ? 20 : 4096 });
		return { ancestors: ancestors.reverse(), descendants };
	}

	/** Resolve only a complete account address; ordinary text must continue through search. */
	public async resolveAccount(query: string, auth: MastodonUserAuth, request: FastifyRequest): Promise<Packed<'UserDetailed'> | null> {
		const acct = this.accountAddress(query, true);
		if (acct == null) return null;
		try {
			return await this.mastodonApiCallService.invoke('users/show', {
				username: acct.username,
				...(acct.host == null ? {} : { host: acct.host }),
			}, auth, request) as Packed<'UserDetailed'>;
		} catch (error) {
			if (error instanceof ApiError && ['NO_SUCH_USER', 'FAILED_TO_RESOLVE_REMOTE_USER'].includes(error.code)) return null;
			throw error;
		}
	}

	/** Mastodon lookup never performs network discovery, including for a remote acct. */
	public async lookupAccount(rawAcct: string, auth: MastodonUserAuth | null, request: FastifyRequest): Promise<Packed<'UserDetailed'>> {
		const acct = this.accountAddress(rawAcct, false);
		if (acct == null) throw new MastodonApiError(404, 'not_found', 'Account not found');
		const user = await this.usersRepository.findOneBy({ usernameLower: acct.username.toLowerCase(), host: acct.host ?? IsNull() });
		if (user == null) throw new MastodonApiError(404, 'not_found', 'Account not found');
		return await this.mastodonApiCallService.invokePublic('users/show', { userId: user.id }, auth, request) as Packed<'UserDetailed'>;
	}

	private accountAddress(raw: string, requireHost: boolean): { username: string; host: string | null } | null {
		const parts = raw.trim().replace(/^acct:/iu, '').replace(/^@/u, '').split('@');
		if (parts.length > 2 || (requireHost && parts.length !== 2) || !/^[a-z0-9_.-]+$/iu.test(parts[0])) return null;
		if (parts.length === 1) return { username: parts[0], host: null };
		if (parts[1] === '' || /[\s/?#@\\]/u.test(parts[1])) return null;
		try {
			const hostUrl = new URL(`https://${parts[1]}`);
			if (hostUrl.username !== '' || hostUrl.password !== '' || hostUrl.hostname === '') return null;
			const host = hostUrl.host.toLowerCase();
			const localHosts = new Set([this.config.host, this.config.hostname, new URL(this.config.url).host].map(value => value.toLowerCase()));
			return { username: parts[0], host: localHosts.has(host) ? null : host };
		} catch {
			return null;
		}
	}
}
